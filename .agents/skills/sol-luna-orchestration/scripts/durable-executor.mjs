import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  CONTROL_PLANE_RESULT_VERSION,
  ControlPlaneError,
  createAction,
  createAssignment,
  createReviewPublication,
  dispatchAssignmentAction,
  findAssignmentByCandidate,
  readAssignment,
  readAssignmentBriefing,
  canonicalJson,
  sha256,
} from "./control-plane.mjs";
import { getExecutorProfile } from "./executor-profiles.mjs";
import {
  loadExecutorResultContract,
  validateExecutorResultContract,
} from "./executor-result-contract.mjs";
import {
  GitWorkspaceError,
  cleanupAssignmentWorktree,
  createAssignmentWorktree,
  createCandidate,
  createCandidateReviewWorktree,
  inspectGitRepository,
  runRequiredChecks,
  captureWorkspaceFingerprint,
} from "./git-workspace.mjs";
import {
  ORCHESTRATION_GENERATION_ENV,
  ORCHESTRATION_LOCK_ENV,
  ORCHESTRATION_ROLE_ENV,
  ULTRA_ORCHESTRATOR_ROLE,
  atomicCreate,
  getEntry,
  readJson,
  closeExecutorFinalization,
  finalizationFailure,
  validateExecutorFinalization,
} from "./orchestration-state.mjs";

function authorityFromEnvironment(environment) {
  return environment[ORCHESTRATION_ROLE_ENV] === ULTRA_ORCHESTRATOR_ROLE ? "ultra" : "root";
}

function inheritedGeneration(environment) {
  const value = environment[ORCHESTRATION_GENERATION_ENV];
  if (value === undefined) {
    return null;
  }
  const generation = Number(value);
  return Number.isInteger(generation) && generation >= 1 ? generation : null;
}

function assertEpochEnvironment(record, environment) {
  if (record.lock_id === null && record.generation === null) {
    return;
  }
  if (
    environment[ORCHESTRATION_LOCK_ENV] !== record.lock_id ||
    environment[ORCHESTRATION_GENERATION_ENV] !== String(record.generation)
  ) {
    throw new ControlPlaneError("Durable assignment belongs to another Ultra epoch.", "stale-epoch");
  }
}

function createOperatorRequests(record, requests) {
  return requests.map((request, index) => ({
    request_id: randomUUID(),
    question: request.question,
    choices: [...request.choices],
    source: request.source ?? "executor",
    sensitive: request.sensitive === true,
    assignment_id: record.assignment_id,
    attempt: record.attempt,
    ordinal: index,
  }));
}

function priorOperatorAnswerLines(record) {
  const answers = new Map();
  for (const attempt of record.previous_attempts ?? []) {
    for (const request of attempt.operator_requests ?? []) {
      if (
        request.state === "acknowledged" &&
        request.sensitive !== true &&
        typeof request.question === "string" &&
        typeof request.answer === "string"
      ) {
        answers.set(request.question, request.answer);
      }
    }
  }
  return [...answers].map(
    ([question, answer]) => `- Question ${JSON.stringify(question)}: ${JSON.stringify(answer)}`,
  );
}

export function createContractBriefing(record, briefing) {
  const roots = record.writer ? record.allowed_write_roots.join(", ") : "none";
  const operatorAnswers = priorOperatorAnswerLines(record);
  return [
    `Assignment id: ${record.assignment_id}`,
    `Assignment attempt: ${record.attempt}`,
    `Base revision: ${record.base_revision}`,
    `Allowed write roots: ${roots}`,
    `Controller delivery policy: ${record.delivery.mode}`,
    record.writer
      ? "Your cwd is an isolated worktree. Modify only the allowed roots. Do not stage, commit, change HEAD, create branches, or touch another checkout."
      : "Keep repository files unchanged.",
    "If essential operator input is missing, return blocked and use operator_requests.",
    ...(operatorAnswers.length === 0
      ? []
      : ["Operator answers from previous attempts:", ...operatorAnswers]),
    "",
    briefing.trim(),
  ].join("\n");
}

export function createResultEnvelopeV2({
  record,
  execution,
  candidate = null,
  changedFiles = execution.result.changed_files,
  artifacts = [],
  operatorRequests = [],
  checkResults = [],
  extraWarnings = [],
}) {
  return {
    schema_version: CONTROL_PLANE_RESULT_VERSION,
    assignment_id: record.assignment_id,
    attempt: record.attempt,
    status: execution.result.status,
    profile: execution.result.profile,
    thread_id: execution.result.thread_id,
    model: execution.result.model,
    reasoning_effort: execution.result.reasoning_effort,
    service_tier: execution.result.service_tier,
    routing_verified: execution.result.routing_verified,
    sandbox_mode: execution.result.sandbox_mode,
    base_revision: record.base_revision,
    candidate,
    summary: execution.result.summary,
    changed_files: [...changedFiles],
    artifacts: [...artifacts],
    operator_requests: [...operatorRequests],
    checks: [...execution.result.checks, ...checkResults],
    blockers: [...execution.result.blockers],
    warnings: [...execution.result.warnings, ...extraWarnings],
  };
}

function failedExecution(execution, error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    result: {
      ...execution.result,
      status: "failed",
      summary: message,
      changed_files: error?.details?.actual ?? execution.result.changed_files,
      blockers: [...execution.result.blockers, message],
    },
    operatorRequests: [],
    exitCode: 2,
  };
}

function pendingExecutionResponse(execution, record, options) {
  const envelope = createResultEnvelopeV2({ record, execution });
  return { ...execution, durableResult: envelope, result: options.resultFormat === "v1" ? execution.result : envelope };
}

async function createNewRecord({ briefing, options, environment, coordinationOptions }) {
  if (options.candidateId !== null) {
    if (options.profile !== "review") {
      throw new ControlPlaneError("--candidate-id requires the review profile.", "invalid-contract");
    }
    const target = await findAssignmentByCandidate(options.cwd, options.candidateId, coordinationOptions);
    if (target.state !== "review_pending" || target.review_policy !== "independent") {
      throw new ControlPlaneError("Candidate is not awaiting independent review.", "invalid-transition");
    }
    return {
      target,
      record: await createAssignment({
        cwd: target.repository,
        briefing,
        ...coordinationOptions,
        environment,
        request: {
          profile: "review",
          base_revision: target.candidate.candidate_revision,
          priority: options.priority,
          allowed_write_roots: [],
          forbidden_write_roots: [],
          required_checks: [],
          artifacts: [],
          review_policy: "root",
          operator_approval_required: false,
          delivery: { mode: "manual" },
          parent_assignment_id: target.assignment_id,
          review_target_candidate_id: target.candidate.candidate_id,
          lock_id: environment[ORCHESTRATION_LOCK_ENV] ?? null,
          generation: inheritedGeneration(environment),
        },
      }),
    };
  }
  const repository = await inspectGitRepository(options.cwd, coordinationOptions);
  return {
    target: null,
    record: await createAssignment({
      cwd: repository.repository,
      briefing,
      ...coordinationOptions,
      environment,
      request: {
        profile: options.profile,
        base_revision: repository.head,
        priority: options.priority,
        allowed_write_roots: options.writeRoots,
        forbidden_write_roots: options.forbiddenRoots,
        required_checks: options.requiredChecks,
        artifacts: options.artifacts,
        review_policy: options.reviewPolicy,
        operator_approval_required: options.operatorApprovalRequired,
        allow_symlinks: options.allowSymlinks,
        allow_submodules: options.allowSubmodules,
        delivery: {
          mode: options.deliveryMode ?? "manual",
          commit_message: options.commitMessage ?? null,
          remote: options.pushRemote ?? null,
          branch: options.pushBranch ?? null,
        },
        lock_id: environment[ORCHESTRATION_LOCK_ENV] ?? null,
        generation: inheritedGeneration(environment),
      },
    }),
  };
}

async function loadOrCreateRecord(input) {
  if (input.options.assignmentId === null) {
    return createNewRecord(input);
  }
  const record = await readAssignment(
    input.options.cwd,
    input.options.assignmentId,
    input.coordinationOptions,
  );
  if (record.profile !== input.options.profile) {
    throw new ControlPlaneError(
      `Assignment profile ${record.profile} does not match ${input.options.profile}.`,
      "invalid-contract",
    );
  }
  if (record.state !== "queued") {
    throw new ControlPlaneError(`Assignment ${record.assignment_id} is ${record.state}, not queued.`, "invalid-transition");
  }
  const briefing = await readAssignmentBriefing(
    record.repository,
    record.assignment_id,
    input.coordinationOptions,
  );
  const target = record.review_target_candidate_id === null
    ? null
    : await findAssignmentByCandidate(
        record.repository,
        record.review_target_candidate_id,
        input.coordinationOptions,
      );
  return { record, target, briefing };
}

async function prepareWorkspace(record, target, options) {
  if (record.workspace_strategy === "isolated-worktree") {
    return createAssignmentWorktree(record, options);
  }
  if (record.workspace_strategy === "candidate-worktree" && target !== null) {
    return createCandidateReviewWorktree(target, options);
  }
  return {
    path: record.repository,
    shared: true,
    read_only: true,
    archived: false,
    cleaned: true,
    created_at: new Date().toISOString(),
  };
}

async function publishSetupFailure(record, error, authority, options) {
  let current = record;
  if (record.state === "queued") {
    current = (
      await dispatchAssignmentAction(
        record.repository,
        createAction({
          op: "start_assignment",
          authority,
          record,
          payload: { workspace: { path: null, setup_failed: true, cleaned: true } },
        }),
        options,
      )
    ).record;
  }
  const message = error instanceof Error ? error.message : String(error);
  const result = {
    schema_version: CONTROL_PLANE_RESULT_VERSION,
    assignment_id: current.assignment_id,
    attempt: current.attempt,
    status: "failed",
    profile: current.profile,
    thread_id: null,
    model: getExecutorProfile(current.profile).model,
    reasoning_effort: getExecutorProfile(current.profile).reasoningEffort,
    service_tier: getExecutorProfile(current.profile).serviceTier,
    routing_verified: false,
    sandbox_mode: getExecutorProfile(current.profile).sandboxMode,
    base_revision: current.base_revision,
    candidate: null,
    summary: message,
    changed_files: [],
    artifacts: [],
    operator_requests: [],
    checks: [],
    blockers: [message],
    warnings: [],
  };
  const published = (
    await dispatchAssignmentAction(
      current.repository,
      createAction({
        op: "publish_result",
        authority: "executor",
        record: current,
        payload: { result, candidate: null, operator_requests: [] },
      }),
      options,
    )
  ).record;
  return { record: published, result, exitCode: 2 };
}

export async function invokeDurableExecutor({
  briefing,
  options,
  invokeLegacy,
  environment = process.env,
  coordinationOptions = {},
  signal,
  command,
  sessionRoots,
  appServerRunner,
  playwrightMcpVerifier,
  outputContractLoader = loadExecutorResultContract,
}) {
  const outputContract = validateExecutorResultContract(await outputContractLoader());
  const loaded = await loadOrCreateRecord({
    briefing,
    options,
    environment,
    coordinationOptions,
  });
  let record = loaded.record;
  assertEpochEnvironment(record, environment);
  const target = loaded.target;
  const effectiveBriefing = loaded.briefing ?? briefing;
  const authority = authorityFromEnvironment(environment);
  if (options.enqueueOnly) {
    return {
      result: {
        schema_version: CONTROL_PLANE_RESULT_VERSION,
        assignment_id: record.assignment_id,
        attempt: record.attempt,
        status: "queued",
        profile: record.profile,
        base_revision: record.base_revision,
      },
      exitCode: 0,
    };
  }
  let workspace;
  try {
    workspace = await prepareWorkspace(record, target, coordinationOptions);
    record = (
      await dispatchAssignmentAction(
        record.repository,
        createAction({
          op: "start_assignment",
          authority,
          record,
          payload: { workspace },
        }),
        coordinationOptions,
      )
    ).record;
  } catch (error) {
    if (workspace?.path && record.writer) {
      await cleanupAssignmentWorktree({ ...record, workspace }, coordinationOptions).catch(() => {});
    }
    return publishSetupFailure(record, error, authority, coordinationOptions);
  }
  const profile = getExecutorProfile(record.profile);
  if (profile.sandboxMode === "workspace-write" && resolve(workspace.path) === resolve(record.repository)) {
    return publishSetupFailure(
      record,
      new ControlPlaneError("Workspace-write sandbox cannot target the main checkout.", "sandbox-worktree-mismatch"),
      authority,
      coordinationOptions,
    );
  }
  const executorEnvironment = {
    ...environment,
    CODEX_ORCHESTRATION_ASSIGNMENT_ID: record.assignment_id,
    CODEX_ORCHESTRATION_ASSIGNMENT_ATTEMPT: String(record.attempt),
    CODEX_ORCHESTRATION_WORKTREE: workspace.path,
  };
  let execution;
  try {
    execution = await invokeLegacy({
      briefing: createContractBriefing(record, effectiveBriefing),
      options: {
        profile: record.profile,
        cwd: workspace.path,
        coordinationCwd: record.repository,
        sandboxMode: profile.sandboxMode,
        timeoutSeconds: options.timeoutSeconds,
      },
      environment: executorEnvironment,
      coordinationOptions,
      signal,
      command,
      sessionRoots,
      appServerRunner,
      playwrightMcpVerifier,
      outputContract,
      deferFinalization: true,
      finalizationContext: async () => ({
        assignment: { assignment_id: record.assignment_id, attempt: record.attempt, state_revision: record.state_revision, record_sha256: sha256(canonicalJson(record)), workspace_path: workspace.path, writer: record.writer },
        workspaceFingerprint: record.writer ? await captureWorkspaceFingerprint(record, workspace.path, coordinationOptions) : null,
      }),
    });
  } catch (error) {
    try { await dispatchAssignmentAction(
      record.repository,
      createAction({
        op: "mark_recovery_required",
        authority,
        record,
        payload: { reason: error instanceof Error ? error.message : String(error) },
      }),
      coordinationOptions,
    ); } catch (coordinationError) { if (error instanceof Error) error.cause ??= coordinationError; }
    throw error;
  }
  if (execution.finalizationPending) return pendingExecutionResponse(execution, record, options);
  try {
    if (execution.finalization) await validateExecutorFinalization(execution.finalization.lease, execution.finalization.receipt, { ...coordinationOptions, environment: executorEnvironment });
    const result = await continueExecutorResult({ record, workspace, execution, target, authority, options, coordinationOptions, executorEnvironment });
    if (execution.finalization) await closeExecutorFinalization(execution.finalization.lease, execution.finalization.receipt, coordinationOptions);
    return result;
  } catch (error) {
    if (!execution.finalization) throw error;
    return pendingExecutionResponse(finalizationFailure(execution, execution.finalization.lease, error, record.state_revision), record, options);
  }
}

async function continueExecutorResult({ record, workspace, execution, target = null, authority = "root", options = {}, coordinationOptions = {}, executorEnvironment = process.env, recovery = false }) {
  const receipt = execution.finalization?.receipt;
  const publicationPath = receipt ? join(execution.finalization.lease.stateDirectory, "finalizations", receipt.run_id, "publication.json") : null;
  let storedPublication = publicationPath && (await getEntry(publicationPath)) !== null ? await readJson(publicationPath, "Saved result publication") : null;
  if (storedPublication && (storedPublication.version !== 1 || storedPublication.receipt_sha256 !== receipt.receipt_sha256 || storedPublication.action_sha256 !== sha256(canonicalJson(storedPublication.action)) || storedPublication.action.op !== "publish_result" || storedPublication.action.assignment_id !== receipt.assignment.assignment_id || storedPublication.action.expected_state_revision !== receipt.assignment.state_revision || storedPublication.action.authority !== "executor")) throw new ControlPlaneError("Saved publication failed its receipt or hash verification.", "finalization-publication");
  if (!storedPublication && receipt?.assignment?.writer && await captureWorkspaceFingerprint(record, workspace.path, coordinationOptions) !== receipt.workspace_fingerprint) throw new ControlPlaneError("Worktree content or artifacts changed after the result was saved.", "finalization-workspace-changed");
  let candidateResult = {
    candidate: null,
    changedFiles: execution.result.changed_files,
    artifacts: [],
    checkResults: [],
  };
  if (!storedPublication && record.writer && execution.result.status === "completed") {
    try {
      const checkResults = await runRequiredChecks(record, workspace.path, coordinationOptions);
      candidateResult = await createCandidate(record, workspace.path, {
        ...coordinationOptions,
        environment: executorEnvironment,
        reportedChangedFiles: execution.result.changed_files,
        checkResults,
      });
    } catch (error) {
      if (!(error instanceof GitWorkspaceError)) {
        throw error;
      }
      execution = failedExecution(execution, error);
      candidateResult = {
        candidate: null,
        changedFiles: error.details.actual ?? execution.result.changed_files,
        artifacts: [],
        checkResults: error.details.checks ?? [],
      };
    }
  }
  const operatorRequests = storedPublication?.action.payload.operator_requests ?? createOperatorRequests(record, execution.operatorRequests ?? []);
  const warnings = record.writer && workspace.excluded_dirty_paths?.length > 0
    ? [`Main checkout changes outside the assignment scope were excluded: ${workspace.excluded_dirty_paths.join(", ")}.`]
    : [];
  const envelope = storedPublication?.action.payload.result ?? createResultEnvelopeV2({
    record,
    execution,
    candidate: candidateResult.candidate,
    changedFiles: candidateResult.changedFiles,
    artifacts: candidateResult.artifacts,
    operatorRequests,
    checkResults: candidateResult.checkResults,
    extraWarnings: warnings,
  });
  if (!storedPublication) {
    if (receipt?.assignment?.writer && await captureWorkspaceFingerprint(record, workspace.path, coordinationOptions) !== receipt.workspace_fingerprint) throw new ControlPlaneError("Worktree content or artifacts changed during result validation.", "finalization-workspace-changed");
    const action = createAction({
        op: "publish_result",
        authority: "executor",
        record,
        payload: {
          result: envelope,
          candidate: candidateResult.candidate,
          operator_requests: operatorRequests,
        },
      });
    storedPublication = { version: 1, receipt_sha256: receipt?.receipt_sha256 ?? null, action, action_sha256: sha256(canonicalJson(action)) };
    if (publicationPath) await atomicCreate(publicationPath, storedPublication);
    await coordinationOptions.onFinalizationBoundary?.("publication-prepared");
  }
  record = (await dispatchAssignmentAction(record.repository, storedPublication.action, coordinationOptions)).record;
  await coordinationOptions.onFinalizationBoundary?.("result-published");
  if (!recovery && target !== null && envelope.status !== "failed") {
    const currentTarget = await readAssignment(target.repository, target.assignment_id, coordinationOptions);
    await dispatchAssignmentAction(
      currentTarget.repository,
      createAction({
        op: "publish_review",
        authority: "reviewer",
        record: currentTarget,
        payload: createReviewPublication(record, currentTarget),
      }),
      coordinationOptions,
    );
    if (record.state === "result_ready") {
      record = (
        await dispatchAssignmentAction(
          record.repository,
          createAction({ op: "claim_result", authority, record }),
          coordinationOptions,
        )
      ).record;
      record = (
        await dispatchAssignmentAction(
          record.repository,
          createAction({ op: "acknowledge_assignment", authority, record }),
          coordinationOptions,
        )
      ).record;
    } else if (record.state === "blocked") {
      record = (
        await dispatchAssignmentAction(
          record.repository,
          createAction({
            op: "abandon_assignment",
            authority,
            record,
            payload: { reason: "Review verdict was published to the parent assignment." },
          }),
          coordinationOptions,
        )
      ).record;
    }
  }
  return {
    result: options.resultFormat === "v1" ? execution.result : envelope,
    durableResult: envelope,
    record,
    exitCode: execution.exitCode,
  };
}

export async function resumeExecutorFinalization({ state, lease, receipt, expectedRevision, environment = process.env, ...coordinationOptions }) {
  const binding = receipt.assignment;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== binding.state_revision) throw new ControlPlaneError("Assignment finalization requires its exact --expected-revision.", "stale-state-revision");
  let record = await readAssignment(state.repository, binding.assignment_id, { ...coordinationOptions, environment });
  const publicationPath = join(state.stateDirectory, "finalizations", receipt.run_id, "publication.json");
  const publication = (await getEntry(publicationPath)) === null ? null : await readJson(publicationPath, "Saved result publication");
  const ownPublication = publication && record.last_action_id === publication.action.action_id && record.state_revision === binding.state_revision + 1;
  if (record.attempt !== binding.attempt || (!ownPublication && (record.state_revision !== binding.state_revision || sha256(canonicalJson(record)) !== binding.record_sha256))) throw new ControlPlaneError("Assignment attempt or revision changed after the result was saved.", "stale-state-revision");
  if (record.workspace?.path !== binding.workspace_path) throw new ControlPlaneError("Assignment worktree changed after execution.", "finalization-workspace-changed");
  assertEpochEnvironment(record, environment);
  if (record.writer && await captureWorkspaceFingerprint(record, record.workspace.path, coordinationOptions) !== receipt.workspace_fingerprint) throw new ControlPlaneError("Worktree content or artifacts changed after the result was saved.", "finalization-workspace-changed");
  return continueExecutorResult({ record, workspace: record.workspace, execution: { ...receipt.execution, finalization: { lease, receipt } }, coordinationOptions: { ...coordinationOptions, environment }, executorEnvironment: environment, recovery: true });
}
