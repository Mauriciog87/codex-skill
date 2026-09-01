import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { getExecutorProfile } from "./executor-profiles.mjs";
import {
  OrchestrationStateError,
  atomicCreate,
  atomicWrite,
  getEntry,
  getRepositoryState,
  readJson,
  readUltraLock,
  withStateMutex,
} from "./orchestration-state.mjs";

export const CONTROL_PLANE_VERSION = 1;
export const CONTROL_PLANE_RESULT_VERSION = 2;
export const ASSIGNMENT_PRIORITIES = Object.freeze(["high", "normal", "low"]);
export const DELIVERY_MODES = Object.freeze(["manual", "commit", "push"]);
export const ASSIGNMENT_STATES = Object.freeze([
  "queued",
  "running",
  "result_ready",
  "claimed",
  "review_pending",
  "approval_pending",
  "integration_pending",
  "integrated",
  "commit_pending",
  "committed",
  "push_pending",
  "published",
  "delivery_blocked",
  "acknowledged",
  "blocked",
  "failed",
  "recovery_required",
  "abandoned",
]);

const WRITER_STRATEGIES = new Set(["isolated-worktree"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_STATES = new Set(["acknowledged", "abandoned"]);
const RETRYABLE_STATES = new Set(["blocked", "failed", "recovery_required"]);
const ACTIVE_RESOURCE_STATES = new Set([
  "queued",
  "running",
  "result_ready",
  "claimed",
  "review_pending",
  "approval_pending",
  "integration_pending",
  "integrated",
  "commit_pending",
  "committed",
  "push_pending",
  "published",
  "delivery_blocked",
  "blocked",
  "failed",
  "recovery_required",
]);
const ACTION_AUTHORITIES = Object.freeze({
  start_assignment: ["root", "ultra", "daemon"],
  publish_result: ["executor", "daemon"],
  claim_result: ["root", "ultra"],
  request_review: ["root", "ultra"],
  publish_review: ["reviewer"],
  approve_candidate: ["root", "ultra", "operator"],
  integrate_candidate: ["root", "ultra"],
  record_commit: ["root", "ultra"],
  record_push: ["root", "ultra"],
  block_delivery: ["root", "ultra"],
  retry_delivery: ["root", "ultra", "operator"],
  acknowledge_assignment: ["root", "ultra"],
  answer_request: ["operator"],
  acknowledge_answer: ["root", "ultra", "executor", "daemon"],
  retry_assignment: ["root", "ultra"],
  abandon_assignment: ["root", "ultra"],
  mark_recovery_required: ["root", "ultra", "daemon"],
  archive_workspace: ["root", "ultra", "daemon"],
  cleanup_workspace: ["root", "ultra", "daemon"],
});

export class ControlPlaneError extends Error {
  constructor(message, code = "control-plane-error", details = {}) {
    super(message);
    this.name = "ControlPlaneError";
    this.code = code;
    this.details = details;
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ControlPlaneError(`${label} must be a non-empty string.`, "invalid-contract");
  }
  return value.trim();
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new ControlPlaneError(`${label} must be a boolean.`, "invalid-contract");
  }
  return value;
}

function requireGitRevision(value, label) {
  const revision = requireString(value, label);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(revision)) {
    throw new ControlPlaneError(`${label} must be a full Git object id.`, "invalid-contract");
  }
  return revision.toLowerCase();
}

function rejectUnexpectedProperties(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new ControlPlaneError(`${label} contains unexpected properties: ${unexpected.join(", ")}.`, "invalid-contract");
  }
}

function normalizeForComparison(value, platform = process.platform) {
  const normalized = value === "." ? "." : value.replace(/\\/g, "/").replace(/^\.\//, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function normalizeRepositoryPath(value) {
  const input = requireString(value, "Repository path").replace(/\\/g, "/");
  if (input === ".") {
    return ".";
  }
  if (isAbsolute(input) || /^[A-Za-z]:\//.test(input) || input.startsWith("/")) {
    throw new ControlPlaneError(`Repository path must be relative: ${value}`, "invalid-path");
  }
  const normalized = posix.normalize(input).replace(/^\.\//, "").replace(/\/$/, "");
  if (normalized.length === 0 || normalized === ".." || normalized.startsWith("../")) {
    throw new ControlPlaneError(`Repository path escapes the repository: ${value}`, "invalid-path");
  }
  return normalized;
}

function normalizeRoots(values, label) {
  if (!Array.isArray(values)) {
    throw new ControlPlaneError(`${label} must be an array.`, "invalid-contract");
  }
  return [...new Set(values.map(normalizeRepositoryPath))].sort();
}

export function rootsOverlap(first, second, platform = process.platform) {
  const left = normalizeForComparison(normalizeRepositoryPath(first), platform);
  const right = normalizeForComparison(normalizeRepositoryPath(second), platform);
  if (left === "." || right === ".") {
    return true;
  }
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function pathWithinRoots(path, allowedRoots, forbiddenRoots = [], platform = process.platform) {
  const normalizedPath = normalizeForComparison(normalizeRepositoryPath(path), platform);
  const contains = (root) => {
    const normalizedRoot = normalizeForComparison(root, platform);
    return normalizedRoot === "." || normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
  };
  return allowedRoots.some(contains) && !forbiddenRoots.some(contains);
}

function validateCheck(value, index) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ControlPlaneError(`required_checks[${index}] must be an object.`, "invalid-contract");
  }
  rejectUnexpectedProperties(value, new Set(["id", "argv", "cwd", "timeout_seconds"]), `required_checks[${index}]`);
  const id = requireString(value.id, `required_checks[${index}].id`);
  if (!Array.isArray(value.argv) || value.argv.length === 0 || value.argv.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new ControlPlaneError(`required_checks[${index}].argv must contain command arguments.`, "invalid-contract");
  }
  const timeoutSeconds = value.timeout_seconds ?? 900;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) {
    throw new ControlPlaneError(`required_checks[${index}].timeout_seconds is invalid.`, "invalid-contract");
  }
  return {
    id,
    argv: [...value.argv],
    cwd: normalizeRepositoryPath(value.cwd ?? "."),
    timeout_seconds: timeoutSeconds,
  };
}

function validateArtifact(value, index) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ControlPlaneError(`artifacts[${index}] must be an object.`, "invalid-contract");
  }
  rejectUnexpectedProperties(value, new Set(["name", "path", "kind"]), `artifacts[${index}]`);
  const kind = value.kind ?? "file";
  if (!new Set(["file", "directory"]).has(kind)) {
    throw new ControlPlaneError(`artifacts[${index}].kind must be file or directory.`, "invalid-contract");
  }
  const name = requireString(value.name, `artifacts[${index}].name`);
  if (name === "." || name === ".." || /[\\/]/.test(name)) {
    throw new ControlPlaneError(`artifacts[${index}].name must be a file name.`, "invalid-contract");
  }
  return {
    name,
    path: normalizeRepositoryPath(value.path),
    kind,
  };
}

function validateDelivery(value, writer) {
  const input = value ?? { mode: "manual" };
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ControlPlaneError("delivery must be an object.", "invalid-contract");
  }
  rejectUnexpectedProperties(
    input,
    new Set(["mode", "commit_message", "remote", "branch"]),
    "delivery",
  );
  const mode = input.mode ?? "manual";
  if (!DELIVERY_MODES.includes(mode)) {
    throw new ControlPlaneError(`delivery.mode must be one of: ${DELIVERY_MODES.join(", ")}.`, "invalid-contract");
  }
  const commitMessage = input.commit_message ?? null;
  const remote = input.remote ?? null;
  const branch = input.branch ?? null;
  if (mode !== "manual" && !writer) {
    throw new ControlPlaneError("Only workspace-write assignments may publish commits.", "invalid-contract");
  }
  if (mode === "manual") {
    if (commitMessage !== null || remote !== null || branch !== null) {
      throw new ControlPlaneError("Manual delivery cannot declare commit or push settings.", "invalid-contract");
    }
  } else {
    const message = requireString(commitMessage, "delivery.commit_message");
    if (message.length > 200 || /[\u0000-\u001f\u007f]/.test(message)) {
      throw new ControlPlaneError("delivery.commit_message must be one line with at most 200 characters.", "invalid-contract");
    }
  }
  if (mode === "push") {
    const remoteName = requireString(remote, "delivery.remote");
    const branchName = requireString(branch, "delivery.branch");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(remoteName)) {
      throw new ControlPlaneError("delivery.remote must be a configured Git remote name.", "invalid-contract");
    }
    if (
      branchName.length > 240 ||
      branchName.startsWith("-") ||
      branchName.startsWith("/") ||
      branchName.endsWith("/") ||
      branchName.endsWith(".") ||
      branchName.endsWith(".lock") ||
      branchName === "@" ||
      branchName.includes("//") ||
      branchName.includes("..") ||
      branchName.includes("@{") ||
      branchName.split("/").some((component) => component.startsWith(".") || component.endsWith(".lock")) ||
      /[\u0000-\u0020~^:?*\\[\]\\]/.test(branchName)
    ) {
      throw new ControlPlaneError("delivery.branch is not a safe Git branch name.", "invalid-contract");
    }
  } else if (remote !== null || branch !== null) {
    throw new ControlPlaneError("Only push delivery may declare a remote and branch.", "invalid-contract");
  }
  return {
    mode,
    commit_message: mode === "manual" ? null : commitMessage.trim(),
    remote: mode === "push" ? remote.trim() : null,
    branch: mode === "push" ? branch.trim() : null,
  };
}

export function validateAssignmentRequest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ControlPlaneError("Assignment request must be an object.", "invalid-contract");
  }
  rejectUnexpectedProperties(
    value,
    new Set([
      "profile",
      "base_revision",
      "priority",
      "allowed_write_roots",
      "forbidden_write_roots",
      "required_checks",
      "artifacts",
      "review_policy",
      "operator_approval_required",
      "allow_symlinks",
      "allow_submodules",
      "delivery",
      "parent_assignment_id",
      "review_target_candidate_id",
      "lock_id",
      "generation",
    ]),
    "Assignment request",
  );
  const profile = getExecutorProfile(value.profile);
  if (profile === null) {
    throw new ControlPlaneError(`Unknown executor profile: ${value.profile}`, "invalid-contract");
  }
  const writer = WRITER_STRATEGIES.has(profile.workspaceStrategy);
  const allowedWriteRoots = normalizeRoots(value.allowed_write_roots ?? [], "allowed_write_roots");
  const forbiddenWriteRoots = normalizeRoots(value.forbidden_write_roots ?? [], "forbidden_write_roots");
  if (writer && allowedWriteRoots.length === 0) {
    throw new ControlPlaneError("Workspace-write assignments require at least one allowed_write_root.", "invalid-contract");
  }
  if (!writer && allowedWriteRoots.length > 0) {
    throw new ControlPlaneError(`${profile.name} cannot declare allowed_write_roots.`, "invalid-contract");
  }
  const priority = value.priority ?? "normal";
  if (!ASSIGNMENT_PRIORITIES.includes(priority)) {
    throw new ControlPlaneError(`priority must be one of: ${ASSIGNMENT_PRIORITIES.join(", ")}.`, "invalid-contract");
  }
  const reviewPolicy = value.review_policy ?? "root";
  if (!new Set(["root", "independent"]).has(reviewPolicy)) {
    throw new ControlPlaneError("review_policy must be root or independent.", "invalid-contract");
  }
  const requiredChecks = (value.required_checks ?? []).map(validateCheck);
  const artifacts = (value.artifacts ?? []).map(validateArtifact);
  if (new Set(requiredChecks.map((item) => item.id)).size !== requiredChecks.length) {
    throw new ControlPlaneError("required_checks ids must be unique.", "invalid-contract");
  }
  if (new Set(artifacts.map((item) => item.name)).size !== artifacts.length) {
    throw new ControlPlaneError("artifact names must be unique.", "invalid-contract");
  }
  if (!writer && artifacts.length > 0) {
    throw new ControlPlaneError(`${profile.name} cannot declare artifacts.`, "invalid-contract");
  }
  const delivery = validateDelivery(value.delivery, writer);
  for (const artifact of artifacts) {
    if (!pathWithinRoots(artifact.path, allowedWriteRoots, forbiddenWriteRoots)) {
      throw new ControlPlaneError(`Artifact is outside the assignment write scope: ${artifact.path}`, "invalid-contract");
    }
  }
  const parentAssignmentId = value.parent_assignment_id ?? null;
  if (parentAssignmentId !== null) {
    validateAssignmentId(parentAssignmentId);
  }
  const reviewTargetCandidateId = value.review_target_candidate_id ?? null;
  if (reviewTargetCandidateId !== null && !/^[0-9a-f]{64}$/i.test(reviewTargetCandidateId)) {
    throw new ControlPlaneError("review_target_candidate_id must be a SHA-256 digest.", "invalid-contract");
  }
  return {
    profile: profile.name,
    writer,
    workspace_strategy: profile.workspaceStrategy,
    capabilities: [...profile.capabilities],
    base_revision: requireGitRevision(value.base_revision, "base_revision"),
    priority,
    allowed_write_roots: allowedWriteRoots,
    forbidden_write_roots: forbiddenWriteRoots,
    required_checks: requiredChecks,
    artifacts,
    review_policy: reviewPolicy,
    operator_approval_required: requireBoolean(
      value.operator_approval_required ?? false,
      "operator_approval_required",
    ),
    allow_symlinks: requireBoolean(value.allow_symlinks ?? false, "allow_symlinks"),
    allow_submodules: requireBoolean(value.allow_submodules ?? false, "allow_submodules"),
    delivery,
    parent_assignment_id: parentAssignmentId,
    review_target_candidate_id: reviewTargetCandidateId?.toLowerCase() ?? null,
  };
}

function assignmentDirectory(state, assignmentId) {
  return join(state.assignmentsDirectory, assignmentId);
}

function assignmentPaths(state, assignmentId) {
  const directory = assignmentDirectory(state, assignmentId);
  return {
    directory,
    record: join(directory, "record.json"),
    payload: join(directory, "payload.json"),
    events: join(directory, "events"),
  };
}

function validateAssignmentId(value) {
  const id = requireString(value, "assignment_id");
  if (!UUID_PATTERN.test(id)) {
    throw new ControlPlaneError("assignment_id must be a UUID.", "invalid-assignment-id");
  }
  return id.toLowerCase();
}

function normalizePersistedDelivery(record) {
  const source = record.delivery ?? {};
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new ControlPlaneError(`Assignment ${record.assignment_id} delivery state is malformed.`, "invalid-state");
  }
  const config = validateDelivery(
    {
      mode: source.mode ?? "manual",
      commit_message: source.commit_message ?? null,
      remote: source.remote ?? null,
      branch: source.branch ?? null,
    },
    record.writer,
  );
  for (const property of ["commit", "push", "last_error"]) {
    if (source[property] !== undefined && source[property] !== null && typeof source[property] !== "object") {
      throw new ControlPlaneError(`Assignment ${record.assignment_id} delivery ${property} is malformed.`, "invalid-state");
    }
  }
  return {
    ...config,
    commit: source.commit ?? null,
    push: source.push ?? null,
    last_error: source.last_error ?? null,
  };
}

function validateRecord(record, assignmentId) {
  if (record?.schema_version !== CONTROL_PLANE_VERSION || record.assignment_id !== assignmentId) {
    throw new ControlPlaneError(`Assignment ${assignmentId} has an unsupported state format.`, "invalid-state");
  }
  if (!ASSIGNMENT_STATES.includes(record.state) || !Number.isInteger(record.state_revision)) {
    throw new ControlPlaneError(`Assignment ${assignmentId} state is malformed.`, "invalid-state");
  }
  return { ...record, delivery: normalizePersistedDelivery(record) };
}

export async function readAssignment(cwd, assignmentId, options = {}) {
  const id = validateAssignmentId(assignmentId);
  const state = await getRepositoryState(cwd, options);
  const paths = assignmentPaths(state, id);
  if ((await getEntry(paths.record)) === null) {
    throw new ControlPlaneError(`Assignment not found: ${id}`, "assignment-not-found");
  }
  return validateRecord(await readJson(paths.record, `Assignment ${id}`), id);
}

export async function readAssignmentBriefing(cwd, assignmentId, options = {}) {
  const id = validateAssignmentId(assignmentId);
  const state = await getRepositoryState(cwd, options);
  const payload = await readJson(assignmentPaths(state, id).payload, `Assignment ${id} payload`);
  return requireString(payload.briefing, "Assignment briefing");
}

export async function listAssignments(cwd, options = {}) {
  const state = await getRepositoryState(cwd, options);
  if ((await getEntry(state.assignmentsDirectory)) === null) {
    return [];
  }
  const entries = await readdir(state.assignmentsDirectory, { withFileTypes: true });
  const records = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!UUID_PATTERN.test(entry.name)) {
      continue;
    }
    records.push(await readAssignment(state.repository, entry.name, options));
  }
  return records;
}

function assignmentPriority(record) {
  return ASSIGNMENT_PRIORITIES.indexOf(record.priority);
}

function sortAssignments(records) {
  return [...records].sort((left, right) => {
    const priority = assignmentPriority(left) - assignmentPriority(right);
    if (priority !== 0) {
      return priority;
    }
    const created = left.created_at.localeCompare(right.created_at);
    return created !== 0 ? created : left.assignment_id.localeCompare(right.assignment_id);
  });
}

function recordsOverlap(left, right, platform = process.platform) {
  return left.allowed_write_roots.some((first) =>
    right.allowed_write_roots.some((second) => rootsOverlap(first, second, platform))
  );
}

function hasActiveOverlap(record, records, platform = process.platform) {
  if (!record.writer) {
    return false;
  }
  return records.some(
    (candidate) =>
      candidate.assignment_id !== record.assignment_id &&
      candidate.writer &&
      candidate.resource_lease_active === true &&
      ACTIVE_RESOURCE_STATES.has(candidate.state) &&
      recordsOverlap(record, candidate, platform),
  );
}

export async function createAssignment({
  cwd,
  request,
  briefing,
  environment = process.env,
  homeDirectory,
  platform = process.platform,
  now = () => new Date(),
  idGenerator = randomUUID,
}) {
  const contract = validateAssignmentRequest(request);
  const normalizedBriefing = requireString(briefing, "briefing");
  const state = await getRepositoryState(cwd, { environment, homeDirectory, platform });
  const assignmentId = validateAssignmentId(idGenerator());
  const paths = assignmentPaths(state, assignmentId);
  const timestamp = now().toISOString();
  const requestedLockId = request.lock_id ?? null;
  const lockId = requestedLockId === null ? null : validateAssignmentId(requestedLockId);
  const generation = request.generation ?? null;
  if ((lockId === null) !== (generation === null)) {
    throw new ControlPlaneError("lock_id and generation must be provided together.", "invalid-contract");
  }
  if (lockId !== null) {
    if (!Number.isInteger(generation) || generation < 1) {
      throw new ControlPlaneError("generation must be a positive integer.", "invalid-contract");
    }
  }
  const record = {
    schema_version: CONTROL_PLANE_VERSION,
    assignment_id: assignmentId,
    state_revision: 0,
    state: "queued",
    attempt: 1,
    repository: state.repository,
    repository_key: state.key,
    profile: contract.profile,
    writer: contract.writer,
    workspace_strategy: contract.workspace_strategy,
    capabilities: contract.capabilities,
    base_revision: contract.base_revision,
    priority: contract.priority,
    briefing_sha256: sha256(normalizedBriefing),
    payload_path: paths.payload,
    allowed_write_roots: contract.allowed_write_roots,
    forbidden_write_roots: contract.forbidden_write_roots,
    required_checks: contract.required_checks,
    artifacts: contract.artifacts,
    review_policy: contract.review_policy,
    operator_approval_required: contract.operator_approval_required,
    allow_symlinks: contract.allow_symlinks,
    allow_submodules: contract.allow_submodules,
    delivery: {
      ...contract.delivery,
      commit: null,
      push: null,
      last_error: null,
    },
    parent_assignment_id: contract.parent_assignment_id,
    review_target_candidate_id: contract.review_target_candidate_id,
    lock_id: lockId,
    generation,
    result: null,
    candidate: null,
    review: null,
    approval: null,
    integration: null,
    operator_requests: [],
    workspace: null,
    resource_lease_active: false,
    previous_attempts: [],
    last_action_id: null,
    last_action_sha256: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  return withStateMutex(state, async () => {
    const lock = await readUltraLock(state.repository, { environment, homeDirectory, platform });
    if (lockId === null && lock !== null) {
      throw new ControlPlaneError("Repository has an active or recovery-required Ultra takeover.", "repository-locked");
    }
    if (lockId !== null) {
      if (
        lock === null ||
        lock.version !== 2 ||
        lock.state !== "active" ||
        lock.lock_id !== lockId ||
        lock.generation !== generation
      ) {
        throw new ControlPlaneError("Assignment Ultra ownership is stale or inactive.", "stale-epoch");
      }
    }
    if ((await getEntry(paths.directory)) !== null) {
      throw new ControlPlaneError(`Assignment already exists: ${assignmentId}`, "assignment-exists");
    }
    await mkdir(paths.events, { recursive: true });
    try {
      await atomicCreate(paths.payload, {
        schema_version: CONTROL_PLANE_VERSION,
        assignment_id: assignmentId,
        briefing: normalizedBriefing,
      });
      try {
        await chmod(paths.payload, 0o600);
      } catch (error) {
        if (platform !== "win32") {
          throw error;
        }
      }
      await atomicCreate(paths.record, record);
      await atomicCreate(join(paths.events, "000000-assignment-enqueued.json"), {
        schema_version: CONTROL_PLANE_VERSION,
        event: "assignment-enqueued",
        assignment_id: assignmentId,
        state_revision: 0,
        created_at: timestamp,
      });
      return record;
    } catch (error) {
      await rm(paths.directory, { recursive: true, force: true });
      throw error;
    }
  });
}

function requireState(record, allowed, operation) {
  if (!allowed.includes(record.state)) {
    throw new ControlPlaneError(
      `${operation} cannot run while assignment is ${record.state}.`,
      "invalid-transition",
      { state: record.state },
    );
  }
}

function requireCandidate(record, candidateId) {
  if (record.candidate === null || record.candidate.candidate_id !== candidateId) {
    throw new ControlPlaneError("Action does not target the current candidate.", "stale-candidate");
  }
}

function finalizeTransition(record, action, timestamp, actionDigest) {
  return {
    ...record,
    state_revision: record.state_revision + 1,
    last_action_id: action.action_id,
    last_action_sha256: actionDigest,
    updated_at: timestamp,
  };
}

function validateAction(record, action) {
  if (action === null || typeof action !== "object" || Array.isArray(action)) {
    throw new ControlPlaneError("Control action must be an object.", "invalid-action");
  }
  const actionId = validateAssignmentId(action.action_id);
  const operation = requireString(action.op, "op");
  const authority = requireString(action.authority, "authority");
  if (!Object.hasOwn(ACTION_AUTHORITIES, operation)) {
    throw new ControlPlaneError(`Unknown control operation: ${operation}`, "invalid-action");
  }
  if (!ACTION_AUTHORITIES[operation].includes(authority)) {
    throw new ControlPlaneError(`${authority} cannot perform ${operation}.`, "unauthorized-action");
  }
  if (validateAssignmentId(action.assignment_id) !== record.assignment_id) {
    throw new ControlPlaneError("Action assignment_id does not match the record.", "invalid-action");
  }
  if (!Number.isInteger(action.expected_state_revision) || action.expected_state_revision !== record.state_revision) {
    throw new ControlPlaneError(
      `Expected state revision ${record.state_revision}, received ${action.expected_state_revision}.`,
      "stale-state-revision",
    );
  }
  return {
    action_id: actionId,
    op: operation,
    authority,
    assignment_id: record.assignment_id,
    expected_state_revision: action.expected_state_revision,
    payload: action.payload ?? {},
  };
}

export function reduceAssignment(record, inputAction, timestamp = new Date().toISOString()) {
  const action = validateAction(record, inputAction);
  const actionDigest = sha256(canonicalJson(action));
  const next = structuredClone(record);
  const payload = action.payload;

  if (action.op === "start_assignment") {
    requireState(record, ["queued"], action.op);
    next.state = "running";
    next.workspace = payload.workspace ?? record.workspace;
    next.resource_lease_active = record.writer;
    next.started_at = timestamp;
  } else if (action.op === "publish_result") {
    requireState(record, ["running"], action.op);
    if (payload.result === null || typeof payload.result !== "object" || Array.isArray(payload.result)) {
      throw new ControlPlaneError("publish_result requires a structured result.", "invalid-action");
    }
    if (!new Set(["completed", "blocked", "failed"]).has(payload.result.status)) {
      throw new ControlPlaneError("Published result status is invalid.", "invalid-action");
    }
    if (!Array.isArray(payload.result.changed_files) || payload.result.changed_files.some((path) => typeof path !== "string")) {
      throw new ControlPlaneError("Published result changed_files is invalid.", "invalid-action");
    }
    const publishedCandidate = payload.candidate ?? null;
    if (publishedCandidate !== null) {
      if (payload.result.status !== "completed" || !record.writer) {
        throw new ControlPlaneError("Only completed writer results may publish a candidate.", "invalid-action");
      }
      if (
        publishedCandidate.base_revision !== record.base_revision ||
        !/^[0-9a-f]{64}$/i.test(publishedCandidate.candidate_id ?? "") ||
        !Array.isArray(publishedCandidate.changed_paths)
      ) {
        throw new ControlPlaneError("Published candidate identity is invalid.", "invalid-action");
      }
      const reportedPaths = [...new Set(payload.result.changed_files.map(normalizeRepositoryPath))].sort();
      const candidatePaths = [...new Set(publishedCandidate.changed_paths.map(normalizeRepositoryPath))].sort();
      if (canonicalJson(reportedPaths) !== canonicalJson(candidatePaths)) {
        throw new ControlPlaneError("Published candidate paths do not match changed_files.", "invalid-action");
      }
    } else if (payload.result.status === "completed" && payload.result.changed_files.length > 0) {
      throw new ControlPlaneError("Completed changes require a published candidate.", "invalid-action");
    }
    const operatorRequests = payload.operator_requests ?? [];
    if (!Array.isArray(operatorRequests)) {
      throw new ControlPlaneError("operator_requests must be an array.", "invalid-action");
    }
    if (operatorRequests.length > 0 && payload.result.status !== "blocked") {
      throw new ControlPlaneError("operator_requests require a blocked result.", "invalid-action");
    }
    const requestIds = new Set();
    const operatorRequestProperties = new Set([
      "request_id",
      "question",
      "choices",
      "source",
      "sensitive",
      "assignment_id",
      "attempt",
      "ordinal",
    ]);
    next.operator_requests = operatorRequests.map((request) => {
      if (
        request === null ||
        typeof request !== "object" ||
        typeof request.request_id !== "string" ||
        request.request_id.length === 0 ||
        requestIds.has(request.request_id) ||
        typeof request.question !== "string" ||
        request.question.trim().length === 0 ||
        !Array.isArray(request.choices) ||
        request.choices.some((choice) => typeof choice !== "string")
      ) {
        throw new ControlPlaneError("operator_requests contains an invalid request.", "invalid-action");
      }
      const source = request.source ?? "executor";
      if (
        !["executor", "app_server_user_input"].includes(source) ||
        (request.sensitive !== undefined && typeof request.sensitive !== "boolean")
      ) {
        throw new ControlPlaneError("operator_requests contains invalid metadata.", "invalid-action");
      }
      const unexpected = Object.keys(request).filter(
        (key) => !operatorRequestProperties.has(key),
      );
      if (unexpected.length > 0) {
        throw new ControlPlaneError("operator_requests contains unexpected properties.", "invalid-action");
      }
      requestIds.add(request.request_id);
      return {
        ...request,
        source,
        sensitive: request.sensitive === true,
        state: "open",
        answer: null,
      };
    });
    next.result = payload.result;
    next.candidate = publishedCandidate;
    next.state = payload.result.status === "completed" ? "result_ready" : payload.result.status;
    next.finished_at = timestamp;
  } else if (action.op === "claim_result") {
    requireState(record, ["result_ready"], action.op);
    next.state = "claimed";
    next.claimed_by = action.authority;
    next.claimed_at = timestamp;
  } else if (action.op === "request_review") {
    requireState(record, ["claimed"], action.op);
    if (record.review_policy !== "independent" || record.candidate === null) {
      throw new ControlPlaneError("Assignment does not require an independent candidate review.", "invalid-transition");
    }
    requireCandidate(record, payload.candidate_id);
    next.state = "review_pending";
  } else if (action.op === "publish_review") {
    requireState(record, ["review_pending"], action.op);
    requireCandidate(record, payload.candidate_id);
    if (!new Set(["APPROVE", "COMMENT", "REQUEST_CHANGES"]).has(payload.verdict)) {
      throw new ControlPlaneError("Review verdict is invalid.", "invalid-action");
    }
    next.review = {
      ...payload,
      reviewed_candidate_id: record.candidate.candidate_id,
      reviewed_candidate_revision: record.candidate.candidate_revision,
      created_at: timestamp,
    };
    next.state = payload.verdict === "REQUEST_CHANGES" ? "blocked" : "approval_pending";
  } else if (action.op === "approve_candidate") {
    requireState(record, ["claimed", "approval_pending"], action.op);
    requireCandidate(record, payload.candidate_id);
    const kind = payload.kind;
    if (kind === "root" && !new Set(["root", "ultra"]).has(action.authority)) {
      throw new ControlPlaneError("Root approval requires root or Ultra authority.", "unauthorized-action");
    }
    if (kind === "operator" && action.authority !== "operator") {
      throw new ControlPlaneError("Operator approval requires operator authority.", "unauthorized-action");
    }
    if (!new Set(["root", "operator"]).has(kind)) {
      throw new ControlPlaneError("Approval kind must be root or operator.", "invalid-action");
    }
    if (record.review_policy === "independent" && record.review === null) {
      throw new ControlPlaneError("Independent review must complete before approval.", "invalid-transition");
    }
    if (kind === "operator" && !record.operator_approval_required) {
      throw new ControlPlaneError("Assignment does not require operator approval.", "invalid-transition");
    }
    const approval = record.approval ?? {
      candidate_id: record.candidate.candidate_id,
      root_approved: false,
      operator_approved: false,
      root_action_id: null,
      operator_action_id: null,
    };
    approval[`${kind}_approved`] = true;
    approval[`${kind}_action_id`] = action.action_id;
    next.approval = approval;
    next.state = approval.root_approved && (!record.operator_approval_required || approval.operator_approved)
      ? "integration_pending"
      : "approval_pending";
  } else if (action.op === "integrate_candidate") {
    requireState(record, ["integration_pending"], action.op);
    requireCandidate(record, payload.candidate_id);
    next.integration = {
      candidate_id: record.candidate.candidate_id,
      target_revision_before: requireGitRevision(payload.target_revision_before, "target_revision_before"),
      applied_diff_sha256: requireString(payload.applied_diff_sha256, "applied_diff_sha256"),
      integrated_at: timestamp,
    };
    next.state = record.delivery.mode === "manual" ? "integrated" : "commit_pending";
  } else if (action.op === "record_commit") {
    requireState(record, ["commit_pending"], action.op);
    requireCandidate(record, payload.candidate_id);
    const publicationRef = requireString(payload.publication_ref, "publication_ref");
    const expectedPublicationRef = `refs/codex-orchestration/deliveries/${record.assignment_id}/${record.attempt}`;
    if (publicationRef !== expectedPublicationRef) {
      throw new ControlPlaneError("Commit publication ref does not match the assignment.", "invalid-action");
    }
    const branchRef = requireString(payload.branch_ref, "branch_ref");
    if (!branchRef.startsWith("refs/heads/")) {
      throw new ControlPlaneError("Commit branch_ref must identify a local branch.", "invalid-action");
    }
    next.delivery.commit = {
      candidate_id: record.candidate.candidate_id,
      commit_revision: requireGitRevision(payload.commit_revision, "commit_revision"),
      parent_revision: requireGitRevision(payload.parent_revision, "parent_revision"),
      branch_ref: branchRef,
      publication_ref: publicationRef,
      committed_at: timestamp,
    };
    next.delivery.last_error = null;
    next.state = record.delivery.mode === "push" ? "push_pending" : "committed";
  } else if (action.op === "record_push") {
    requireState(record, ["push_pending"], action.op);
    requireCandidate(record, payload.candidate_id);
    if (record.delivery.mode !== "push" || record.delivery.commit === null) {
      throw new ControlPlaneError("Assignment does not have a committed push delivery.", "invalid-transition");
    }
    const commitRevision = requireGitRevision(payload.commit_revision, "commit_revision");
    if (commitRevision !== record.delivery.commit.commit_revision) {
      throw new ControlPlaneError("Push commit does not match the recorded delivery commit.", "stale-candidate");
    }
    const remote = requireString(payload.remote, "remote");
    const branch = requireString(payload.branch, "branch");
    const remoteRef = requireString(payload.remote_ref, "remote_ref");
    if (
      remote !== record.delivery.remote ||
      branch !== record.delivery.branch ||
      remoteRef !== `refs/heads/${record.delivery.branch}`
    ) {
      throw new ControlPlaneError("Push destination does not match the assignment delivery contract.", "invalid-action");
    }
    next.delivery.push = {
      candidate_id: record.candidate.candidate_id,
      commit_revision: commitRevision,
      remote,
      branch,
      remote_ref: remoteRef,
      remote_revision_before: requireGitRevision(payload.remote_revision_before, "remote_revision_before"),
      remote_revision_after: requireGitRevision(payload.remote_revision_after, "remote_revision_after"),
      pushed_at: timestamp,
    };
    next.delivery.last_error = null;
    next.state = "published";
  } else if (action.op === "block_delivery") {
    requireState(record, ["commit_pending", "push_pending"], action.op);
    const phase = payload.phase;
    const expectedPhase = record.state === "commit_pending" ? "commit" : "push";
    if (phase !== expectedPhase) {
      throw new ControlPlaneError("Delivery failure phase does not match the current state.", "invalid-action");
    }
    next.delivery.last_error = {
      phase,
      error_code: requireString(payload.error_code, "error_code"),
      summary: requireString(payload.summary, "summary"),
      failed_at: timestamp,
    };
    next.state = "delivery_blocked";
  } else if (action.op === "retry_delivery") {
    requireState(record, ["delivery_blocked"], action.op);
    if (!new Set(["commit", "push"]).has(record.delivery.last_error?.phase)) {
      throw new ControlPlaneError("Assignment does not contain a retryable delivery failure.", "invalid-transition");
    }
    next.state = record.delivery.last_error.phase === "commit" ? "commit_pending" : "push_pending";
    next.delivery.last_error = null;
  } else if (action.op === "acknowledge_assignment") {
    const zeroChangeClaim = record.state === "claimed" && record.candidate === null;
    if (!zeroChangeClaim) {
      const completedState = {
        manual: "integrated",
        commit: "committed",
        push: "published",
      }[record.delivery.mode];
      requireState(record, [completedState], action.op);
    }
    next.state = "acknowledged";
    next.resource_lease_active = false;
    next.acknowledged_at = timestamp;
  } else if (action.op === "answer_request") {
    requireState(record, ["blocked"], action.op);
    const request = next.operator_requests.find((item) => item.request_id === payload.request_id);
    if (request === undefined || request.state !== "open") {
      throw new ControlPlaneError("Operator request is missing or already answered.", "invalid-transition");
    }
    request.answer = requireString(payload.answer, "answer");
    request.state = "answered";
    request.answered_at = timestamp;
  } else if (action.op === "acknowledge_answer") {
    const request = next.operator_requests.find((item) => item.request_id === payload.request_id);
    if (request === undefined || request.state !== "answered") {
      throw new ControlPlaneError("Operator answer is missing or not ready.", "invalid-transition");
    }
    request.state = "acknowledged";
    request.acknowledged_at = timestamp;
  } else if (action.op === "retry_assignment") {
    requireState(record, [...RETRYABLE_STATES], action.op);
    if (record.operator_requests.some((request) => request.state !== "acknowledged")) {
      throw new ControlPlaneError("Every operator request must be acknowledged before retry.", "invalid-transition");
    }
    if (
      record.writer &&
      record.workspace?.path !== null &&
      record.workspace?.path !== undefined &&
      record.workspace.archived !== true &&
      record.workspace.cleaned !== true
    ) {
      throw new ControlPlaneError("Writer workspace must be archived or cleaned before retry.", "invalid-transition");
    }
    next.previous_attempts = [
      ...record.previous_attempts,
      {
        attempt: record.attempt,
        state: record.state,
        result: record.result,
        candidate: record.candidate,
        workspace: record.workspace,
        operator_requests: structuredClone(record.operator_requests),
        finished_at: timestamp,
      },
    ];
    next.attempt = record.attempt + 1;
    next.base_revision = payload.base_revision === undefined
      ? record.base_revision
      : requireGitRevision(payload.base_revision, "base_revision");
    next.state = "queued";
    next.result = null;
    next.candidate = null;
    next.review = null;
    next.approval = null;
    next.integration = null;
    next.delivery = {
      ...record.delivery,
      commit: null,
      push: null,
      last_error: null,
    };
    next.operator_requests = [];
    next.workspace = null;
    next.resource_lease_active = record.writer;
  } else if (action.op === "abandon_assignment") {
    if (TERMINAL_STATES.has(record.state)) {
      throw new ControlPlaneError(`Cannot abandon assignment in ${record.state}.`, "invalid-transition");
    }
    next.state = "abandoned";
    next.resource_lease_active = false;
    next.abandoned_reason = requireString(payload.reason, "reason");
    next.abandoned_at = timestamp;
  } else if (action.op === "mark_recovery_required") {
    requireState(record, ["running"], action.op);
    next.state = "recovery_required";
    next.recovery_reason = requireString(payload.reason, "reason");
    next.recovery_required_at = timestamp;
  } else if (action.op === "archive_workspace") {
    if (record.workspace === null) {
      throw new ControlPlaneError("Assignment does not have a workspace.", "invalid-transition");
    }
    next.workspace = {
      ...record.workspace,
      archived: true,
      archive_path: requireString(payload.archive_path, "archive_path"),
      archived_at: timestamp,
    };
  } else if (action.op === "cleanup_workspace") {
    requireState(record, ["acknowledged", "abandoned"], action.op);
    if (record.workspace === null) {
      throw new ControlPlaneError("Assignment does not have a workspace.", "invalid-transition");
    }
    next.workspace = {
      ...record.workspace,
      cleaned: true,
      cleaned_path: requireString(payload.cleaned_path, "cleaned_path"),
      cleaned_at: timestamp,
    };
  }

  return finalizeTransition(next, action, timestamp, actionDigest);
}

function redactedActionEvent(
  action,
  actionDigest,
  requestDigest,
  status,
  beforeRevision,
  afterRevision,
  timestamp,
) {
  return {
    schema_version: CONTROL_PLANE_VERSION,
    action_id: action.action_id,
    action_sha256: actionDigest,
    request_sha256: requestDigest,
    assignment_id: action.assignment_id,
    op: action.op,
    authority: action.authority,
    status,
    before_revision: beforeRevision,
    after_revision: afterRevision,
    created_at: timestamp,
  };
}

export async function dispatchAssignmentAction(cwd, inputAction, options = {}) {
  const assignmentId = validateAssignmentId(inputAction.assignment_id);
  const state = await getRepositoryState(cwd, options);
  const paths = assignmentPaths(state, assignmentId);
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  return withStateMutex(state, async () => {
    const record = validateRecord(await readJson(paths.record, `Assignment ${assignmentId}`), assignmentId);
    const normalizedRequest = validateAction(
      { ...record, state_revision: inputAction.expected_state_revision },
      inputAction,
    );
    const requestDigest = sha256(canonicalJson(normalizedRequest));
    const eventPath = join(paths.events, `${normalizedRequest.action_id}.json`);
    if ((await getEntry(eventPath)) !== null) {
      const event = await readJson(eventPath, `Assignment action ${normalizedRequest.action_id}`);
      if ((event.request_sha256 ?? event.action_sha256) !== requestDigest) {
        throw new ControlPlaneError("action_id was reused with different content.", "action-id-reuse");
      }
      const current = validateRecord(await readJson(paths.record, `Assignment ${assignmentId}`), assignmentId);
      if (event.status === "applied" || current.last_action_id === normalizedRequest.action_id) {
        if (event.status !== "applied") {
          await atomicWrite(
            eventPath,
            redactedActionEvent(
              normalizedRequest,
              event.action_sha256,
              requestDigest,
              "applied",
              event.before_revision,
              current.state_revision,
              event.created_at,
            ),
          );
        }
        return { record: current, idempotent: true };
      }
    }
    const requestedAction = validateAction(record, inputAction);
    if (record.lock_id !== null || record.generation !== null) {
      const lock = await readUltraLock(state.repository, options);
      if (
        lock === null ||
        lock.version !== 2 ||
        lock.lock_id !== record.lock_id ||
        lock.generation !== record.generation
      ) {
        throw new ControlPlaneError("Assignment action belongs to a stale Ultra epoch.", "stale-epoch");
      }
      if (
        lock.state === "recovery-required" &&
        !new Set(["abandon_assignment", "archive_workspace", "cleanup_workspace"]).has(requestedAction.op)
      ) {
        throw new ControlPlaneError("Ultra epoch requires recovery before this action.", "recovery-required");
      }
    }
    if (requestedAction.op === "start_assignment") {
      const records = await listAssignments(state.repository, options);
      if (hasActiveOverlap(record, records, options.platform ?? process.platform)) {
        throw new ControlPlaneError("Assignment write roots overlap an active resource lease.", "resource-capacity");
      }
    }
    let action = requestedAction;
    let actionDigest = requestDigest;
    let prepared = redactedActionEvent(
      action,
      actionDigest,
      requestDigest,
      "prepared",
      record.state_revision,
      record.state_revision + 1,
      timestamp,
    );
    if ((await getEntry(eventPath)) === null) {
      await atomicCreate(eventPath, prepared);
    }
    if (typeof options.beforeTransition === "function") {
      const effectPayload = await options.beforeTransition(record, requestedAction);
      action = {
        ...requestedAction,
        payload: { ...requestedAction.payload, ...(effectPayload ?? {}) },
      };
      actionDigest = sha256(canonicalJson(action));
    }
    const next = reduceAssignment(record, action, timestamp);
    prepared = redactedActionEvent(
      action,
      actionDigest,
      requestDigest,
      "prepared",
      record.state_revision,
      next.state_revision,
      timestamp,
    );
    await atomicWrite(eventPath, prepared);
    await atomicWrite(paths.record, next);
    await atomicWrite(eventPath, { ...prepared, status: "applied" });
    return { record: next, idempotent: false };
  });
}

function attentionFor(record) {
  if (record.state === "result_ready") {
    return "claim-result";
  }
  if (record.state === "claimed") {
    if (record.candidate === null) {
      return "acknowledge-result";
    }
    return record.review_policy === "independent" ? "request-review" : "root-approval";
  }
  if (record.state === "review_pending") {
    return "review-candidate";
  }
  if (record.state === "approval_pending") {
    return record.approval?.root_approved === true ? "operator-approval" : "root-approval";
  }
  if (record.state === "integration_pending") {
    return "integrate-candidate";
  }
  if (record.state === "integrated") {
    return "acknowledge-integration";
  }
  if (record.state === "delivery_blocked") {
    return "delivery-blocked";
  }
  if (new Set(["blocked", "failed", "recovery_required"]).has(record.state)) {
    return record.operator_requests.some((request) => request.state === "open")
      ? "answer-request"
      : record.state.replaceAll("_", "-");
  }
  return null;
}

export function createReviewPublication(reviewRecord, parentRecord) {
  if (
    reviewRecord.profile !== "review" ||
    reviewRecord.parent_assignment_id !== parentRecord.assignment_id ||
    reviewRecord.review_target_candidate_id === null ||
    parentRecord.candidate?.candidate_id !== reviewRecord.review_target_candidate_id ||
    reviewRecord.result === null ||
    reviewRecord.result.routing_verified !== true ||
    reviewRecord.operator_requests.length > 0
  ) {
    throw new ControlPlaneError("Review assignment is not bound to a publishable candidate result.", "invalid-review");
  }
  const verdict = /^(APPROVE|COMMENT|REQUEST_CHANGES)(?=$|[\s:—–-])/.exec(reviewRecord.result.summary)?.[1];
  if (verdict === undefined) {
    throw new ControlPlaneError("Review result does not contain a valid verdict.", "invalid-review");
  }
  if (
    (verdict === "REQUEST_CHANGES" && (reviewRecord.state !== "blocked" || reviewRecord.result.blockers.length === 0)) ||
    (verdict !== "REQUEST_CHANGES" && reviewRecord.state !== "result_ready")
  ) {
    throw new ControlPlaneError("Review verdict and assignment state do not agree.", "invalid-review");
  }
  return {
    candidate_id: parentRecord.candidate.candidate_id,
    verdict,
    summary: reviewRecord.result.summary,
    blockers: reviewRecord.result.blockers,
    warnings: reviewRecord.result.warnings,
    checks: reviewRecord.result.checks,
    reviewer_assignment_id: reviewRecord.assignment_id,
    reviewer_thread_id: reviewRecord.result.thread_id,
    routing_verified: reviewRecord.result.routing_verified,
  };
}

function linkedReviewResidual(record, records) {
  if (record.profile !== "review" || record.parent_assignment_id === null) {
    return null;
  }
  const parent = records.find((candidate) => candidate.assignment_id === record.parent_assignment_id);
  if (parent === undefined) {
    return null;
  }
  if (
    parent.review?.reviewer_assignment_id === record.assignment_id &&
    ["result_ready", "claimed", "blocked"].includes(record.state)
  ) {
    return {
      op: "finalize_review_assignment",
      assignment_id: record.assignment_id,
      parent_assignment_id: parent.assignment_id,
      state_revision: record.state_revision,
    };
  }
  if (
    parent.state !== "review_pending" ||
    !["result_ready", "blocked"].includes(record.state) ||
    record.operator_requests.length > 0
  ) {
    return null;
  }
  createReviewPublication(record, parent);
  return {
    op: "publish_review_result",
    assignment_id: record.assignment_id,
    parent_assignment_id: parent.assignment_id,
    state_revision: record.state_revision,
  };
}

export function planResidualActions(records, platform = process.platform) {
  const ordered = sortAssignments(records);
  const active = ordered.filter(
    (record) => record.resource_lease_active === true && ACTIVE_RESOURCE_STATES.has(record.state),
  );
  const selected = [];
  const mechanical = [];
  const attention = [];
  for (const record of ordered) {
    const reviewResidual = linkedReviewResidual(record, records);
    if (reviewResidual !== null) {
      mechanical.push(reviewResidual);
    }
    if (record.state === "queued") {
      const conflicts = [...active, ...selected].some(
        (candidate) => candidate.assignment_id !== record.assignment_id && recordsOverlap(record, candidate, platform),
      );
      if (!record.writer || !conflicts) {
        mechanical.push({ op: "start_assignment", assignment_id: record.assignment_id, state_revision: record.state_revision });
        if (record.writer) {
          selected.push(record);
        }
      }
    }
    if (record.state === "commit_pending") {
      mechanical.push({ op: "commit_candidate", assignment_id: record.assignment_id, state_revision: record.state_revision });
    }
    if (record.state === "push_pending") {
      mechanical.push({ op: "push_candidate", assignment_id: record.assignment_id, state_revision: record.state_revision });
    }
    if (record.state === "committed" || record.state === "published") {
      mechanical.push({ op: "acknowledge_assignment", assignment_id: record.assignment_id, state_revision: record.state_revision });
    }
    if (TERMINAL_STATES.has(record.state) && record.workspace !== null && record.workspace.cleaned !== true) {
      mechanical.push({ op: "cleanup_workspace", assignment_id: record.assignment_id, state_revision: record.state_revision });
    }
    const kind = reviewResidual === null ? attentionFor(record) : null;
    if (kind !== null) {
      attention.push({
        kind,
        assignment_id: record.assignment_id,
        state: record.state,
        state_revision: record.state_revision,
        candidate_id: record.candidate?.candidate_id ?? null,
      });
    }
  }
  return { mechanical, attention };
}

function publicAssignment(record) {
  return {
    assignment_id: record.assignment_id,
    state: record.state,
    state_revision: record.state_revision,
    attempt: record.attempt,
    priority: record.priority,
    profile: record.profile,
    writer: record.writer,
    base_revision: record.base_revision,
    allowed_write_roots: [...record.allowed_write_roots],
    candidate_id: record.candidate?.candidate_id ?? null,
    candidate_revision: record.candidate?.candidate_revision ?? null,
    review_verdict: record.review?.verdict ?? null,
    root_approved: record.approval?.root_approved ?? false,
    operator_approved: record.approval?.operator_approved ?? false,
    delivery: {
      mode: record.delivery.mode,
      remote: record.delivery.remote,
      branch: record.delivery.branch,
      commit_revision: record.delivery.commit?.commit_revision ?? null,
      remote_revision: record.delivery.push?.remote_revision_after ?? null,
      last_error: record.delivery.last_error,
    },
    operator_requests: record.operator_requests.map((request) => ({
      request_id: request.request_id,
      question: request.question,
      choices: request.choices ?? [],
      state: request.state,
    })),
    workspace: record.workspace === null
      ? null
      : {
          path: record.workspace.path,
          archived: record.workspace.archived ?? false,
          cleaned: record.workspace.cleaned ?? false,
        },
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

export async function getControlPlaneStatus(cwd, options = {}) {
  const state = await getRepositoryState(cwd, options);
  const records = await listAssignments(state.repository, options);
  return {
    schema_version: CONTROL_PLANE_VERSION,
    status: "completed",
    repository: state.repository,
    repository_key: state.key,
    assignments: sortAssignments(records).map(publicAssignment),
    planner: planResidualActions(records, options.platform ?? process.platform),
  };
}

export async function findAssignmentByCandidate(cwd, candidateId, options = {}) {
  const id = requireString(candidateId, "candidate_id");
  const matches = (await listAssignments(cwd, options)).filter(
    (record) => record.candidate?.candidate_id === id,
  );
  if (matches.length !== 1) {
    throw new ControlPlaneError(
      matches.length === 0 ? `Candidate not found: ${id}` : `Candidate is ambiguous: ${id}`,
      "candidate-not-found",
    );
  }
  return matches[0];
}

export async function assertEpochAssignmentsComplete(cwd, lockId, generation, options = {}) {
  const unfinished = (await listAssignments(cwd, options)).filter(
    (record) =>
      record.lock_id === lockId &&
      record.generation === generation &&
      !TERMINAL_STATES.has(record.state),
  );
  if (unfinished.length > 0) {
    throw new OrchestrationStateError(
      `Cannot release Ultra takeover while ${unfinished.length} durable assignment(s) are unfinished.`,
      { lockId, generation },
    );
  }
}

export function createAction({ op, authority, record, payload = {}, actionId = randomUUID() }) {
  return {
    action_id: actionId,
    op,
    authority,
    assignment_id: record.assignment_id,
    expected_state_revision: record.state_revision,
    payload,
  };
}

export function resolveContainedPath(root, repositoryPath) {
  const normalized = normalizeRepositoryPath(repositoryPath);
  const candidate = resolve(root, normalized === "." ? "" : normalized);
  const relativePath = relative(resolve(root), candidate).replace(/\\/g, "/");
  if (relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath)) {
    throw new ControlPlaneError(`Path escapes workspace: ${repositoryPath}`, "invalid-path");
  }
  return candidate;
}
