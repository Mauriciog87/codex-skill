import { spawn as spawnChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  EXECUTOR_PROFILE_NAMES,
  MODEL_VERBOSITY,
  getExecutorProfile,
} from "./executor-profiles.mjs";
import { readDeliveryConfiguration } from "./delivery-configuration.mjs";
import {
  AppServerError,
  buildAppServerArguments,
  runAppServerTurn,
} from "./codex-app-server-client.mjs";
import {
  ORCHESTRATION_ROLE_ENV,
  abandonExecutorRun,
  beginExecutorRun,
  finishExecutorRun,
  registerExecutorProcess,
} from "./orchestration-state.mjs";
import {
  executorLaunchMessage,
  executorResultMessage,
  writeStatusMessage,
} from "./orchestration-messages.mjs";
import {
  RESULT_SCHEMA_PATH,
  loadExecutorResultContract,
  validateExecutorResultContract,
} from "./executor-result-contract.mjs";

export { RESULT_SCHEMA_PATH };

export const DEFAULT_SANDBOX_MODE = "read-only";
export const DEFAULT_TIMEOUT_SECONDS = 900;
export const DEFAULT_CONTROL_PLANE = "v2";
export const DEFAULT_RESULT_FORMAT = "v2";

const MAX_BRIEFING_BYTES = 1_048_576;
const MAX_DIAGNOSTIC_CHARACTERS = 131_072;
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
    this.actualServiceTier = details.actualServiceTier ?? null;
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

function validateDeliveryOptions(parsed, profile) {
  if (parsed.deliveryMode === "manual") {
    if (parsed.commitMessage !== null || parsed.pushRemote !== null || parsed.pushBranch !== null) {
      throw new ExecutorInvocationError("Manual delivery cannot declare commit or push options.");
    }
    return;
  }
  if (profile.workspaceStrategy !== "isolated-worktree") {
    throw new ExecutorInvocationError("Only workspace-write profiles support automatic delivery.");
  }
  if (parsed.commitMessage === null) {
    throw new ExecutorInvocationError("Automatic delivery requires --commit-message.");
  }
  if (parsed.deliveryMode === "push" && (parsed.pushRemote === null || parsed.pushBranch === null)) {
    throw new ExecutorInvocationError("Push delivery requires --push-remote and --push-branch.");
  }
  if (parsed.deliveryMode === "commit" && (parsed.pushRemote !== null || parsed.pushBranch !== null)) {
    throw new ExecutorInvocationError("Commit delivery cannot declare push options.");
  }
}

export function parseArguments(argv, baseDirectory = process.cwd()) {
  const parsed = {
    profile: null,
    cwd: resolve(baseDirectory),
    sandboxMode: DEFAULT_SANDBOX_MODE,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    controlPlane: DEFAULT_CONTROL_PLANE,
    resultFormat: DEFAULT_RESULT_FORMAT,
    assignmentId: null,
    enqueueOnly: false,
    priority: "normal",
    writeRoots: [],
    forbiddenRoots: [],
    requiredChecks: [],
    artifacts: [],
    reviewPolicy: "root",
    operatorApprovalRequired: false,
    allowSymlinks: false,
    allowSubmodules: false,
    candidateId: null,
    deliveryMode: "manual",
    commitMessage: null,
    pushRemote: null,
    pushBranch: null,
  };
  const seen = new Set();
  const repeatable = new Set(["--write-root", "--forbid-root", "--check-json", "--artifact-json"]);
  const booleanOptions = new Set([
    "--enqueue-only",
    "--require-operator-approval",
    "--allow-symlinks",
    "--allow-submodules",
  ]);
  const valueOptions = new Set([
    "--profile",
    "--cwd",
    "--sandbox",
    "--timeout-seconds",
    "--control-plane",
    "--result-format",
    "--assignment-id",
    "--priority",
    "--write-root",
    "--forbid-root",
    "--check-json",
    "--artifact-json",
    "--review-policy",
    "--candidate-id",
    "--delivery",
    "--commit-message",
    "--push-remote",
    "--push-branch",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!valueOptions.has(option) && !booleanOptions.has(option)) {
      throw new ExecutorInvocationError(`Unknown option: ${option}`);
    }
    if (seen.has(option) && !repeatable.has(option)) {
      throw new ExecutorInvocationError(`Duplicate option: ${option}`);
    }
    seen.add(option);
    if (booleanOptions.has(option)) {
      if (option === "--enqueue-only") {
        parsed.enqueueOnly = true;
      } else if (option === "--require-operator-approval") {
        parsed.operatorApprovalRequired = true;
      } else if (option === "--allow-symlinks") {
        parsed.allowSymlinks = true;
      } else {
        parsed.allowSubmodules = true;
      }
      continue;
    }
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
        throw new ExecutorInvocationError("danger-full-access is prohibited for profile executors.");
      }
      if (!["read-only", "workspace-write"].includes(value)) {
        throw new ExecutorInvocationError(
          "--sandbox must be read-only or workspace-write.",
        );
      }
      parsed.sandboxMode = value;
    } else if (option === "--timeout-seconds") {
      const timeoutSeconds = Number(value);
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) {
        throw new ExecutorInvocationError(
          "--timeout-seconds must be an integer between 1 and 86400.",
        );
      }
      parsed.timeoutSeconds = timeoutSeconds;
    } else if (option === "--control-plane") {
      if (!["v1", "v2"].includes(value)) {
        throw new ExecutorInvocationError("--control-plane must be v1 or v2.");
      }
      parsed.controlPlane = value;
    } else if (option === "--result-format") {
      if (!["v1", "v2"].includes(value)) {
        throw new ExecutorInvocationError("--result-format must be v1 or v2.");
      }
      parsed.resultFormat = value;
    } else if (option === "--assignment-id") {
      parsed.assignmentId = value;
    } else if (option === "--priority") {
      if (!["high", "normal", "low"].includes(value)) {
        throw new ExecutorInvocationError("--priority must be high, normal, or low.");
      }
      parsed.priority = value;
    } else if (option === "--write-root") {
      parsed.writeRoots.push(value);
    } else if (option === "--forbid-root") {
      parsed.forbiddenRoots.push(value);
    } else if (option === "--check-json") {
      try {
        parsed.requiredChecks.push(JSON.parse(value));
      } catch (error) {
        throw new ExecutorInvocationError(`--check-json is invalid JSON: ${error.message}`);
      }
    } else if (option === "--artifact-json") {
      try {
        parsed.artifacts.push(JSON.parse(value));
      } catch (error) {
        throw new ExecutorInvocationError(`--artifact-json is invalid JSON: ${error.message}`);
      }
    } else if (option === "--review-policy") {
      if (!["root", "independent"].includes(value)) {
        throw new ExecutorInvocationError("--review-policy must be root or independent.");
      }
      parsed.reviewPolicy = value;
    } else if (option === "--candidate-id") {
      parsed.candidateId = value;
    } else if (option === "--delivery") {
      if (!["manual", "commit", "push"].includes(value)) {
        throw new ExecutorInvocationError("--delivery must be manual, commit, or push.");
      }
      parsed.deliveryMode = value;
    } else if (option === "--commit-message") {
      parsed.commitMessage = value;
    } else if (option === "--push-remote") {
      parsed.pushRemote = value;
    } else {
      parsed.pushBranch = value;
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
  if (parsed.controlPlane === "v1") {
    const durableOptions = [
      "--assignment-id",
      "--enqueue-only",
      "--priority",
      "--write-root",
      "--forbid-root",
      "--check-json",
      "--artifact-json",
      "--review-policy",
      "--require-operator-approval",
      "--allow-symlinks",
      "--allow-submodules",
      "--candidate-id",
      "--delivery",
      "--commit-message",
      "--push-remote",
      "--push-branch",
    ];
    if (durableOptions.some((option) => seen.has(option))) {
      throw new ExecutorInvocationError("Durable assignment options require --control-plane v2.");
    }
    parsed.resultFormat = "v1";
  }
  if (parsed.assignmentId !== null) {
    const contractOptions = [
      "--priority",
      "--write-root",
      "--forbid-root",
      "--check-json",
      "--artifact-json",
      "--review-policy",
      "--require-operator-approval",
      "--allow-symlinks",
      "--allow-submodules",
      "--candidate-id",
      "--delivery",
      "--commit-message",
      "--push-remote",
      "--push-branch",
    ];
    if (contractOptions.some((option) => seen.has(option))) {
      throw new ExecutorInvocationError("A resumed assignment uses its stored contract.");
    }
  }
  if (profile.workspaceStrategy === "isolated-worktree" && parsed.assignmentId === null && parsed.writeRoots.length === 0) {
    throw new ExecutorInvocationError("Workspace-write profiles require at least one --write-root.");
  }
  if (profile.workspaceStrategy === "isolated-worktree" && parsed.resultFormat === "v1") {
    throw new ExecutorInvocationError("Workspace-write profiles require --result-format v2.");
  }
  if (parsed.candidateId !== null && parsed.profile !== "review") {
    throw new ExecutorInvocationError("--candidate-id requires --profile review.");
  }
  if (parsed.enqueueOnly && parsed.assignmentId !== null) {
    throw new ExecutorInvocationError("--enqueue-only cannot resume an existing assignment.");
  }
  validateDeliveryOptions(parsed, profile);

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
    `Act as a bounded ${profile.model} ${profile.name} executor at ${profile.reasoningEffort} reasoning on the ${profile.serviceTier} service tier, not as the root orchestrator.`,
    "Do not invoke the sol-luna-orchestration skill, delegate, or launch another Codex session.",
    "Complete only the supplied briefing and preserve unrelated changes.",
    "Do not alter orchestration policy, approval policy, or sandbox configuration, and do not use bypasses.",
    "Return only the result required by the supplied JSON schema.",
    "Always include operator_requests; use an empty array unless status is blocked and operator input is required.",
    "Use completed only when the assigned work and requested checks succeeded; otherwise use blocked or failed.",
    ...profile.instructions,
  ].join("\n");
}

export function buildProfileAppServerArguments({
  profile: profileName,
  sandboxMode,
}) {
  const profile = requireExecutorProfile(profileName, sandboxMode);
  return buildAppServerArguments({
    fastMode: profile.fastMode,
    configuredServiceTier: profile.configuredServiceTier,
    modelVerbosity: MODEL_VERBOSITY,
  });
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

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let forceKillTimer;

    const lineReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lineReader.on("line", (line) => {
      stdout = appendLimited(stdout, `${line}\n`);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString("utf8"));
    });
    child.stdin.on("error", (error) => {
      stderr = appendLimited(stderr, `stdin: ${error.message}\n`);
    });

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
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });

    child.stdin.end(input);
  });
}

export function createAutomaticCommitMessage(briefing) {
  const firstLine = briefing
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const normalized = (firstLine ?? "complete validated orchestration task")
    .replace(/^#+\s*/u, "")
    .replace(/^(?:[-*+]|\d+\.)\s+/u, "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const message = /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^\r\n)]+\))?!?:\s/u.test(
    normalized,
  )
    ? normalized
    : `chore: ${normalized || "complete validated orchestration task"}`;
  return message.slice(0, 200).trimEnd();
}

function gitInspectionValue(result) {
  if (result.timedOut || result.aborted) {
    throw new ExecutorConfigurationError("Git inspection for automatic delivery did not complete.");
  }
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function resolveAutomaticPushDestination(
  cwd,
  {
    environment = process.env,
    processRunner = runProcess,
  } = {},
) {
  const branchResult = await processRunner(
    "git",
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    { cwd, environment, timeoutMs: 10_000 },
  );
  const branch = gitInspectionValue(branchResult);
  if (branch === null || branch.length === 0) {
    return null;
  }
  const [remoteResult, mergeResult] = await Promise.all([
    processRunner("git", ["config", "--get", `branch.${branch}.remote`], {
      cwd,
      environment,
      timeoutMs: 10_000,
    }),
    processRunner("git", ["config", "--get", `branch.${branch}.merge`], {
      cwd,
      environment,
      timeoutMs: 10_000,
    }),
  ]);
  const remote = gitInspectionValue(remoteResult);
  const mergeRef = gitInspectionValue(mergeResult);
  if (
    remote === null ||
    remote.length === 0 ||
    remote === "." ||
    mergeRef === null ||
    !mergeRef.startsWith("refs/heads/")
  ) {
    return null;
  }
  const upstreamBranch = mergeRef.slice("refs/heads/".length);
  if (upstreamBranch !== branch) {
    return null;
  }
  return { remote, branch };
}

export async function applyAutomaticDeliveryConfiguration({
  options,
  briefing,
  deliveryExplicit = false,
  environment = process.env,
  homeDirectory,
  configurationReader = readDeliveryConfiguration,
  pushDestinationResolver = resolveAutomaticPushDestination,
} = {}) {
  const profile = getExecutorProfile(options.profile);
  if (
    deliveryExplicit ||
    options.assignmentId !== null ||
    profile?.workspaceStrategy !== "isolated-worktree"
  ) {
    return options;
  }
  const configuration = await configurationReader({ environment, homeDirectory });
  if (!configuration.automatic_delivery) {
    return options;
  }
  const destination = await pushDestinationResolver(options.cwd, { environment });
  const configured = {
    ...options,
    deliveryMode: destination === null ? "commit" : "push",
    commitMessage: createAutomaticCommitMessage(briefing),
    pushRemote: destination?.remote ?? null,
    pushBranch: destination?.branch ?? null,
  };
  validateDeliveryOptions(configured, profile);
  return configured;
}

export async function verifyPlaywrightMcp({
  command = "codex",
  cwd = process.cwd(),
  environment = process.env,
  processRunner = runProcess,
} = {}) {
  const result = await processRunner(command, ["mcp", "get", "playwright", "--json"], {
    cwd,
    environment,
    timeoutMs: 10_000,
  });
  if (result.timedOut || result.aborted || result.exitCode !== 0) {
    throw new ExecutorConfigurationError(
      result.stderr || "The Playwright MCP preflight did not complete successfully.",
    );
  }
  let configuration;
  try {
    configuration = JSON.parse(result.stdout);
  } catch (error) {
    throw new ExecutorConfigurationError(
      `The Playwright MCP preflight returned invalid JSON: ${error.message}`,
    );
  }
  if (
    configuration?.name !== "playwright" ||
    configuration.enabled !== true ||
    configuration.transport?.type !== "stdio"
  ) {
    throw new ExecutorConfigurationError(
      "The Playwright MCP must be installed, enabled, and configured with stdio transport.",
    );
  }
  return configuration;
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

async function readRoutingMetadata(rolloutPath) {
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

  return { contexts };
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
      ({ contexts } = await readRoutingMetadata(rolloutPath));
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
    "operator_requests",
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
  if (!Object.hasOwn(value, "operator_requests")) {
    throw new ExecutorConfigurationError("operator_requests is required.");
  }
  const operatorRequests = value.operator_requests;
  if (!Array.isArray(operatorRequests)) {
    throw new ExecutorConfigurationError("operator_requests must be an array.");
  }
  if (operatorRequests.length > 0 && value.status !== "blocked") {
    throw new ExecutorConfigurationError("operator_requests require status blocked.");
  }
  for (const [index, request] of operatorRequests.entries()) {
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      throw new ExecutorConfigurationError(`operator_requests[${index}] must be an object.`);
    }
    const unexpected = Object.keys(request).filter((property) => !["question", "choices"].includes(property));
    if (unexpected.length > 0) {
      throw new ExecutorConfigurationError(
        `Unexpected operator request properties: ${unexpected.join(", ")}.`,
      );
    }
    if (typeof request.question !== "string" || request.question.trim().length === 0) {
      throw new ExecutorConfigurationError(`operator_requests[${index}].question must be non-empty.`);
    }
    assertStringArray(request.choices, `operator_requests[${index}].choices`);
  }

  const validated = {
    status: value.status,
    summary: value.summary,
    changed_files: [...value.changed_files],
    checks: [...value.checks],
    blockers: [...value.blockers],
    warnings: [...value.warnings],
    operator_requests: operatorRequests.map((request) => ({
      question: request.question.trim(),
      choices: [...request.choices],
    })),
  };
  return validated;
}

function validateProfilePayload(profileName, payload) {
  if (["explore", "playwright", "review"].includes(profileName) && payload.changed_files.length > 0) {
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
  serviceTier = null,
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
    service_tier: serviceTier,
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
      serviceTier: details.serviceTier ?? null,
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
  appServerRunner = runAppServerTurn,
  playwrightMcpVerifier = verifyPlaywrightMcp,
  onAppServerStarted,
  outputContract,
}) {
  if (typeof briefing !== "string" || briefing.trim().length === 0) {
    throw new ExecutorInvocationError("An executor briefing is required.");
  }
  const profile = requireExecutorProfile(options.profile, options.sandboxMode);

  let workingDirectory;
  try {
    workingDirectory = await stat(options.cwd);
  } catch (error) {
    throw new ExecutorConfigurationError(error.message);
  }
  if (!workingDirectory.isDirectory()) {
    throw new ExecutorInvocationError(`Executor cwd is not a directory: ${options.cwd}`);
  }

  let playwrightOutputDirectory = null;
  if (profile.name === "playwright") {
    try {
      await playwrightMcpVerifier({ command, cwd: options.cwd, environment });
      playwrightOutputDirectory = await mkdtemp(join(tmpdir(), "sol-luna-playwright-"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return configurationFailure(message, options);
    }
  }

  try {
    const executorEnvironment = {
      ...environment,
      [ORCHESTRATION_ROLE_ENV]: "executor",
      CODEX_EXECUTOR_PROFILE: profile.name,
      ...(profile.name === "playwright"
        ? {
            PLAYWRIGHT_MCP_ISOLATED: "true",
            PLAYWRIGHT_MCP_OUTPUT_DIR: playwrightOutputDirectory,
          }
        : {}),
    };
    let appServerResult;
    try {
      appServerResult = await appServerRunner({
        command,
        cwd: options.cwd,
        environment: executorEnvironment,
        model: profile.model,
        reasoningEffort: profile.reasoningEffort,
        serviceTier: profile.serviceTier,
        configuredServiceTier: profile.configuredServiceTier,
        fastMode: profile.fastMode,
        sandboxMode: options.sandboxMode,
        developerInstructions: createExecutorDeveloperInstructions(profile.name),
        briefing: briefing.trim(),
        outputSchema: outputContract.schema,
        timeoutMs: options.timeoutSeconds * 1000,
        signal,
        onProcessStarted: onAppServerStarted,
      });
    } catch (error) {
      if (!(error instanceof AppServerError)) {
        throw error;
      }
      return configurationFailure(error.message, options, {
        threadId: error.threadId ?? null,
        model: error.actualModel ?? null,
        reasoningEffort: error.actualReasoningEffort ?? null,
        serviceTier: error.actualServiceTier ?? null,
        warnings: error.stderr ? [error.stderr] : [],
      });
    }

    const protocolWarnings = appServerResult.warnings ?? [];
    const diagnosticWarnings = [
      ...protocolWarnings,
      ...(appServerResult.stderr ? [appServerResult.stderr] : []),
    ];
    if (appServerResult.threadId === null) {
      return configurationFailure("App Server did not return a thread id.", options, {
        warnings: diagnosticWarnings,
      });
    }
    if (
      appServerResult.model !== profile.model ||
      appServerResult.reasoningEffort !== profile.reasoningEffort ||
      appServerResult.serviceTier !== profile.serviceTier
    ) {
      return configurationFailure(
        `App Server routing mismatch: expected ${profile.model}/${profile.reasoningEffort}/${profile.serviceTier}, received ${appServerResult.model ?? "null"}/${appServerResult.reasoningEffort ?? "null"}/${appServerResult.serviceTier ?? "null"}.`,
        options,
        {
          threadId: appServerResult.threadId,
          model: appServerResult.model ?? null,
          reasoningEffort: appServerResult.reasoningEffort ?? null,
          serviceTier: appServerResult.serviceTier ?? null,
          warnings: diagnosticWarnings,
        },
      );
    }

    let routing;
    try {
      routing = await verifySessionRouting(
        appServerResult.threadId,
        profile.model,
        profile.reasoningEffort,
        { sessionRoots },
      );
    } catch (error) {
      if (!(error instanceof RoutingVerificationError)) {
        throw error;
      }
      return configurationFailure(error.message, options, {
        threadId: appServerResult.threadId,
        model: error.actualModel ?? appServerResult.model,
        reasoningEffort:
          error.actualReasoningEffort ?? appServerResult.reasoningEffort,
        serviceTier: appServerResult.serviceTier,
        warnings: diagnosticWarnings,
      });
    }

    if (appServerResult.blockedReason !== null) {
      const result = createStableResult({
        status: "blocked",
        profile: profile.name,
        threadId: appServerResult.threadId,
        model: routing.model,
        reasoningEffort: routing.reasoningEffort,
        serviceTier: appServerResult.serviceTier,
        routingVerified: true,
        sandboxMode: options.sandboxMode,
        summary: appServerResult.blockedReason,
        blockers: [appServerResult.blockedReason],
        warnings: protocolWarnings,
      });
      return { result, exitCode: 1 };
    }

    if (appServerResult.turnStatus !== "completed") {
      const message = `App Server turn ended with status ${appServerResult.turnStatus ?? "unknown"}.`;
      const result = createStableResult({
        status: "failed",
        profile: profile.name,
        threadId: appServerResult.threadId,
        model: routing.model,
        reasoningEffort: routing.reasoningEffort,
        serviceTier: appServerResult.serviceTier,
        routingVerified: true,
        sandboxMode: options.sandboxMode,
        summary: message,
        blockers: [message],
        warnings: diagnosticWarnings,
      });
      return { result, exitCode: 1 };
    }

    let payload;
    try {
      payload = validateProfilePayload(
        profile.name,
        validateExecutorPayload(JSON.parse(appServerResult.finalResponse)),
      );
    } catch (error) {
      const message = `Invalid structured executor result: ${error.message}`;
      return configurationFailure(message, options, {
        threadId: appServerResult.threadId,
        model: routing.model,
        reasoningEffort: routing.reasoningEffort,
        serviceTier: appServerResult.serviceTier,
        warnings: diagnosticWarnings,
      });
    }

    if (profile.name === "playwright") {
      if (appServerResult.unsafePlaywrightToolUsed === true) {
        return configurationFailure(
          "The Playwright executor attempted to use browser_run_code_unsafe.",
          options,
          {
            threadId: appServerResult.threadId,
            model: routing.model,
            reasoningEffort: routing.reasoningEffort,
            serviceTier: appServerResult.serviceTier,
            warnings: diagnosticWarnings,
          },
        );
      }
      if (appServerResult.playwrightMcpUsed !== true) {
        return configurationFailure(
          "The Playwright executor did not emit a verified Playwright MCP tool call.",
          options,
          {
            threadId: appServerResult.threadId,
            model: routing.model,
            reasoningEffort: routing.reasoningEffort,
            serviceTier: appServerResult.serviceTier,
            warnings: diagnosticWarnings,
          },
        );
      }
    }

    const result = createStableResult({
      status: payload.status,
      profile: profile.name,
      threadId: appServerResult.threadId,
      model: routing.model,
      reasoningEffort: routing.reasoningEffort,
      serviceTier: appServerResult.serviceTier,
      routingVerified: true,
      sandboxMode: options.sandboxMode,
      summary: payload.summary,
      changedFiles: payload.changed_files,
      checks: profile.name === "playwright"
        ? [...payload.checks, "playwright_mcp:verified"]
        : payload.checks,
      blockers: payload.blockers,
      warnings: [...payload.warnings, ...protocolWarnings],
    });
    return {
      result,
      operatorRequests: payload.operator_requests,
      exitCode: determineExitCode({
        status: result.status,
        routingVerified: result.routing_verified,
      }),
    };
  } finally {
    if (playwrightOutputDirectory !== null) {
      await rm(playwrightOutputDirectory, { recursive: true, force: true });
    }
  }
}

export async function invokeExecutor(input) {
  const environment = input.environment ?? process.env;
  const profile = requireExecutorProfile(
    input.options.profile,
    input.options.sandboxMode,
  );
  let outputContract;
  try {
    outputContract = validateExecutorResultContract(
      input.outputContract ?? await loadExecutorResultContract(),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return configurationFailure(`Executor output schema preflight failed: ${message}`, input.options);
  }
  let lease;
  try {
    lease = await beginExecutorRun({
      cwd: input.options.cwd,
      profile: profile.name,
      model: profile.model,
      environment,
      ...(input.coordinationOptions ?? {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return configurationFailure(message, input.options);
  }
  let execution;
  try {
    execution = await runExecutor({
      ...input,
      environment,
      outputContract,
      onAppServerStarted: async ({ pid }) => {
        await registerExecutorProcess(lease, {
          kind: "app-server",
          pid,
          processIdentityProvider: input.coordinationOptions?.processIdentityProvider,
        });
      },
    });
  } catch (error) {
    await abandonExecutorRun(lease, error, input.coordinationOptions);
    throw error;
  }
  await finishExecutorRun(lease, execution, input.coordinationOptions);
  return execution;
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
    const briefing = options.assignmentId === null ? await readBriefing() : "";
    options = await applyAutomaticDeliveryConfiguration({
      options,
      briefing,
      deliveryExplicit: argv.includes("--delivery"),
    });
    const profile = requireExecutorProfile(options.profile, options.sandboxMode);
    writeStatusMessage(
      executorLaunchMessage({
        profile: profile.name,
        model: profile.model,
        reasoningEffort: profile.reasoningEffort,
        serviceTier: profile.serviceTier,
        sandboxMode: options.sandboxMode,
      }),
      process.stderr,
      { colorCode: profile.colorCode },
    );
    const execution = options.controlPlane === "v2"
      ? await (
          await import("./durable-executor.mjs")
        ).invokeDurableExecutor({
          briefing,
          options,
          invokeLegacy: invokeExecutor,
          signal: abortController.signal,
        })
      : await invokeExecutor({
          briefing,
          options,
          signal: abortController.signal,
        });
    writeStatusMessage(executorResultMessage(execution.result), process.stderr, {
      colorCode: profile.colorCode,
    });
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
