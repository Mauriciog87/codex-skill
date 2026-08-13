import { spawn as spawnChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  EXECUTOR_PROFILE_NAMES,
  getExecutorProfile,
} from "./executor-profiles.mjs";
import {
  ORCHESTRATION_ROLE_ENV,
  SOL_MODEL_VERBOSITY,
  abandonExecutorRun,
  beginExecutorRun,
  finishExecutorRun,
} from "./orchestration-state.mjs";
import {
  executorLaunchMessage,
  executorResultMessage,
  writeStatusMessage,
} from "./orchestration-messages.mjs";

export const EXECUTOR_MODEL = "gpt-5.6-sol";
export const DEFAULT_SANDBOX_MODE = "read-only";
export const DEFAULT_TIMEOUT_SECONDS = 900;

const MAX_BRIEFING_BYTES = 1_048_576;
const MAX_DIAGNOSTIC_CHARACTERS = 131_072;
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const RESULT_SCHEMA_PATH = resolve(
  SCRIPT_DIRECTORY,
  "..",
  "references",
  "executor-result.schema.json",
);

export class ExecutorInvocationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExecutorInvocationError";
  }
}

export class ExecutorConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExecutorConfigurationError";
  }
}

export class RoutingVerificationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RoutingVerificationError";
    this.actualModel = details.actualModel ?? null;
    this.actualReasoningEffort = details.actualReasoningEffort ?? null;
    this.rolloutPath = details.rolloutPath ?? null;
  }
}

function appendLimited(current, value) {
  const combined = `${current}${value}`;
  return combined.length <= MAX_DIAGNOSTIC_CHARACTERS
    ? combined
    : combined.slice(-MAX_DIAGNOSTIC_CHARACTERS);
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function requireOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ExecutorInvocationError(`${option} requires a value.`);
  }
  return value;
}

export function parseArguments(argv, baseDirectory = process.cwd()) {
  const parsed = {
    profile: null,
    cwd: resolve(baseDirectory),
    sandboxMode: DEFAULT_SANDBOX_MODE,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  };
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!["--profile", "--cwd", "--sandbox", "--timeout-seconds"].includes(option)) {
      throw new ExecutorInvocationError(`Unknown option: ${option}`);
    }
    if (seen.has(option)) {
      throw new ExecutorInvocationError(`Duplicate option: ${option}`);
    }
    seen.add(option);
    const value = requireOptionValue(argv, index, option);
    index += 1;

    if (option === "--profile") {
      if (!EXECUTOR_PROFILE_NAMES.includes(value)) {
        throw new ExecutorInvocationError(
          `--profile must be one of: ${EXECUTOR_PROFILE_NAMES.join(", ")}.`,
        );
      }
      parsed.profile = value;
    } else if (option === "--cwd") {
      parsed.cwd = resolve(baseDirectory, value);
    } else if (option === "--sandbox") {
      if (value === "danger-full-access") {
        throw new ExecutorInvocationError("danger-full-access is prohibited for Sol executors.");
      }
      if (!["read-only", "workspace-write"].includes(value)) {
        throw new ExecutorInvocationError(
          "--sandbox must be read-only or workspace-write.",
        );
      }
      parsed.sandboxMode = value;
    } else {
      const timeoutSeconds = Number(value);
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) {
        throw new ExecutorInvocationError(
          "--timeout-seconds must be an integer between 1 and 86400.",
        );
      }
      parsed.timeoutSeconds = timeoutSeconds;
    }
  }

  if (parsed.profile === null) {
    throw new ExecutorInvocationError("--profile is required.");
  }
  const profile = getExecutorProfile(parsed.profile);
  if (parsed.sandboxMode !== profile.sandboxMode) {
    throw new ExecutorInvocationError(
      `Profile ${profile.name} requires --sandbox ${profile.sandboxMode}.`,
    );
  }

  return parsed;
}

function requireExecutorProfile(name, sandboxMode) {
  const profile = getExecutorProfile(name);
  if (profile === null) {
    throw new ExecutorInvocationError(
      `Executor profile must be one of: ${EXECUTOR_PROFILE_NAMES.join(", ")}.`,
    );
  }
  if (sandboxMode !== profile.sandboxMode) {
    throw new ExecutorInvocationError(
      `Profile ${profile.name} requires --sandbox ${profile.sandboxMode}.`,
    );
  }
  return profile;
}

export function createExecutorDeveloperInstructions(profileName) {
  const profile = getExecutorProfile(profileName);
  if (profile === null) {
    throw new ExecutorInvocationError(
      `Executor profile must be one of: ${EXECUTOR_PROFILE_NAMES.join(", ")}.`,
    );
  }
  return [
    "CODEX_ORCHESTRATION_ROLE=executor",
    `CODEX_EXECUTOR_PROFILE=${profile.name}`,
    `Act as a bounded GPT-5.6 Sol ${profile.name} executor at ${profile.reasoningEffort} reasoning, not as the root orchestrator.`,
    "Do not invoke the sol-sol-orchestration skill, delegate, or launch another Codex session.",
    "Complete only the supplied briefing and preserve unrelated changes.",
    "Do not alter orchestration policy, approval policy, or sandbox configuration, and do not use bypasses.",
    "Return only the result required by the supplied JSON schema.",
    "Use completed only when the assigned work and requested checks succeeded; otherwise use blocked or failed.",
    ...profile.instructions,
  ].join("\n");
}

export function buildCodexArguments({
  profile: profileName,
  cwd,
  sandboxMode,
  schemaPath = RESULT_SCHEMA_PATH,
  outputPath,
  developerInstructions,
}) {
  const profile = requireExecutorProfile(profileName, sandboxMode);
  const resolvedDeveloperInstructions =
    developerInstructions ?? createExecutorDeveloperInstructions(profile.name);
  return [
    "-m",
    EXECUTOR_MODEL,
    "-c",
    `model_reasoning_effort=${JSON.stringify(profile.reasoningEffort)}`,
    "-c",
    `model_verbosity=${JSON.stringify(SOL_MODEL_VERBOSITY)}`,
    "-c",
    "features.multi_agent=false",
    "-c",
    "agents.max_depth=1",
    "-c",
    "agents.max_threads=1",
    "-c",
    `developer_instructions=${JSON.stringify(resolvedDeveloperInstructions)}`,
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

function recordCodexEvent(line, state) {
  if (line.trim().length === 0) {
    return;
  }

  let event;
  try {
    event = JSON.parse(line);
  } catch {
    state.warnings.push(`Codex emitted non-JSON output: ${line.slice(0, 500)}`);
    return;
  }

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    state.threadId = event.thread_id;
  }
  if (event.type === "error" && typeof event.message === "string") {
    state.warnings.push(event.message);
  }
  if (event.type === "turn.failed") {
    const message = event.error?.message ?? event.message;
    if (typeof message === "string") {
      state.warnings.push(message);
    }
  }
  if (event.type === "item.completed" && event.item?.type === "error") {
    const message = event.item.message ?? event.item.text;
    if (typeof message === "string") {
      state.warnings.push(message);
    }
  }
}

export async function runProcess(
  command,
  args,
  {
    input = "",
    timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000,
    cwd,
    environment = process.env,
    signal,
    spawnImplementation = spawnChildProcess,
  } = {},
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ExecutorInvocationError("timeoutMs must be a positive number.");
  }

  return await new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawnImplementation(command, args, {
        cwd,
        env: environment,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      rejectPromise(
        new ExecutorConfigurationError(`Unable to start ${command}: ${error.message}`),
      );
      return;
    }

    const state = { threadId: null, warnings: [] };
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let forceKillTimer;

    const lineReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lineReader.on("line", (line) => {
      stdout = appendLimited(stdout, `${line}\n`);
      recordCodexEvent(line, state);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString("utf8"));
    });
    child.stdin.on("error", () => {});

    const terminate = (reason) => {
      if (settled || child.killed) {
        return;
      }
      timedOut = reason === "timeout";
      aborted = reason === "abort";
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 1000);
      forceKillTimer.unref();
    };

    const abortListener = () => terminate("abort");
    if (signal?.aborted) {
      terminate("abort");
    } else {
      signal?.addEventListener("abort", abortListener, { once: true });
    }

    const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
    timeout.unref();

    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abortListener);
    };

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      rejectPromise(
        new ExecutorConfigurationError(`Unable to run ${command}: ${error.message}`),
      );
    });

    child.once("close", (code, processSignal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolvePromise({
        exitCode: code,
        signal: processSignal,
        timedOut,
        aborted,
        threadId: state.threadId,
        warnings: uniqueStrings(state.warnings),
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });

    child.stdin.end(input);
  });
}

export async function readBriefing(stream = process.stdin) {
  const chunks = [];
  let bytes = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BRIEFING_BYTES) {
      throw new ExecutorInvocationError(
        `The executor briefing exceeds ${MAX_BRIEFING_BYTES} bytes.`,
      );
    }
    chunks.push(buffer);
  }

  const briefing = Buffer.concat(chunks).toString("utf8").trim();
  if (briefing.length === 0) {
    throw new ExecutorInvocationError("An executor briefing is required on stdin.");
  }
  return briefing;
}

export function getSessionRoots(environment = process.env) {
  const codexHome = environment.CODEX_HOME
    ? resolve(environment.CODEX_HOME)
    : join(resolve(environment.HOME ?? environment.USERPROFILE ?? homedir()), ".codex");
  return [join(codexHome, "sessions"), join(codexHome, "archived_sessions")];
}

async function collectRolloutCandidates(directory, threadId, candidates) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectRolloutCandidates(entryPath, threadId, candidates);
    } else if (entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith(".jsonl")) {
      candidates.push(entryPath);
    }
  }
}

export async function findRolloutFile(threadId, sessionRoots = getSessionRoots()) {
  const candidates = [];
  for (const sessionRoot of sessionRoots) {
    await collectRolloutCandidates(sessionRoot, threadId, candidates);
  }
  if (candidates.length === 0) {
    return null;
  }

  const datedCandidates = await Promise.all(
    candidates.map(async (candidate) => ({
      path: candidate,
      modifiedAt: (await stat(candidate)).mtimeMs,
    })),
  );
  datedCandidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return datedCandidates[0].path;
}

async function readTurnContexts(rolloutPath) {
  const contexts = [];
  const lineReader = createInterface({
    input: createReadStream(rolloutPath),
    crlfDelay: Infinity,
  });

  for await (const line of lineReader) {
    if (!line.includes('"turn_context"')) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      throw new ExecutorConfigurationError(
        `Invalid turn_context JSON in ${rolloutPath}: ${error.message}`,
      );
    }
    if (entry.type === "turn_context") {
      contexts.push({
        model: entry.payload?.model ?? null,
        reasoningEffort: entry.payload?.effort ?? null,
      });
    }
  }

  return contexts;
}

function wait(delayMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

export async function verifySessionRouting(
  threadId,
  expectedModel,
  expectedReasoningEffort,
  { sessionRoots = getSessionRoots(), attempts = 20, retryDelayMs = 100 } = {},
) {
  let rolloutPath = null;
  let contexts = [];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    rolloutPath = await findRolloutFile(threadId, sessionRoots);
    if (rolloutPath !== null) {
      contexts = await readTurnContexts(rolloutPath);
      if (contexts.length > 0) {
        break;
      }
    }
    if (attempt + 1 < attempts) {
      await wait(retryDelayMs);
    }
  }

  if (rolloutPath === null) {
    throw new RoutingVerificationError(`No rollout was found for thread ${threadId}.`);
  }
  if (contexts.length === 0) {
    throw new RoutingVerificationError(
      `No turn_context metadata was found for thread ${threadId}.`,
      { rolloutPath },
    );
  }

  const mismatchedContext = contexts.find(
    (context) =>
      context.model !== expectedModel ||
      context.reasoningEffort !== expectedReasoningEffort,
  );
  const actualContext = mismatchedContext ?? contexts.at(-1);

  if (mismatchedContext !== undefined) {
    throw new RoutingVerificationError(
      `Routing mismatch for thread ${threadId}: expected ${expectedModel}/${expectedReasoningEffort}, recorded ${actualContext.model}/${actualContext.reasoningEffort}.`,
      {
        actualModel: actualContext.model,
        actualReasoningEffort: actualContext.reasoningEffort,
        rolloutPath,
      },
    );
  }

  return {
    rolloutPath,
    model: actualContext.model,
    reasoningEffort: actualContext.reasoningEffort,
    contextCount: contexts.length,
  };
}

function assertStringArray(value, property) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ExecutorConfigurationError(`${property} must be an array of strings.`);
  }
}

export function validateExecutorPayload(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutorConfigurationError("The executor result must be a JSON object.");
  }

  const allowedProperties = [
    "status",
    "summary",
    "changed_files",
    "checks",
    "blockers",
    "warnings",
  ];
  const unexpectedProperties = Object.keys(value).filter(
    (property) => !allowedProperties.includes(property),
  );
  if (unexpectedProperties.length > 0) {
    throw new ExecutorConfigurationError(
      `Unexpected executor result properties: ${unexpectedProperties.join(", ")}.`,
    );
  }
  if (!["completed", "blocked", "failed"].includes(value.status)) {
    throw new ExecutorConfigurationError(
      "status must be completed, blocked, or failed.",
    );
  }
  if (typeof value.summary !== "string" || value.summary.trim().length === 0) {
    throw new ExecutorConfigurationError("summary must be a non-empty string.");
  }
  assertStringArray(value.changed_files, "changed_files");
  assertStringArray(value.checks, "checks");
  assertStringArray(value.blockers, "blockers");
  assertStringArray(value.warnings, "warnings");

  return {
    status: value.status,
    summary: value.summary,
    changed_files: [...value.changed_files],
    checks: [...value.checks],
    blockers: [...value.blockers],
    warnings: [...value.warnings],
  };
}

function validateProfilePayload(profileName, payload) {
  if (["explore", "review"].includes(profileName) && payload.changed_files.length > 0) {
    throw new ExecutorConfigurationError(
      `Profile ${profileName} must return an empty changed_files array.`,
    );
  }
  if (profileName !== "review") {
    return payload;
  }

  const verdict = /^(APPROVE|COMMENT|REQUEST_CHANGES)(?=$|[\s:—–-])/.exec(
    payload.summary,
  )?.[1];
  if (verdict === undefined) {
    throw new ExecutorConfigurationError(
      "Review summary must begin with APPROVE, COMMENT, or REQUEST_CHANGES.",
    );
  }
  if (verdict === "REQUEST_CHANGES") {
    if (payload.status !== "blocked" || payload.blockers.length === 0) {
      throw new ExecutorConfigurationError(
        "REQUEST_CHANGES requires blocked status and at least one blocker.",
      );
    }
  } else if (payload.status !== "completed" || payload.blockers.length > 0) {
    throw new ExecutorConfigurationError(
      `${verdict} requires completed status and no blockers.`,
    );
  }
  return payload;
}

export function createStableResult({
  status,
  profile = null,
  threadId = null,
  model = null,
  reasoningEffort = null,
  routingVerified = false,
  sandboxMode = DEFAULT_SANDBOX_MODE,
  summary,
  changedFiles = [],
  checks = [],
  blockers = [],
  warnings = [],
}) {
  return {
    status,
    profile,
    thread_id: threadId,
    model,
    reasoning_effort: reasoningEffort,
    routing_verified: routingVerified,
    sandbox_mode: sandboxMode,
    summary,
    changed_files: [...changedFiles],
    checks: [...checks],
    blockers: uniqueStrings(blockers),
    warnings: uniqueStrings(warnings),
  };
}

export function determineExitCode({
  status,
  codexExitCode = 0,
  routingVerified = true,
  configurationValid = true,
  timedOut = false,
}) {
  if (!configurationValid || !routingVerified || timedOut) {
    return 2;
  }
  if (codexExitCode !== 0 || status !== "completed") {
    return 1;
  }
  return 0;
}

function configurationFailure(message, options, details = {}) {
  return {
    result: createStableResult({
      status: "failed",
      profile: options.profile ?? null,
      threadId: details.threadId ?? null,
      model: details.model ?? null,
      reasoningEffort: details.reasoningEffort ?? null,
      sandboxMode: options.sandboxMode,
      summary: message,
      blockers: [message],
      warnings: details.warnings ?? [],
    }),
    exitCode: 2,
  };
}

async function runExecutor({
  briefing,
  options,
  command = "codex",
  environment = process.env,
  sessionRoots = getSessionRoots(environment),
  signal,
  processRunner = runProcess,
}) {
  if (typeof briefing !== "string" || briefing.trim().length === 0) {
    throw new ExecutorInvocationError("An executor briefing is required.");
  }
  const profile = requireExecutorProfile(options.profile, options.sandboxMode);

  let workingDirectory;
  try {
    workingDirectory = await stat(options.cwd);
    await access(RESULT_SCHEMA_PATH);
  } catch (error) {
    throw new ExecutorConfigurationError(error.message);
  }
  if (!workingDirectory.isDirectory()) {
    throw new ExecutorInvocationError(`Executor cwd is not a directory: ${options.cwd}`);
  }

  const outputPath = join(
    tmpdir(),
    `sol-sol-executor-${process.pid}-${randomUUID()}.json`,
  );
  const args = buildCodexArguments({
    profile: profile.name,
    cwd: options.cwd,
    sandboxMode: options.sandboxMode,
    outputPath,
  });

  try {
    const processResult = await processRunner(command, args, {
      input: `${briefing.trim()}\n`,
      timeoutMs: options.timeoutSeconds * 1000,
      cwd: options.cwd,
      environment: {
        ...environment,
        [ORCHESTRATION_ROLE_ENV]: "executor",
        CODEX_EXECUTOR_PROFILE: profile.name,
      },
      signal,
    });

    if (processResult.timedOut || processResult.aborted) {
      const message = processResult.timedOut
        ? `Sol executor timed out after ${options.timeoutSeconds} seconds.`
        : "Sol executor was interrupted.";
      return configurationFailure(message, options, {
        threadId: processResult.threadId,
        warnings: processResult.warnings,
      });
    }

    if (processResult.exitCode !== 0) {
      const diagnostic = processResult.stderr || `Codex exited with code ${processResult.exitCode}.`;
      return {
        result: createStableResult({
          status: "failed",
          profile: profile.name,
          threadId: processResult.threadId,
          sandboxMode: options.sandboxMode,
          summary: diagnostic,
          blockers: [diagnostic],
          warnings: processResult.warnings,
        }),
        exitCode: 1,
      };
    }

    if (processResult.threadId === null) {
      return configurationFailure("Codex did not emit a thread_id.", options, {
        warnings: processResult.warnings,
      });
    }

    let routing;
    try {
      routing = await verifySessionRouting(
        processResult.threadId,
        EXECUTOR_MODEL,
        profile.reasoningEffort,
        { sessionRoots },
      );
    } catch (error) {
      if (!(error instanceof RoutingVerificationError)) {
        throw error;
      }
      return configurationFailure(error.message, options, {
        threadId: processResult.threadId,
        model: error.actualModel ?? null,
        reasoningEffort: error.actualReasoningEffort ?? null,
        warnings: processResult.warnings,
      });
    }

    let payload;
    try {
      payload = validateProfilePayload(
        profile.name,
        validateExecutorPayload(JSON.parse(await readFile(outputPath, "utf8"))),
      );
    } catch (error) {
      const message = `Invalid structured executor result: ${error.message}`;
      return configurationFailure(message, options, {
        threadId: processResult.threadId,
        model: routing.model,
        reasoningEffort: routing.reasoningEffort,
        warnings: processResult.warnings,
      });
    }

    const result = createStableResult({
      status: payload.status,
      profile: profile.name,
      threadId: processResult.threadId,
      model: routing.model,
      reasoningEffort: routing.reasoningEffort,
      routingVerified: true,
      sandboxMode: options.sandboxMode,
      summary: payload.summary,
      changedFiles: payload.changed_files,
      checks: payload.checks,
      blockers: payload.blockers,
      warnings: [...payload.warnings, ...processResult.warnings],
    });
    return {
      result,
      exitCode: determineExitCode({
        status: result.status,
        routingVerified: result.routing_verified,
      }),
    };
  } finally {
    await rm(outputPath, { force: true });
  }
}

export async function invokeExecutor(input) {
  const environment = input.environment ?? process.env;
  const profile = requireExecutorProfile(
    input.options.profile,
    input.options.sandboxMode,
  );
  let lease;
  try {
    lease = await beginExecutorRun({
      cwd: input.options.cwd,
      profile: profile.name,
      environment,
      ...(input.coordinationOptions ?? {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return configurationFailure(message, input.options);
  }
  try {
    const execution = await runExecutor({ ...input, environment });
    await finishExecutorRun(lease, execution);
    return execution;
  } catch (error) {
    await abandonExecutorRun(lease, error);
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options = {
    profile: null,
    cwd: process.cwd(),
    sandboxMode: DEFAULT_SANDBOX_MODE,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  };
  const abortController = new AbortController();
  const interrupt = () => abortController.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  try {
    options = parseArguments(argv);
    const briefing = await readBriefing();
    const profile = requireExecutorProfile(options.profile, options.sandboxMode);
    writeStatusMessage(
      executorLaunchMessage({
        profile: profile.name,
        model: EXECUTOR_MODEL,
        reasoningEffort: profile.reasoningEffort,
        sandboxMode: options.sandboxMode,
      }),
    );
    const execution = await invokeExecutor({
      briefing,
      options,
      signal: abortController.signal,
    });
    writeStatusMessage(executorResultMessage(execution.result));
    process.stdout.write(`${JSON.stringify(execution.result)}\n`);
    return execution.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = configurationFailure(message, options);
    writeStatusMessage(executorResultMessage(failure.result));
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
