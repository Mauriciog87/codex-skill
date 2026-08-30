import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  CONTROL_PLANE_RESULT_VERSION,
  CONTROL_PLANE_VERSION,
  ControlPlaneError,
  createAction,
  reduceAssignment,
  sha256,
  validateAssignmentRequest,
} from "./control-plane.mjs";

const DEFAULT_ITERATIONS = 250;
const DEFAULT_SEED = 20_260_830;
const MAX_ITERATIONS = 100_000;

export class SimulationError extends Error {
  constructor(message, code = "simulation-error") {
    super(message);
    this.name = "SimulationError";
    this.code = code;
  }
}

function requireInvariant(condition, message) {
  if (!condition) {
    throw new SimulationError(message, "invariant-violation");
  }
}

function deterministicId(namespace, value) {
  const hex = createHash("sha256").update(`${namespace}:${value}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function createGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function makeRecord(index, { reviewPolicy, operatorApprovalRequired, writer = true }) {
  const profile = writer ? "implement" : "explore";
  const contract = validateAssignmentRequest({
    profile,
    base_revision: "a".repeat(40),
    priority: "normal",
    allowed_write_roots: writer ? ["src"] : [],
    forbidden_write_roots: [],
    required_checks: [],
    artifacts: [],
    review_policy: reviewPolicy,
    operator_approval_required: operatorApprovalRequired,
  });
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    schema_version: CONTROL_PLANE_VERSION,
    assignment_id: deterministicId("assignment", index),
    state_revision: 0,
    state: "queued",
    attempt: 1,
    repository: "/simulation/repository",
    repository_key: "0".repeat(64),
    profile: contract.profile,
    writer: contract.writer,
    workspace_strategy: contract.workspace_strategy,
    capabilities: contract.capabilities,
    base_revision: contract.base_revision,
    priority: contract.priority,
    briefing_sha256: sha256(`simulation-${index}`),
    payload_path: `/simulation/${index}/payload.json`,
    allowed_write_roots: contract.allowed_write_roots,
    forbidden_write_roots: contract.forbidden_write_roots,
    required_checks: contract.required_checks,
    artifacts: contract.artifacts,
    review_policy: contract.review_policy,
    operator_approval_required: contract.operator_approval_required,
    allow_symlinks: contract.allow_symlinks,
    allow_submodules: contract.allow_submodules,
    parent_assignment_id: null,
    review_target_candidate_id: null,
    lock_id: null,
    generation: null,
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
}

function makeCandidate(record) {
  const candidateId = sha256(`${record.assignment_id}:${record.attempt}`);
  return {
    candidate_id: candidateId,
    candidate_revision: sha256(`revision:${candidateId}`).slice(0, 40),
    candidate_ref: `refs/codex-orchestration/candidates/${record.assignment_id}/${record.attempt}`,
    base_revision: record.base_revision,
    diff_sha256: sha256(`diff:${candidateId}`),
    contract_sha256: sha256(`contract:${candidateId}`),
    artifact_manifest_sha256: sha256("[]"),
    verification_sha256: sha256("[]"),
    changed_paths: ["src/value.txt"],
    artifacts: [],
  };
}

function makeResult(status, changedFiles = []) {
  return {
    schema_version: CONTROL_PLANE_RESULT_VERSION,
    status,
    summary: `simulated ${status}`,
    changed_files: changedFiles,
    checks: [],
    blockers: status === "completed" ? [] : [`simulated ${status}`],
    warnings: [],
  };
}

function validateRecordInvariants(before, after) {
  requireInvariant(after.state_revision === before.state_revision + 1, "State revision did not advance exactly once.");
  requireInvariant(after.assignment_id === before.assignment_id, "Assignment identity changed during a transition.");
  requireInvariant(after.attempt >= before.attempt, "Assignment attempt moved backwards.");
  if (after.review !== null) {
    requireInvariant(after.candidate !== null, "A review exists without a candidate.");
    requireInvariant(after.review.reviewed_candidate_id === after.candidate.candidate_id, "Review is bound to another candidate.");
  }
  if (after.approval !== null) {
    requireInvariant(after.candidate !== null, "An approval exists without a candidate.");
    requireInvariant(after.approval.candidate_id === after.candidate.candidate_id, "Approval is bound to another candidate.");
  }
  if (after.integration !== null) {
    requireInvariant(after.candidate !== null, "An integration exists without a candidate.");
    requireInvariant(after.integration.candidate_id === after.candidate.candidate_id, "Integration is bound to another candidate.");
  }
  if (["acknowledged", "abandoned"].includes(after.state)) {
    requireInvariant(after.resource_lease_active === false, "A terminal assignment retained its resource lease.");
  }
}

function createEngine(index, configuration) {
  let record = makeRecord(index, configuration);
  let sequence = 0;
  const states = [record.state];
  const apply = (op, authority, payload = {}) => {
    const before = record;
    sequence += 1;
    const action = createAction({
      op,
      authority,
      record,
      payload,
      actionId: deterministicId(`action-${index}`, sequence),
    });
    record = reduceAssignment(record, action, new Date(sequence * 1_000).toISOString());
    validateRecordInvariants(before, record);
    states.push(record.state);
    return action;
  };
  return {
    apply,
    get record() {
      return record;
    },
    get states() {
      return [...states];
    },
  };
}

function completeAssignment(engine, { withCandidate = true } = {}) {
  engine.apply("start_assignment", "root", {
    workspace: engine.record.writer ? { path: "/simulation/worktree", cleaned: false } : null,
  });
  const candidate = withCandidate ? makeCandidate(engine.record) : null;
  engine.apply("publish_result", "executor", {
    result: makeResult("completed", candidate === null ? [] : candidate.changed_paths),
    candidate,
    operator_requests: [],
  });
  engine.apply("claim_result", "root");
  if (candidate === null) {
    engine.apply("acknowledge_assignment", "root");
    return;
  }
  if (engine.record.review_policy === "independent") {
    engine.apply("request_review", "root", { candidate_id: candidate.candidate_id });
    engine.apply("publish_review", "reviewer", {
      candidate_id: candidate.candidate_id,
      verdict: "APPROVE",
      summary: "APPROVE",
      blockers: [],
      warnings: [],
      checks: [],
    });
  }
  engine.apply("approve_candidate", "root", { candidate_id: candidate.candidate_id, kind: "root" });
  if (engine.record.operator_approval_required) {
    engine.apply("approve_candidate", "operator", { candidate_id: candidate.candidate_id, kind: "operator" });
  }
  engine.apply("integrate_candidate", "root", {
    candidate_id: candidate.candidate_id,
    target_revision_before: engine.record.base_revision,
    applied_diff_sha256: candidate.diff_sha256,
  });
  engine.apply("acknowledge_assignment", "root");
}

function simulateBlockedRetry(index) {
  const engine = createEngine(index, { reviewPolicy: "root", operatorApprovalRequired: false, writer: true });
  engine.apply("start_assignment", "root", { workspace: { path: "/simulation/worktree", cleaned: false } });
  engine.apply("publish_result", "executor", {
    result: makeResult("blocked"),
    candidate: null,
    operator_requests: [{ request_id: "decision", question: "Continue?", choices: ["yes", "no"] }],
  });
  engine.apply("answer_request", "operator", { request_id: "decision", answer: "yes" });
  engine.apply("acknowledge_answer", "root", { request_id: "decision" });
  engine.apply("archive_workspace", "root", { archive_path: "/simulation/archive" });
  engine.apply("retry_assignment", "root", { base_revision: "b".repeat(40) });
  completeAssignment(engine);
  return engine;
}

function simulateRecovery(index) {
  const engine = createEngine(index, { reviewPolicy: "root", operatorApprovalRequired: false, writer: true });
  engine.apply("start_assignment", "root", { workspace: { path: "/simulation/worktree", cleaned: false } });
  engine.apply("mark_recovery_required", "daemon", { reason: "simulated interruption" });
  engine.apply("archive_workspace", "daemon", { archive_path: "/simulation/archive" });
  engine.apply("retry_assignment", "root", { base_revision: "c".repeat(40) });
  completeAssignment(engine);
  return engine;
}

function expectRejected(record, operation, authority, payload, expectedCode, actionId) {
  const action = createAction({ op: operation, authority, record, payload, actionId });
  try {
    reduceAssignment(record, action, "2026-01-01T00:00:00.000Z");
  } catch (error) {
    requireInvariant(error instanceof ControlPlaneError, "Fault probe raised an unexpected error type.");
    requireInvariant(error.code === expectedCode, `Fault probe expected ${expectedCode} but received ${error.code}.`);
    return;
  }
  throw new SimulationError(`Fault probe ${operation} was accepted.`, "fault-not-rejected");
}

function runFaultProbes(seed) {
  const engine = createEngine(seed, { reviewPolicy: "independent", operatorApprovalRequired: true, writer: true });
  const staleAction = engine.apply("start_assignment", "root", { workspace: { path: "/simulation/worktree" } });
  try {
    reduceAssignment(engine.record, staleAction, "2026-01-01T00:00:01.000Z");
    throw new SimulationError("A stale action replay was accepted.", "fault-not-rejected");
  } catch (error) {
    if (error instanceof SimulationError) {
      throw error;
    }
    requireInvariant(error instanceof ControlPlaneError && error.code === "stale-state-revision", "Stale replay did not fail with revision fencing.");
  }
  const id = deterministicId("fault", seed);
  expectRejected(engine.record, "publish_result", "operator", {}, "unauthorized-action", id);
  const candidate = makeCandidate(engine.record);
  engine.apply("publish_result", "executor", {
    result: makeResult("completed", candidate.changed_paths),
    candidate,
    operator_requests: [],
  });
  engine.apply("claim_result", "root");
  expectRejected(
    engine.record,
    "integrate_candidate",
    "root",
    {
      candidate_id: candidate.candidate_id,
      target_revision_before: engine.record.base_revision,
      applied_diff_sha256: candidate.diff_sha256,
    },
    "invalid-transition",
    deterministicId("fault", seed + 1),
  );
  engine.apply("request_review", "root", { candidate_id: candidate.candidate_id });
  expectRejected(
    engine.record,
    "publish_review",
    "reviewer",
    { candidate_id: "0".repeat(64), verdict: "APPROVE" },
    "stale-candidate",
    deterministicId("fault", seed + 2),
  );
  return 4;
}

export function simulateControlPlane({ iterations = DEFAULT_ITERATIONS, seed = DEFAULT_SEED } = {}) {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) {
    throw new SimulationError(`iterations must be an integer between 1 and ${MAX_ITERATIONS}.`, "invalid-arguments");
  }
  if (!Number.isSafeInteger(seed)) {
    throw new SimulationError("seed must be a safe integer.", "invalid-arguments");
  }
  const random = createGenerator(seed);
  const scenarioCounts = {
    candidate: 0,
    zero_change: 0,
    independent_review: 0,
    operator_approval: 0,
    blocked_retry: 0,
    recovery: 0,
  };
  let transitions = 0;
  for (let index = 0; index < iterations; index += 1) {
    const choice = Math.floor(random() * 6);
    let engine;
    if (choice === 0) {
      engine = createEngine(index, { reviewPolicy: "root", operatorApprovalRequired: false, writer: true });
      completeAssignment(engine);
      scenarioCounts.candidate += 1;
    } else if (choice === 1) {
      engine = createEngine(index, { reviewPolicy: "root", operatorApprovalRequired: false, writer: false });
      completeAssignment(engine, { withCandidate: false });
      scenarioCounts.zero_change += 1;
    } else if (choice === 2) {
      engine = createEngine(index, { reviewPolicy: "independent", operatorApprovalRequired: false, writer: true });
      completeAssignment(engine);
      scenarioCounts.independent_review += 1;
    } else if (choice === 3) {
      engine = createEngine(index, { reviewPolicy: "independent", operatorApprovalRequired: true, writer: true });
      completeAssignment(engine);
      scenarioCounts.independent_review += 1;
      scenarioCounts.operator_approval += 1;
    } else if (choice === 4) {
      engine = simulateBlockedRetry(index);
      scenarioCounts.blocked_retry += 1;
    } else {
      engine = simulateRecovery(index);
      scenarioCounts.recovery += 1;
    }
    requireInvariant(engine.record.state === "acknowledged", "A successful scenario did not terminate in acknowledged.");
    transitions += engine.record.state_revision;
  }
  const rejectedFaults = runFaultProbes(seed + iterations);
  return {
    schema_version: 1,
    status: "completed",
    seed,
    iterations,
    transitions,
    rejected_faults: rejectedFaults,
    scenario_counts: scenarioCounts,
  };
}

export function parseSimulationArguments(argv) {
  const options = { iterations: DEFAULT_ITERATIONS, seed: DEFAULT_SEED };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!["--iterations", "--seed"].includes(name) || seen.has(name)) {
      throw new SimulationError(`Unknown or repeated simulator argument: ${name}`, "invalid-arguments");
    }
    const value = argv[index + 1];
    if (value === undefined || !/^-?\d+$/.test(value)) {
      throw new SimulationError(`${name} requires an integer.`, "invalid-arguments");
    }
    seen.add(name);
    index += 1;
    options[name === "--iterations" ? "iterations" : "seed"] = Number(value);
  }
  return options;
}

async function main() {
  try {
    process.stdout.write(`${JSON.stringify(simulateControlPlane(parseSimulationArguments(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "failed", error: error.message, code: error.code ?? "simulation-error" })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
