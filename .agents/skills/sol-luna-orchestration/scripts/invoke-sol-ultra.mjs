import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getExecutorProfile } from "./executor-profiles.mjs";
import { MODEL_VERBOSITY } from "./model-policy.mjs";
import { assertEpochAssignmentsComplete } from "./control-plane.mjs";
import {
  RoutingVerificationError,
  getSessionRoots,
  readBriefing,
  validateExecutorPayload,
  verifySessionRouting,
} from "./invoke-profile-executor.mjs";
import {
  loadExecutorResultContract,
  validateExecutorResultContract,
} from "./executor-result-contract.mjs";
import {
  AppServerError,
  buildAppServerArguments,
  runAppServerTurn,
} from "./codex-app-server-client.mjs";
import {
  ORCHESTRATION_GENERATION_ENV,
  ORCHESTRATION_LOCK_ENV,
  ORCHESTRATION_ROLE_ENV,
  ULTRA_MODEL,
  ULTRA_CONFIGURED_SERVICE_TIER,
  ULTRA_ORCHESTRATOR_ROLE,
  ULTRA_REASONING_EFFORT,
  ULTRA_SERVICE_TIER,
  acquireUltraLock,
  listUltraExecutorResults,
  registerUltraProcess,
  releaseUltraLock,
  updateUltraLock,
} from "./orchestration-state.mjs";
import {
  ultraLaunchMessage,
  ultraResultMessage,
  writeStatusMessage,
} from "./orchestration-messages.mjs";

export const DEFAULT_ULTRA_SANDBOX_MODE = "read-only";
export const DEFAULT_ULTRA_TIMEOUT_SECONDS = 1_800;

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const EXECUTOR_LAUNCHER_PATH = join(SCRIPT_DIRECTORY, "invoke-profile-executor.mjs");
const MAX_REASON_CHARACTERS = 4_096;

async function releaseCompletedUltraLock({
  cwd,
  lockId,
  generation,
  environment,
  coordinationOptions,
}) {
  await assertEpochAssignmentsComplete(cwd, lockId, generation, {
    ...coordinationOptions,
    environment,
  });
  await releaseUltraLock({
    cwd,
    lockId,
    generation,
    ...coordinationOptions,
    environment,
  });
}

export class UltraInvocationError extends Error {
  constructor(message) {
    super(message);
    this.name = "UltraInvocationError";
  }
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function requireOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UltraInvocationError(`${option} requires a value.`);
  }
  return value;
}

export function parseUltraArguments(argv, baseDirectory = process.cwd()) {
  const parsed = {
    cwd: resolve(baseDirectory),
    reason: null,
    confirmed: false,
    sandboxMode: DEFAULT_ULTRA_SANDBOX_MODE,
    timeoutSeconds: DEFAULT_ULTRA_TIMEOUT_SECONDS,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (
      ![
        "--cwd",
        "--reason",
        "--confirm-exclusive-takeover",
        "--sandbox",
        "--timeout-seconds",
      ].includes(option)
    ) {
      throw new UltraInvocationError(`Unknown option: ${option}`);
    }
    if (seen.has(option)) {
      throw new UltraInvocationError(`Duplicate option: ${option}`);
    }
    seen.add(option);
    if (option === "--confirm-exclusive-takeover") {
      parsed.confirmed = true;
      continue;
    }
    const value = requireOptionValue(argv, index, option);
    index += 1;
    if (option === "--cwd") {
      parsed.cwd = resolve(baseDirectory, value);
    } else if (option === "--reason") {
      if (value.trim().length === 0 || value.length > MAX_REASON_CHARACTERS) {
        throw new UltraInvocationError(
          `--reason must contain between 1 and ${MAX_REASON_CHARACTERS} characters.`,
        );
      }
      parsed.reason = value.trim();
    } else if (option === "--sandbox") {
      if (value === "danger-full-access") {
        throw new UltraInvocationError("danger-full-access is prohibited for Ultra takeover.");
      }
      if (!["read-only", "workspace-write"].includes(value)) {
        throw new UltraInvocationError("--sandbox must be read-only or workspace-write.");
      }
      parsed.sandboxMode = value;
    } else {
      const timeoutSeconds = Number(value);
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) {
        throw new UltraInvocationError(
          "--timeout-seconds must be an integer between 1 and 86400.",
        );
      }
      parsed.timeoutSeconds = timeoutSeconds;
    }
  }
  if (parsed.reason === null) {
    throw new UltraInvocationError("--reason is required.");
  }
  if (!parsed.confirmed) {
    throw new UltraInvocationError("--confirm-exclusive-takeover is required.");
  }
  return parsed;
}

export function createUltraDeveloperInstructions(lockId, generation) {
  return [
    `CODEX_ORCHESTRATION_ROLE=${ULTRA_ORCHESTRATOR_ROLE}`,
    `CODEX_ORCHESTRATION_LOCK_ID=${lockId}`,
    `CODEX_ORCHESTRATION_GENERATION=${generation}`,
    `Act as the exclusive ${ULTRA_MODEL} Ultra root orchestrator for the supplied briefing.`,
    "Own planning, bounded delegation, integration, verification, and the terminal result while the repository lock is active.",
    "Do not use native spawn_agent or any native multi-agent tool and do not start another Ultra takeover.",
    `Delegate only through node ${JSON.stringify(EXECUTOR_LAUNCHER_PATH)} --profile explore|implement-lite|playwright|implement|review with a bounded briefing on stdin.`,
    "Use only useful independent executor scopes, respect the verified Luna and advanced capacity pools, and never overlap write roots.",
    "Use read-only executors by default. Every implement-lite or implement assignment requires workspace-write plus at least one explicit --write-root and runs in a controller-created isolated worktree.",
    `Use node ${JSON.stringify(resolve(SCRIPT_DIRECTORY, "orchestration-control.mjs"))} to claim, review, approve, integrate, complete explicit delivery, acknowledge, archive, retry, abandon, and clean durable assignments with exact state revisions.`,
    "New writer assignments follow the configured automatic-delivery default. An explicit user boundary against commits or pushes takes precedence, so pass --delivery manual for that assignment. Explicit commit or push overrides still require the exact message and destination. The controller never force-pushes.",
    "Do not return while an assignment from this lock id and generation remains unfinished. Accepted candidates require every configured gate and completed delivery; work that cannot finish must be explicitly archived and abandoned.",
    "Do not alter approval policy, sandbox policy, orchestration configuration, or use bypasses.",
    "Preserve unrelated changes and do not exceed the authority granted in the original briefing.",
    "Always include operator_requests in the result. Use an empty array unless status is blocked and operator input is required.",
    "Return only the result required by the supplied JSON schema.",
  ].join("\n");
}

export function buildUltraAppServerArguments() {
  return buildAppServerArguments({
    fastMode: false,
    configuredServiceTier: ULTRA_CONFIGURED_SERVICE_TIER,
    modelVerbosity: MODEL_VERBOSITY,
  });
}

export function createStableUltraResult({
  status,
  lockId = null,
  generation = null,
  threadId = null,
  model = null,
  reasoningEffort = null,
  serviceTier = null,
  routingVerified = false,
  sandboxMode = DEFAULT_ULTRA_SANDBOX_MODE,
  summary,
  changedFiles = [],
  executors = [],
  checks = [],
  blockers = [],
  warnings = [],
}) {
  return {
    status,
    mode: "ultra",
    lock_id: lockId,
    generation,
    thread_id: threadId,
    model,
    reasoning_effort: reasoningEffort,
    service_tier: serviceTier,
    routing_verified: routingVerified,
    sandbox_mode: sandboxMode,
    summary,
    changed_files: [...changedFiles],
    executors: executors.map((executor) => ({ ...executor })),
    checks: [...checks],
    blockers: uniqueStrings(blockers),
    warnings: uniqueStrings(warnings),
  };
}

function validateUltraPayload(payload, sandboxMode) {
  const validated = validateExecutorPayload(payload);
  if (sandboxMode === "read-only" && validated.changed_files.length > 0) {
    throw new UltraInvocationError("Read-only Ultra takeover must return empty changed_files.");
  }
  return validated;
}

function validateUltraExecutors(executors) {
  for (const executor of executors) {
    const profile = getExecutorProfile(executor.profile);
    if (
      profile === null ||
      !["completed", "blocked", "failed"].includes(executor.status) ||
      typeof executor.thread_id !== "string" ||
      executor.model !== profile.model ||
      executor.reasoning_effort !== profile.reasoningEffort ||
      executor.service_tier !== profile.serviceTier ||
      executor.routing_verified !== true
    ) {
      throw new UltraInvocationError("Ultra takeover contains an unverified executor result.");
    }
  }
  return executors;
}

function failureResult(message, options, details = {}) {
  return {
    result: createStableUltraResult({
      status: "failed",
      lockId: details.lockId ?? null,
      generation: details.generation ?? null,
      threadId: details.threadId ?? null,
      model: details.model ?? null,
      reasoningEffort: details.reasoningEffort ?? null,
      serviceTier: details.serviceTier ?? null,
      sandboxMode: options.sandboxMode,
      summary: message,
      executors: details.executors ?? [],
      blockers: [message],
      warnings: details.warnings ?? [],
    }),
    exitCode: 2,
  };
}

async function markRecoveryRequired(
  options,
  lockId,
  generation,
  threadId,
  environment,
  coordinationOptions,
) {
  try {
    await updateUltraLock({
      cwd: options.cwd,
      lockId,
      generation,
      state: "recovery-required",
      threadId,
      ...coordinationOptions,
      environment,
    });
    return null;
  } catch (error) {
    return `Failed to mark the Ultra lock recovery-required: ${error.message}`;
  }
}

export async function invokeUltra({
  briefing,
  options,
  command = "codex",
  environment = process.env,
  sessionRoots = getSessionRoots(environment),
  signal,
  appServerRunner = runAppServerTurn,
  outputContractLoader = loadExecutorResultContract,
  coordinationOptions = {},
}) {
  if (typeof briefing !== "string" || briefing.trim().length === 0) {
    throw new UltraInvocationError("An Ultra takeover briefing is required.");
  }
  const workingDirectory = await stat(options.cwd);
  if (!workingDirectory.isDirectory()) {
    throw new UltraInvocationError(`Ultra cwd is not a directory: ${options.cwd}`);
  }
  const outputContract = validateExecutorResultContract(await outputContractLoader());
  const lock = await acquireUltraLock({
    cwd: options.cwd,
    reason: options.reason,
    sandboxMode: options.sandboxMode,
    ...coordinationOptions,
    environment,
  });
  let threadId = null;
  let actualModel = null;
  let actualReasoningEffort = null;
  let actualServiceTier = null;
  let warnings = [];
  try {
    const appServerResult = await appServerRunner({
      command,
      cwd: options.cwd,
      environment: {
        ...environment,
        [ORCHESTRATION_ROLE_ENV]: ULTRA_ORCHESTRATOR_ROLE,
        [ORCHESTRATION_LOCK_ENV]: lock.lock_id,
        [ORCHESTRATION_GENERATION_ENV]: String(lock.generation),
      },
      model: ULTRA_MODEL,
      reasoningEffort: ULTRA_REASONING_EFFORT,
      serviceTier: ULTRA_SERVICE_TIER,
      configuredServiceTier: ULTRA_CONFIGURED_SERVICE_TIER,
      fastMode: false,
      sandboxMode: options.sandboxMode,
      developerInstructions: createUltraDeveloperInstructions(lock.lock_id, lock.generation),
      briefing: briefing.trim(),
      outputSchema: outputContract.schema,
      timeoutMs: options.timeoutSeconds * 1000,
      signal,
      onProcessStarted: async ({ pid }) => {
        await registerUltraProcess({
          cwd: options.cwd,
          lockId: lock.lock_id,
          generation: lock.generation,
          kind: "app-server",
          pid,
          ...coordinationOptions,
          environment,
        });
      },
    });
    threadId = appServerResult.threadId;
    actualModel = appServerResult.model;
    actualReasoningEffort = appServerResult.reasoningEffort;
    actualServiceTier = appServerResult.serviceTier;
    warnings = appServerResult.warnings ?? [];
    if (threadId !== null) {
      await updateUltraLock({
        cwd: options.cwd,
        lockId: lock.lock_id,
        generation: lock.generation,
        threadId,
        ...coordinationOptions,
        environment,
      });
    }
    if (threadId === null) {
      throw new UltraInvocationError("App Server did not return a thread id for Ultra takeover.");
    }
    if (
      actualModel !== ULTRA_MODEL ||
      actualReasoningEffort !== ULTRA_REASONING_EFFORT ||
      actualServiceTier !== ULTRA_SERVICE_TIER
    ) {
      throw new UltraInvocationError(
        `App Server routing mismatch: expected ${ULTRA_MODEL}/${ULTRA_REASONING_EFFORT}/${ULTRA_SERVICE_TIER}, received ${actualModel ?? "null"}/${actualReasoningEffort ?? "null"}/${actualServiceTier ?? "null"}.`,
      );
    }
    const routing = await verifySessionRouting(
      threadId,
      ULTRA_MODEL,
      ULTRA_REASONING_EFFORT,
      { sessionRoots },
    );
    actualModel = routing.model;
    actualReasoningEffort = routing.reasoningEffort;
    const executors = validateUltraExecutors(
      await listUltraExecutorResults({
        cwd: options.cwd,
        lockId: lock.lock_id,
        generation: lock.generation,
        ...coordinationOptions,
        environment,
      }),
    );
    if (appServerResult.blockedReason !== null) {
      const result = createStableUltraResult({
        status: "blocked",
        lockId: lock.lock_id,
        generation: lock.generation,
        threadId,
        model: actualModel,
        reasoningEffort: actualReasoningEffort,
        serviceTier: actualServiceTier,
        routingVerified: true,
        sandboxMode: options.sandboxMode,
        summary: appServerResult.blockedReason,
        executors,
        blockers: [appServerResult.blockedReason],
        warnings,
      });
      await releaseCompletedUltraLock({
        cwd: options.cwd,
        lockId: lock.lock_id,
        generation: lock.generation,
        environment,
        coordinationOptions,
      });
      return { result, exitCode: 1 };
    }
    if (appServerResult.turnStatus !== "completed") {
      const message = `App Server turn ended with status ${appServerResult.turnStatus ?? "unknown"}.`;
      const result = createStableUltraResult({
        status: "failed",
        lockId: lock.lock_id,
        generation: lock.generation,
        threadId,
        model: actualModel,
        reasoningEffort: actualReasoningEffort,
        serviceTier: actualServiceTier,
        routingVerified: true,
        sandboxMode: options.sandboxMode,
        summary: message,
        executors,
        blockers: [message],
        warnings,
      });
      await releaseCompletedUltraLock({
        cwd: options.cwd,
        lockId: lock.lock_id,
        generation: lock.generation,
        environment,
        coordinationOptions,
      });
      return { result, exitCode: 1 };
    }
    const payload = validateUltraPayload(
      JSON.parse(appServerResult.finalResponse),
      options.sandboxMode,
    );
    const result = createStableUltraResult({
      status: payload.status,
      lockId: lock.lock_id,
      generation: lock.generation,
      threadId,
      model: actualModel,
      reasoningEffort: actualReasoningEffort,
      serviceTier: actualServiceTier,
      routingVerified: true,
      sandboxMode: options.sandboxMode,
      summary: payload.summary,
      changedFiles: payload.changed_files,
      executors,
      checks: payload.checks,
      blockers: payload.blockers,
      warnings: [...payload.warnings, ...warnings],
    });
    await releaseCompletedUltraLock({
      cwd: options.cwd,
      lockId: lock.lock_id,
      generation: lock.generation,
      environment,
      coordinationOptions,
    });
    return { result, exitCode: result.status === "completed" ? 0 : 1 };
  } catch (error) {
    if (error instanceof AppServerError) {
      threadId = error.threadId ?? threadId;
      actualModel = error.actualModel ?? actualModel;
      actualReasoningEffort = error.actualReasoningEffort ?? actualReasoningEffort;
      actualServiceTier = error.actualServiceTier ?? actualServiceTier;
      if (error.stderr) {
        warnings.push(error.stderr);
      }
    }
    if (error instanceof RoutingVerificationError) {
      actualModel = error.actualModel ?? actualModel;
      actualReasoningEffort = error.actualReasoningEffort ?? actualReasoningEffort;
      actualServiceTier = error.actualServiceTier ?? actualServiceTier;
    }
    const recoveryWarning = await markRecoveryRequired(
      options,
      lock.lock_id,
      lock.generation,
      threadId,
      environment,
      coordinationOptions,
    );
    const message = error instanceof Error ? error.message : String(error);
    return failureResult(message, options, {
      lockId: lock.lock_id,
      generation: lock.generation,
      threadId,
      model: actualModel,
      reasoningEffort: actualReasoningEffort,
      serviceTier: actualServiceTier,
      warnings: [...warnings, recoveryWarning].filter(Boolean),
    });
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options = {
    cwd: process.cwd(),
    reason: null,
    confirmed: false,
    sandboxMode: DEFAULT_ULTRA_SANDBOX_MODE,
    timeoutSeconds: DEFAULT_ULTRA_TIMEOUT_SECONDS,
  };
  const abortController = new AbortController();
  const interrupt = () => abortController.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    options = parseUltraArguments(argv);
    writeStatusMessage(
      ultraLaunchMessage({
        model: ULTRA_MODEL,
        reasoningEffort: ULTRA_REASONING_EFFORT,
        serviceTier: ULTRA_SERVICE_TIER,
        sandboxMode: options.sandboxMode,
      }),
      process.stderr,
      { colorCode: 91 },
    );
    const execution = await invokeUltra({
      briefing: await readBriefing(),
      options,
      signal: abortController.signal,
    });
    writeStatusMessage(ultraResultMessage(execution.result), process.stderr, {
      colorCode: 91,
    });
    process.stdout.write(`${JSON.stringify(execution.result)}\n`);
    return execution.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = failureResult(message, options);
    writeStatusMessage(ultraResultMessage(failure.result));
    process.stdout.write(`${JSON.stringify(failure.result)}\n`);
    return failure.exitCode;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
