import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ControlPlaneError,
  createAction,
  createReviewPublication,
  dispatchAssignmentAction,
  getControlPlaneStatus,
  readAssignment,
  validateEffectRequest,
} from "./control-plane.mjs";
import { getExecutorProfile } from "./executor-profiles.mjs";
import {
  archiveAssignmentWorktree,
  cleanupAssignmentWorktree,
  commitIntegratedCandidate,
  GitWorkspaceError,
  inspectGitRepository,
  integrateCandidate,
  pushCommittedCandidate,
  runProcess,
} from "./git-workspace.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const EXECUTOR_PATH = resolve(fileURLToPath(new URL("invoke-profile-executor.mjs", import.meta.url)));
const COMMANDS = new Set([
  "status",
  "next",
  "claim",
  "request-review",
  "approve",
  "integrate",
  "commit-delivery",
  "push-delivery",
  "retry-delivery",
  "ack",
  "answer",
  "ack-answer",
  "retry",
  "abandon",
  "archive",
  "cleanup",
  "reconcile",
  "dashboard",
]);

export class ControlCliError extends Error {
  constructor(message) {
    super(message);
    this.name = "ControlCliError";
  }
}

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ControlCliError(`${option} requires a value.`);
  }
  return value;
}

export function parseControlArguments(argv, baseDirectory = process.cwd()) {
  if (argv.length === 0 || !COMMANDS.has(argv[0])) {
    throw new ControlCliError(`Command must be one of: ${[...COMMANDS].join(", ")}.`);
  }
  const parsed = {
    command: argv[0],
    cwd: resolve(baseDirectory),
    assignmentId: null,
    revision: null,
    authority: "root",
    kind: null,
    requestId: null,
    answer: null,
    reason: null,
    watch: false,
    intervalMs: 1_000,
    host: "127.0.0.1",
    port: 0,
  };
  const booleanOptions = new Set(["--watch"]);
  const valueOptions = new Set([
    "--cwd",
    "--assignment-id",
    "--revision",
    "--authority",
    "--kind",
    "--request-id",
    "--answer",
    "--reason",
    "--interval-ms",
    "--host",
    "--port",
  ]);
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (!booleanOptions.has(option) && !valueOptions.has(option)) {
      throw new ControlCliError(`Unknown option: ${option}`);
    }
    if (seen.has(option)) {
      throw new ControlCliError(`Duplicate option: ${option}`);
    }
    seen.add(option);
    if (option === "--watch") {
      parsed.watch = true;
      continue;
    }
    const value = requireValue(argv, index, option);
    index += 1;
    if (option === "--cwd") {
      parsed.cwd = resolve(baseDirectory, value);
    } else if (option === "--assignment-id") {
      parsed.assignmentId = value;
    } else if (option === "--revision") {
      parsed.revision = Number(value);
      if (!Number.isInteger(parsed.revision) || parsed.revision < 0) {
        throw new ControlCliError("--revision must be a non-negative integer.");
      }
    } else if (option === "--authority") {
      if (!["root", "ultra", "operator"].includes(value)) {
        throw new ControlCliError("--authority must be root, ultra, or operator.");
      }
      parsed.authority = value;
    } else if (option === "--kind") {
      if (!["root", "operator"].includes(value)) {
        throw new ControlCliError("--kind must be root or operator.");
      }
      parsed.kind = value;
    } else if (option === "--request-id") {
      parsed.requestId = value;
    } else if (option === "--answer") {
      parsed.answer = value;
    } else if (option === "--reason") {
      parsed.reason = value;
    } else if (option === "--interval-ms") {
      parsed.intervalMs = Number(value);
      if (!Number.isInteger(parsed.intervalMs) || parsed.intervalMs < 250 || parsed.intervalMs > 60_000) {
        throw new ControlCliError("--interval-ms must be between 250 and 60000.");
      }
    } else if (option === "--host") {
      if (!["127.0.0.1", "::1", "localhost"].includes(value)) {
        throw new ControlCliError("Dashboard host must be loopback.");
      }
      parsed.host = value;
    } else {
      parsed.port = Number(value);
      if (!Number.isInteger(parsed.port) || parsed.port < 0 || parsed.port > 65_535) {
        throw new ControlCliError("--port must be between 0 and 65535.");
      }
    }
  }
  const mutating = new Set([
    "claim",
    "request-review",
    "approve",
    "integrate",
    "commit-delivery",
    "push-delivery",
    "retry-delivery",
    "ack",
    "answer",
    "ack-answer",
    "retry",
    "abandon",
    "archive",
    "cleanup",
  ]);
  if (mutating.has(parsed.command)) {
    if (parsed.assignmentId === null) {
      throw new ControlCliError(`${parsed.command} requires --assignment-id.`);
    }
    if (parsed.revision === null) {
      throw new ControlCliError(`${parsed.command} requires --revision.`);
    }
  }
  if (parsed.command === "approve" && parsed.kind === null) {
    throw new ControlCliError("approve requires --kind.");
  }
  if (parsed.command === "answer" && (parsed.requestId === null || parsed.answer === null)) {
    throw new ControlCliError("answer requires --request-id and --answer.");
  }
  if (parsed.command === "ack-answer" && parsed.requestId === null) {
    throw new ControlCliError("ack-answer requires --request-id.");
  }
  if (parsed.command === "abandon" && parsed.reason === null) {
    throw new ControlCliError("abandon requires --reason.");
  }
  return parsed;
}

function assertExpectedRevision(record, expected) {
  if (record.state_revision !== expected) {
    throw new ControlCliError(`Assignment revision is ${record.state_revision}, not ${expected}.`);
  }
}

async function applySimpleAction(options, op, payload = {}, authority = options.authority) {
  const record = await readAssignment(options.cwd, options.assignmentId);
  assertExpectedRevision(record, options.revision);
  return (
    await dispatchAssignmentAction(
      record.repository,
      createAction({ op, authority, record, payload }),
    )
  ).record;
}

async function commitDeliveryRecord(record, authority) {
  return (
    await dispatchAssignmentAction(
      record.repository,
      createAction({
        op: "record_commit",
        authority,
        record,
        payload: { candidate_id: record.candidate?.candidate_id },
      }),
      { beforeTransition: async (current) => commitIntegratedCandidate(current, current.repository) },
    )
  ).record;
}

async function pushDeliveryRecord(record, authority) {
  return (
    await dispatchAssignmentAction(
      record.repository,
      createAction({
        op: "record_push",
        authority,
        record,
        payload: {
          candidate_id: record.candidate?.candidate_id,
          commit_revision: record.delivery.commit?.commit_revision,
        },
      }),
      { beforeTransition: async (current) => pushCommittedCandidate(current, current.repository) },
    )
  ).record;
}

async function blockDeliveryRecord(record, phase, error, authority) {
  const errorCode = error instanceof GitWorkspaceError ? error.code : "delivery-operation-failed";
  const summary = `Automatic ${phase} failed (${errorCode}).`;
  return (
    await dispatchAssignmentAction(
      record.repository,
      createAction({
        op: "block_delivery",
        authority,
        record,
        payload: { phase, error_code: errorCode, summary },
      }),
    )
  ).record;
}

function deliveryAuthority(record) {
  if (record.lock_id === null) {
    return "root";
  }
  if (
    process.env.CODEX_ORCHESTRATION_LOCK_ID !== record.lock_id ||
    Number(process.env.CODEX_ORCHESTRATION_GENERATION) !== record.generation
  ) {
    throw new ControlCliError("Ultra delivery requires the matching lock id and generation environment.");
  }
  return "ultra";
}

async function archiveRecord(record, authority) {
  if (
    record.workspace === null ||
    record.workspace.path === null ||
    record.workspace.shared === true ||
    record.workspace.archived === true
  ) {
    return record;
  }
  return (
    await dispatchAssignmentAction(
      record.repository,
      createAction({
        op: "archive_workspace",
        authority,
        record,
      }),
      { beforeTransition: async (current) => ({ archive_path: await archiveAssignmentWorktree(current) }) },
    )
  ).record;
}

async function cleanupRecord(record, authority) {
  return (
    await dispatchAssignmentAction(
      record.repository,
      createAction({
        op: "cleanup_workspace",
        authority,
        record,
      }),
      { beforeTransition: async (current) => {
        const cleanup = await cleanupAssignmentWorktree(current);
        if (!cleanup.cleaned) throw new ControlCliError("Workspace was not cleaned.");
        return { cleaned_path: cleanup.path };
      } },
    )
  ).record;
}

async function startQueuedAssignment(record) {
  const profile = getExecutorProfile(record.profile);
  const result = await runProcess(
    process.execPath,
    [
      EXECUTOR_PATH,
      "--profile",
      profile.name,
      "--cwd",
      record.repository,
      "--sandbox",
      profile.sandboxMode,
      "--control-plane",
      "v2",
      "--result-format",
      "v2",
      "--assignment-id",
      record.assignment_id,
    ],
    { cwd: record.repository, timeoutMs: 86_400_000 },
  );
  const lines = result.stdout.toString("utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
  let payload = null;
  try {
    payload = lines.length === 0 ? null : JSON.parse(lines.at(-1));
  } catch {}
  return {
    assignment_id: record.assignment_id,
    exit_code: result.exitCode,
    result: payload,
    stderr: result.stderr.toString("utf8"),
  };
}

async function finalizeReviewRecord(record, authority, coordinationOptions = {}) {
  let current = record;
  if (current.state === "result_ready") {
    current = (
      await dispatchAssignmentAction(
        current.repository,
        createAction({ op: "claim_result", authority, record: current }),
        coordinationOptions,
      )
    ).record;
  }
  if (current.state === "claimed") {
    return (
      await dispatchAssignmentAction(
        current.repository,
        createAction({ op: "acknowledge_assignment", authority, record: current }),
        coordinationOptions,
      )
    ).record;
  }
  if (current.state === "blocked") {
    return (
      await dispatchAssignmentAction(
        current.repository,
        createAction({
          op: "abandon_assignment",
          authority,
          record: current,
          payload: { reason: "Review verdict was published to the parent assignment." },
        }),
        coordinationOptions,
      )
    ).record;
  }
  return current;
}

export async function reconcileReviewAssignment(record, coordinationOptions = {}) {
  const parent = await readAssignment(record.repository, record.parent_assignment_id, coordinationOptions);
  if (parent.review?.reviewer_assignment_id !== record.assignment_id) {
    await dispatchAssignmentAction(
      parent.repository,
      createAction({
        op: "publish_review",
        authority: "reviewer",
        record: parent,
        payload: createReviewPublication(record, parent),
      }),
      coordinationOptions,
    );
  }
  const authority = record.lock_id === null ? "root" : "ultra";
  return finalizeReviewRecord(record, authority, coordinationOptions);
}

async function reconcileOnce(cwd) {
  const status = await getControlPlaneStatus(cwd);
  const results = [];
  const reviewActions = status.planner.mechanical.filter(
    (action) => action.op === "publish_review_result" || action.op === "finalize_review_assignment",
  );
  for (const action of reviewActions) {
    const record = await readAssignment(cwd, action.assignment_id);
    try {
      results.push({ op: action.op, record: await reconcileReviewAssignment(record) });
    } catch (error) {
      results.push({ op: action.op, assignment_id: record.assignment_id, error: error.message });
    }
  }
  const deliveryActions = status.planner.mechanical.filter(
    (action) => ["commit_candidate", "push_candidate", "acknowledge_assignment"].includes(action.op),
  );
  for (const action of deliveryActions) {
    let record = await readAssignment(cwd, action.assignment_id);
    try {
      const authority = deliveryAuthority(record);
      if (action.op === "commit_candidate") {
        record = await commitDeliveryRecord(record, authority);
      } else if (action.op === "push_candidate") {
        record = await pushDeliveryRecord(record, authority);
      } else {
        record = (
          await dispatchAssignmentAction(
            record.repository,
            createAction({ op: "acknowledge_assignment", authority, record }),
          )
        ).record;
      }
      results.push({ op: action.op, record });
    } catch (error) {
      if (error instanceof GitWorkspaceError && action.op !== "acknowledge_assignment") {
        const phase = action.op === "commit_candidate" ? "commit" : "push";
        record = await blockDeliveryRecord(record, phase, error, deliveryAuthority(record));
        results.push({ op: action.op, record, error: record.delivery.last_error.summary });
      } else {
        results.push({
          op: action.op,
          assignment_id: record.assignment_id,
          error: "Automatic delivery state transition failed.",
        });
      }
    }
  }
  const cleanupActions = status.planner.mechanical.filter((action) => action.op === "cleanup_workspace");
  for (const action of cleanupActions) {
    const record = await readAssignment(cwd, action.assignment_id);
    try {
      results.push({ op: "cleanup_workspace", record: await cleanupRecord(record, "daemon") });
    } catch (error) {
      results.push({ op: "cleanup_workspace", assignment_id: record.assignment_id, error: error.message });
    }
  }
  const startActions = status.planner.mechanical.filter((action) => action.op === "start_assignment");
  const starts = await Promise.all(startActions.map(async (action) => {
    const record = await readAssignment(cwd, action.assignment_id);
    return startQueuedAssignment(record);
  }));
  results.push(...starts);
  return { status: await getControlPlaneStatus(cwd), results };
}

async function wait(milliseconds) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function statusRevisionFingerprint(status) {
  return status.assignments
    .map((record) => `${record.assignment_id}:${record.state_revision}`)
    .sort()
    .join("|");
}

async function reconcileUntilSettled(cwd, maximumPasses = 32) {
  const results = [];
  let status = await getControlPlaneStatus(cwd);
  for (let pass = 0; pass < maximumPasses && status.planner.mechanical.length > 0; pass += 1) {
    const before = statusRevisionFingerprint(status);
    const reconciled = await reconcileOnce(cwd);
    results.push(...reconciled.results);
    status = reconciled.status;
    if (statusRevisionFingerprint(status) === before) {
      break;
    }
  }
  return { status, results };
}

export async function executeControlCommand(options) {
  if (options.command === "status") {
    if (options.assignmentId === null) {
      return getControlPlaneStatus(options.cwd);
    }
    const status = await getControlPlaneStatus(options.cwd);
    const assignment = status.assignments.find((item) => item.assignment_id === options.assignmentId);
    if (assignment === undefined) {
      throw new ControlCliError(`Assignment not found: ${options.assignmentId}`);
    }
    return assignment;
  }
  if (options.command === "next") {
    return (await getControlPlaneStatus(options.cwd)).planner;
  }
  if (options.command === "claim") {
    return applySimpleAction(options, "claim_result");
  }
  if (options.command === "request-review") {
    const record = await readAssignment(options.cwd, options.assignmentId);
    assertExpectedRevision(record, options.revision);
    return applySimpleAction(options, "request_review", { candidate_id: record.candidate?.candidate_id });
  }
  if (options.command === "approve") {
    const record = await readAssignment(options.cwd, options.assignmentId);
    assertExpectedRevision(record, options.revision);
    const authority = options.kind === "operator" ? "operator" : options.authority;
    return applySimpleAction(
      options,
      "approve_candidate",
      { candidate_id: record.candidate?.candidate_id, kind: options.kind },
      authority,
    );
  }
  if (options.command === "integrate") {
    const record = await readAssignment(options.cwd, options.assignmentId);
    assertExpectedRevision(record, options.revision);
    return (
      await dispatchAssignmentAction(
        record.repository,
        createAction({
          op: "integrate_candidate",
          authority: options.authority,
          record,
          payload: { candidate_id: record.candidate?.candidate_id },
        }),
        {
          beforeTransition: async (current) => integrateCandidate(current, options.cwd),
        },
      )
    ).record;
  }
  if (options.command === "commit-delivery") {
    const record = await readAssignment(options.cwd, options.assignmentId);
    assertExpectedRevision(record, options.revision);
    try {
      return await commitDeliveryRecord(record, options.authority);
    } catch (error) {
      if (error instanceof GitWorkspaceError) {
        return blockDeliveryRecord(record, "commit", error, options.authority);
      }
      throw error;
    }
  }
  if (options.command === "push-delivery") {
    const record = await readAssignment(options.cwd, options.assignmentId);
    assertExpectedRevision(record, options.revision);
    try {
      return await pushDeliveryRecord(record, options.authority);
    } catch (error) {
      if (error instanceof GitWorkspaceError) {
        return blockDeliveryRecord(record, "push", error, options.authority);
      }
      throw error;
    }
  }
  if (options.command === "retry-delivery") {
    return applySimpleAction(options, "retry_delivery");
  }
  if (options.command === "ack") {
    return applySimpleAction(options, "acknowledge_assignment");
  }
  if (options.command === "answer") {
    return applySimpleAction(
      options,
      "answer_request",
      { request_id: options.requestId, answer: options.answer },
      "operator",
    );
  }
  if (options.command === "ack-answer") {
    return applySimpleAction(options, "acknowledge_answer", { request_id: options.requestId });
  }
  if (options.command === "retry") {
    let record = await readAssignment(options.cwd, options.assignmentId);
    assertExpectedRevision(record, options.revision);
    const repository = await inspectGitRepository(record.repository);
    validateEffectRequest(record, createAction({ op: "retry_assignment", authority: options.authority, record, payload: { base_revision: repository.head } }));
    record = await archiveRecord(record, options.authority);
    return (
      await dispatchAssignmentAction(
        record.repository,
        createAction({
          op: "retry_assignment",
          authority: options.authority,
          record,
          payload: { base_revision: repository.head },
        }),
      )
    ).record;
  }
  if (options.command === "abandon") {
    let record = await readAssignment(options.cwd, options.assignmentId);
    assertExpectedRevision(record, options.revision);
    validateEffectRequest(record, createAction({ op: "abandon_assignment", authority: options.authority, record, payload: { reason: options.reason } }));
    record = await archiveRecord(record, options.authority);
    return (
      await dispatchAssignmentAction(
        record.repository,
        createAction({
          op: "abandon_assignment",
          authority: options.authority,
          record,
          payload: { reason: options.reason },
        }),
      )
    ).record;
  }
  if (options.command === "archive") {
    const record = await readAssignment(options.cwd, options.assignmentId);
    assertExpectedRevision(record, options.revision);
    return archiveRecord(record, options.authority);
  }
  if (options.command === "cleanup") {
    const record = await readAssignment(options.cwd, options.assignmentId);
    assertExpectedRevision(record, options.revision);
    return cleanupRecord(record, options.authority);
  }
  if (options.command === "reconcile") {
    let result = await reconcileUntilSettled(options.cwd);
    if (!options.watch) {
      return result;
    }
    while (true) {
      await wait(options.intervalMs);
      result = await reconcileUntilSettled(options.cwd);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  }
  const { startDashboard } = await import("./orchestration-dashboard.mjs");
  return startDashboard({ cwd: options.cwd, host: options.host, port: options.port });
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseControlArguments(argv);
    const result = await executeControlCommand(options);
    if (options.command === "dashboard") {
      process.stdout.write(`${JSON.stringify({ status: "listening", url: result.url })}\n`);
      await result.closed;
      return 0;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ status: "failed", error: message })}\n`);
    return error instanceof ControlPlaneError || error instanceof ControlCliError ? 2 : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = await main();
}
