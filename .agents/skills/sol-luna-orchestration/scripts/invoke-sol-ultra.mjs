import { randomUUID } from "node:crypto";
import { access, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getExecutorProfile } from "./executor-profiles.mjs";
import {
  RESULT_SCHEMA_PATH,
  RoutingVerificationError,
  getSessionRoots,
  readBriefing,
  runProcess,
  validateExecutorPayload,
  verifySessionRouting,
} from "./invoke-profile-executor.mjs";
import {
  ORCHESTRATION_LOCK_ENV,
  ORCHESTRATION_ROLE_ENV,
  SOL_MODEL_VERBOSITY,
  ULTRA_MODEL,
  ULTRA_CONFIGURED_SERVICE_TIER,
  ULTRA_ORCHESTRATOR_ROLE,
  ULTRA_REASONING_EFFORT,
  ULTRA_SERVICE_TIER,
  acquireUltraLock,
  listUltraExecutorResults,
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
        throw new UltraInvocationError("danger-full-access is prohibited for Sol Ultra takeover.");
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

export function createUltraDeveloperInstructions(lockId) {
  return [
    `CODEX_ORCHESTRATION_ROLE=${ULTRA_ORCHESTRATOR_ROLE}`,
    `CODEX_ORCHESTRATION_LOCK_ID=${lockId}`,
    "Act as the exclusive GPT-5.6 Sol Ultra root orchestrator for the supplied briefing.",
    "Own planning, bounded delegation, integration, verification, and the terminal result while the repository lock is active.",
    "Do not use native spawn_agent or any native multi-agent tool and do not start another Ultra takeover.",
    `Delegate only through node ${JSON.stringify(EXECUTOR_LAUNCHER_PATH)} --profile explore|implement-lite|playwright|implement|review with a bounded briefing on stdin.`,
    "Use only useful independent executor scopes, respect the verified Luna and Sol capacity pools, and serialize overlapping writes.",
    "Use read-only executors by default and workspace-write only for explicitly assigned implement-lite or implement scopes.",
    "Do not alter approval policy, sandbox policy, orchestration configuration, or use bypasses.",
    "Preserve unrelated changes and do not exceed the authority granted in the original briefing.",
    "Return only the result required by the supplied JSON schema.",
  ].join("\n");
}

export function buildUltraCodexArguments({
  cwd,
  sandboxMode,
  lockId,
  outputPath,
  schemaPath = RESULT_SCHEMA_PATH,
  developerInstructions,
}) {
  const resolvedInstructions = developerInstructions ?? createUltraDeveloperInstructions(lockId);
  return [
    "-m",
    ULTRA_MODEL,
    "-c",
    `model_reasoning_effort=${JSON.stringify(ULTRA_REASONING_EFFORT)}`,
    "-c",
    `model_verbosity=${JSON.stringify(SOL_MODEL_VERBOSITY)}`,
    "-c",
    `service_tier=${JSON.stringify(ULTRA_CONFIGURED_SERVICE_TIER)}`,
    "-c",
    "features.fast_mode=false",
    "-c",
    "features.multi_agent=false",
    "-c",
    "agents.max_depth=1",
    "-c",
    "agents.max_threads=1",
    "-c",
    `developer_instructions=${JSON.stringify(resolvedInstructions)}`,
    "-C",
    cwd,
    "-s",
    sandboxMode,
    "exec",
    "--json",
    "--output-schema",
    schemaPath,
    "-o",
    outputPath,
    "-",
  ];
}

export function createStableUltraResult({
  status,
  lockId = null,
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

async function markRecoveryRequired(options, lockId, threadId, environment, coordinationOptions) {
  try {
    await updateUltraLock({
      cwd: options.cwd,
      lockId,
      state: "recovery-required",
      threadId,
      environment,
      ...coordinationOptions,
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
  processRunner = runProcess,
  coordinationOptions = {},
}) {
  if (typeof briefing !== "string" || briefing.trim().length === 0) {
    throw new UltraInvocationError("An Ultra takeover briefing is required.");
  }
  const workingDirectory = await stat(options.cwd);
  if (!workingDirectory.isDirectory()) {
    throw new UltraInvocationError(`Ultra cwd is not a directory: ${options.cwd}`);
  }
  await access(RESULT_SCHEMA_PATH);
  const lock = await acquireUltraLock({
    cwd: options.cwd,
    reason: options.reason,
    sandboxMode: options.sandboxMode,
    environment,
    ...coordinationOptions,
  });
  const outputPath = join(tmpdir(), `sol-ultra-${process.pid}-${randomUUID()}.json`);
  const args = buildUltraCodexArguments({
    cwd: options.cwd,
    sandboxMode: options.sandboxMode,
    lockId: lock.lock_id,
    outputPath,
  });
  let threadId = null;
  let actualModel = null;
  let actualReasoningEffort = null;
  let actualServiceTier = null;
  let warnings = [];
  try {
    const processResult = await processRunner(command, args, {
      input: `${briefing.trim()}\n`,
      timeoutMs: options.timeoutSeconds * 1000,
      cwd: options.cwd,
      environment: {
        ...environment,
        [ORCHESTRATION_ROLE_ENV]: ULTRA_ORCHESTRATOR_ROLE,
        [ORCHESTRATION_LOCK_ENV]: lock.lock_id,
      },
      signal,
    });
    threadId = processResult.threadId;
    warnings = processResult.warnings;
    if (threadId !== null) {
      await updateUltraLock({
        cwd: options.cwd,
        lockId: lock.lock_id,
        threadId,
        environment,
        ...coordinationOptions,
      });
    }
    if (processResult.timedOut || processResult.aborted) {
      throw new UltraInvocationError(
        processResult.timedOut
          ? `Sol Ultra takeover timed out after ${options.timeoutSeconds} seconds.`
          : "Sol Ultra takeover was interrupted.",
      );
    }
    if (processResult.exitCode !== 0) {
      throw new UltraInvocationError(
        processResult.stderr || `Codex exited with code ${processResult.exitCode}.`,
      );
    }
    if (threadId === null) {
      throw new UltraInvocationError("Codex did not emit a thread_id for Sol Ultra takeover.");
    }
    const routing = await verifySessionRouting(
      threadId,
      ULTRA_MODEL,
      ULTRA_REASONING_EFFORT,
      ULTRA_SERVICE_TIER,
      { sessionRoots },
    );
    actualModel = routing.model;
    actualReasoningEffort = routing.reasoningEffort;
    actualServiceTier = routing.serviceTier;
    const payload = validateUltraPayload(
      JSON.parse(await readFile(outputPath, "utf8")),
      options.sandboxMode,
    );
    const executors = validateUltraExecutors(
      await listUltraExecutorResults({
        cwd: options.cwd,
        lockId: lock.lock_id,
        environment,
        ...coordinationOptions,
      }),
    );
    const result = createStableUltraResult({
      status: payload.status,
      lockId: lock.lock_id,
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
    await releaseUltraLock({
      cwd: options.cwd,
      lockId: lock.lock_id,
      environment,
      ...coordinationOptions,
    });
    return { result, exitCode: result.status === "completed" ? 0 : 1 };
  } catch (error) {
    if (error instanceof RoutingVerificationError) {
      actualModel = error.actualModel ?? null;
      actualReasoningEffort = error.actualReasoningEffort ?? null;
      actualServiceTier = error.actualServiceTier ?? null;
    }
    const recoveryWarning = await markRecoveryRequired(
      options,
      lock.lock_id,
      threadId,
      environment,
      coordinationOptions,
    );
    const message = error instanceof Error ? error.message : String(error);
    return failureResult(message, options, {
      lockId: lock.lock_id,
      threadId,
      model: actualModel,
      reasoningEffort: actualReasoningEffort,
      serviceTier: actualServiceTier,
      warnings: [...warnings, recoveryWarning].filter(Boolean),
    });
  } finally {
    await rm(outputPath, { force: true });
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
