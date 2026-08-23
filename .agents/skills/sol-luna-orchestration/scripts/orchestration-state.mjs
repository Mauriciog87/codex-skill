import { createHash, randomUUID } from "node:crypto";
import {
  constants as fileConstants,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import {
  ProcessIdentityError,
  createProcessIdentity,
  inspectProcessIdentity,
  isPidAlive,
  validateProcessIdentity,
} from "./process-identity.mjs";

export const ORCHESTRATION_LOCK_ENV = "CODEX_ORCHESTRATION_LOCK_ID";
export const ORCHESTRATION_GENERATION_ENV = "CODEX_ORCHESTRATION_GENERATION";
export const ORCHESTRATION_ROLE_ENV = "CODEX_ORCHESTRATION_ROLE";
export const ULTRA_ORCHESTRATOR_ROLE = "ultra-orchestrator";
export const ULTRA_MODEL = "gpt-5.6-sol";
export const ULTRA_REASONING_EFFORT = "ultra";
export const ULTRA_SERVICE_TIER = "standard";
export const ULTRA_CONFIGURED_SERVICE_TIER = "default";
export const SOL_MODEL_VERBOSITY = "low";
export const ORCHESTRATION_STATE_VERSION = 2;
export const HISTORY_RETENTION_LIMIT = 1_000;

const LEGACY_STATE_VERSION = 1;
const MUTEX_TIMEOUT_MS = 5_000;
const MUTEX_STALE_MS = 30_000;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;

export const EXECUTOR_CAPACITY_LIMITS = Object.freeze({
  luna: 10,
  sol: 4,
  total: 14,
  playwright: 2,
});

const EVENT_DESCRIPTIONS = Object.freeze({
  "lock-acquired": "Ultra lock acquired.",
  "lock-updated": "Ultra lock metadata updated.",
  "executor-started": "Executor run started.",
  "executor-completed": "Executor run completed.",
  "executor-abandoned": "Executor run abandoned.",
  "stale-generation-rejected": "A stale orchestration transition was rejected.",
  "owner-observed-dead": "A registered process was observed dead.",
  "recovery-required": "Ultra lock entered recovery-required state.",
  "recovery-rejected": "Ultra lock recovery was rejected.",
  "lock-recovered": "Ultra lock was recovered.",
  "legacy-lock-recovered": "Legacy Ultra lock was recovered.",
  "lock-released": "Ultra lock was released.",
  "dead-lease-pruned": "A dead executor lease was pruned.",
});

export class OrchestrationStateError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "OrchestrationStateError";
    this.lockId = details.lockId ?? null;
    this.generation = details.generation ?? null;
  }
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function getEntry(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readJson(path, label) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    throw new OrchestrationStateError(`${label} cannot be read: ${error.message}`);
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new OrchestrationStateError(`${label} is invalid JSON: ${error.message}`);
  }
}

async function writeTemporary(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, "utf8");
  return temporaryPath;
}

async function atomicWrite(path, value) {
  const temporaryPath = await writeTemporary(path, value);
  try {
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      if (process.platform !== "win32" || !["EACCES", "EEXIST", "EPERM"].includes(error.code)) {
        throw error;
      }
      await copyFile(temporaryPath, path);
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function atomicCreate(path, value) {
  const temporaryPath = await writeTemporary(path, value);
  try {
    if ((await getEntry(path)) !== null) {
      const error = new Error(`State entry already exists: ${path}`);
      error.code = "EEXIST";
      throw error;
    }
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      if (process.platform !== "win32" || !["EACCES", "EEXIST", "EPERM"].includes(error.code)) {
        throw error;
      }
      await copyFile(temporaryPath, path, fileConstants.COPYFILE_EXCL);
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export function isProcessAlive(pid, kill = process.kill) {
  return isPidAlive(pid, kill);
}

async function findRepositoryRoot(cwd) {
  const metadata = await stat(cwd);
  if (!metadata.isDirectory()) {
    throw new OrchestrationStateError(`Repository cwd is not a directory: ${cwd}`);
  }
  let current = await realpath(cwd);
  const root = parse(current).root;
  while (true) {
    if ((await getEntry(join(current, ".git"))) !== null) {
      return current;
    }
    if (current === root) {
      return await realpath(cwd);
    }
    current = dirname(current);
  }
}

export function getRepositoryKey(repository, platform = process.platform) {
  const normalized = resolve(repository).replace(/^\\\\\?\\/, "");
  const keyed = platform === "win32" ? normalized.toLowerCase() : normalized;
  return createHash("sha256").update(keyed).digest("hex");
}

export function getCodexHome(environment = process.env, homeDirectory) {
  const resolvedHomeDirectory = homeDirectory ?? environment.HOME ?? homedir();
  return environment.CODEX_HOME
    ? resolve(environment.CODEX_HOME)
    : resolve(resolvedHomeDirectory, ".codex");
}

export async function getRepositoryState(
  cwd,
  { environment = process.env, homeDirectory = homedir(), platform = process.platform } = {},
) {
  const repository = await findRepositoryRoot(resolve(cwd));
  const key = getRepositoryKey(repository, platform);
  const stateDirectory = join(
    getCodexHome(environment, homeDirectory),
    "sol-sol-orchestration",
    "state",
    key,
  );
  const globalState = getGlobalCapacityState({ environment, homeDirectory });
  return {
    repository,
    key,
    stateDirectory,
    mutexDirectory: join(stateDirectory, "state.mutex"),
    metadataPath: join(stateDirectory, "repository-state.json"),
    lockDirectory: join(stateDirectory, "ultra.lock"),
    lockPath: join(stateDirectory, "ultra.lock", "lock.json"),
    runsDirectory: join(stateDirectory, "runs"),
    historyDirectory: join(stateDirectory, "history"),
    globalStateDirectory: globalState.stateDirectory,
    globalMutexDirectory: globalState.mutexDirectory,
    globalRunsDirectory: globalState.runsDirectory,
  };
}

export function getGlobalCapacityState({
  environment = process.env,
  homeDirectory = homedir(),
} = {}) {
  const stateDirectory = join(
    getCodexHome(environment, homeDirectory),
    "sol-sol-orchestration",
    "state",
    "global-capacity",
  );
  return {
    stateDirectory,
    mutexDirectory: join(stateDirectory, "state.mutex"),
    runsDirectory: join(stateDirectory, "runs"),
  };
}

async function removeStaleMutex(state) {
  const entry = await getEntry(state.mutexDirectory);
  if (entry === null || Date.now() - entry.mtimeMs < MUTEX_STALE_MS) {
    return false;
  }
  let owner = null;
  try {
    owner = await readJson(join(state.mutexDirectory, "owner.json"), "Orchestration mutex owner");
  } catch {}
  if (owner !== null && isProcessAlive(owner.pid)) {
    return false;
  }
  await rm(state.mutexDirectory, { recursive: true, force: true });
  return true;
}

async function withStateMutex(state, action) {
  await mkdir(state.stateDirectory, { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(state.mutexDirectory);
      try {
        await atomicWrite(join(state.mutexDirectory, "owner.json"), {
          version: ORCHESTRATION_STATE_VERSION,
          pid: process.pid,
          created_at: new Date().toISOString(),
        });
      } catch (error) {
        await rm(state.mutexDirectory, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      if (await removeStaleMutex(state)) {
        continue;
      }
      if (Date.now() - startedAt >= MUTEX_TIMEOUT_MS) {
        throw new OrchestrationStateError("Timed out waiting for the orchestration state mutex.");
      }
      await wait(25);
    }
  }
  try {
    return await action();
  } finally {
    await rm(state.mutexDirectory, { recursive: true, force: true });
  }
}

function validateControlledProcesses(processes, label, launcherKind) {
  if (!Array.isArray(processes) || processes.length === 0) {
    throw new OrchestrationStateError(`${label} process metadata is malformed.`);
  }
  const kinds = new Set();
  try {
    for (const processEntry of processes) {
      if (
        processEntry === null ||
        typeof processEntry !== "object" ||
        typeof processEntry.kind !== "string" ||
        processEntry.kind.length === 0 ||
        ![launcherKind, "app-server"].includes(processEntry.kind) ||
        kinds.has(processEntry.kind)
      ) {
        throw new ProcessIdentityError("Controlled process entry is malformed.");
      }
      kinds.add(processEntry.kind);
      validateProcessIdentity(processEntry.identity);
    }
    if (!kinds.has(launcherKind)) {
      throw new ProcessIdentityError(`${label} must register ${launcherKind}.`);
    }
  } catch (error) {
    throw new OrchestrationStateError(`${label} process metadata is malformed: ${error.message}`);
  }
  return processes;
}

function validateLegacyLock(lock) {
  if (
    lock === null ||
    typeof lock !== "object" ||
    lock.version !== LEGACY_STATE_VERSION ||
    typeof lock.lock_id !== "string" ||
    lock.lock_id.length === 0 ||
    typeof lock.repository !== "string" ||
    !["active", "recovery-required"].includes(lock.state) ||
    !Number.isInteger(lock.pid) ||
    typeof lock.reason !== "string" ||
    !["read-only", "workspace-write"].includes(lock.sandbox_mode)
  ) {
    throw new OrchestrationStateError("The repository legacy Ultra lock metadata is malformed.");
  }
  return lock;
}

function validateLock(lock) {
  if (lock?.version === LEGACY_STATE_VERSION) {
    return validateLegacyLock(lock);
  }
  if (
    lock === null ||
    typeof lock !== "object" ||
    lock.version !== ORCHESTRATION_STATE_VERSION ||
    typeof lock.lock_id !== "string" ||
    lock.lock_id.length === 0 ||
    typeof lock.repository !== "string" ||
    typeof lock.repository_key !== "string" ||
    !["active", "recovery-required"].includes(lock.state) ||
    !Number.isInteger(lock.generation) ||
    lock.generation < 1 ||
    !Number.isInteger(lock.pid) ||
    typeof lock.reason !== "string" ||
    !["read-only", "workspace-write"].includes(lock.sandbox_mode)
  ) {
    throw new OrchestrationStateError("The repository Ultra lock metadata is malformed.");
  }
  const processes = validateControlledProcesses(lock.processes, "Ultra lock", "ultra-launcher");
  if (launcherIdentity({ processes }, "ultra-launcher").pid !== lock.pid) {
    throw new OrchestrationStateError("Ultra lock launcher PID does not match its process identity.");
  }
  return lock;
}

async function readLockFromState(state) {
  if ((await getEntry(state.lockDirectory)) === null) {
    return null;
  }
  return validateLock(await readJson(state.lockPath, "Repository Ultra lock"));
}

function validateRepositoryMetadata(value, state) {
  if (
    value === null ||
    typeof value !== "object" ||
    value.version !== ORCHESTRATION_STATE_VERSION ||
    value.repository !== state.repository ||
    value.repository_key !== state.key ||
    !Number.isInteger(value.current_generation) ||
    value.current_generation < 0 ||
    !Number.isInteger(value.history_sequence) ||
    value.history_sequence < 0 ||
    typeof value.updated_at !== "string"
  ) {
    throw new OrchestrationStateError("Repository generation metadata is malformed.");
  }
  return value;
}

async function readRepositoryMetadata(state) {
  if ((await getEntry(state.metadataPath)) === null) {
    return null;
  }
  return validateRepositoryMetadata(
    await readJson(state.metadataPath, "Repository generation metadata"),
    state,
  );
}

async function ensureRepositoryMetadata(state) {
  const existing = await readRepositoryMetadata(state);
  if (existing !== null) {
    return existing;
  }
  const metadata = {
    version: ORCHESTRATION_STATE_VERSION,
    repository: state.repository,
    repository_key: state.key,
    current_generation: 0,
    history_sequence: 0,
    updated_at: new Date().toISOString(),
  };
  await atomicCreate(state.metadataPath, metadata);
  return metadata;
}

function validateRun(run, entryName) {
  if (run?.version === LEGACY_STATE_VERSION) {
    if (
      run === null ||
      typeof run !== "object" ||
      typeof run.run_id !== "string" ||
      !Number.isInteger(run.pid) ||
      typeof run.profile !== "string" ||
      !["active", "completed", "abandoned"].includes(run.state)
    ) {
      throw new OrchestrationStateError(`Legacy executor run ${entryName} is malformed.`);
    }
    return run;
  }
  if (
    run === null ||
    typeof run !== "object" ||
    run.version !== ORCHESTRATION_STATE_VERSION ||
    typeof run.run_id !== "string" ||
    !Number.isInteger(run.pid) ||
    typeof run.profile !== "string" ||
    typeof run.model !== "string" ||
    !["luna", "sol"].includes(run.pool) ||
    !["active", "completed", "abandoned"].includes(run.state) ||
    !(run.generation === null || (Number.isInteger(run.generation) && run.generation >= 1)) ||
    !(run.lock_id === null || (typeof run.lock_id === "string" && run.lock_id.length > 0)) ||
    (run.lock_id === null) !== (run.generation === null)
  ) {
    throw new OrchestrationStateError(`Executor run ${entryName} is malformed.`);
  }
  const processes = validateControlledProcesses(
    run.processes,
    `Executor run ${entryName}`,
    "executor-launcher",
  );
  if (launcherIdentity({ processes }, "executor-launcher").pid !== run.pid) {
    throw new OrchestrationStateError(`Executor run ${entryName} launcher PID does not match its process identity.`);
  }
  return run;
}

async function readRuns(state) {
  if ((await getEntry(state.runsDirectory)) === null) {
    return [];
  }
  const entries = await readdir(state.runsDirectory, { withFileTypes: true });
  const runs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const path = join(state.runsDirectory, entry.name);
    const run = validateRun(await readJson(path, `Executor run ${entry.name}`), entry.name);
    runs.push({ ...run, path });
  }
  return runs;
}

function generationKey(generation) {
  return generation === null || generation === undefined ? "normal" : String(generation);
}

function isTerminalHistoryEvent(event) {
  return ["lock-released", "lock-recovered", "legacy-lock-recovered"].includes(event.event_type) || (
    event.generation === null &&
    ["executor-completed", "executor-abandoned", "dead-lease-pruned"].includes(event.event_type)
  );
}

async function readHistoryEntries(state) {
  if ((await getEntry(state.historyDirectory)) === null) {
    return { events: [], warnings: [], fileCount: 0 };
  }
  const entries = (await readdir(state.historyDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const events = [];
  const warnings = [];
  for (const entry of entries) {
    try {
      const event = await readJson(join(state.historyDirectory, entry.name), `History event ${entry.name}`);
      if (
        event === null ||
        typeof event !== "object" ||
        event.version !== ORCHESTRATION_STATE_VERSION ||
        typeof event.event_id !== "string" ||
        !Number.isInteger(event.sequence) ||
        typeof event.event_type !== "string" ||
        typeof event.timestamp !== "string"
      ) {
        throw new OrchestrationStateError(`History event ${entry.name} is malformed.`);
      }
      events.push({ ...event, path: join(state.historyDirectory, entry.name) });
    } catch (error) {
      warnings.push(error.message);
    }
  }
  events.sort((left, right) => left.sequence - right.sequence);
  return { events, warnings, fileCount: entries.length };
}

async function pruneHistory(state) {
  const entries = await readHistoryEntries(state);
  if (entries.fileCount <= HISTORY_RETENTION_LIMIT) {
    return;
  }
  const lock = await readLockFromState(state);
  const runs = await readRuns(state);
  const protectedGenerations = new Set();
  if (lock !== null) {
    protectedGenerations.add(generationKey(lock.generation));
  }
  if (runs.some((run) => run.state === "active" && run.generation === null)) {
    protectedGenerations.add("normal");
  }
  const terminatedGenerations = new Set();
  for (const event of entries.events) {
    if (isTerminalHistoryEvent(event)) {
      terminatedGenerations.add(generationKey(event.generation));
    }
  }
  let remaining = entries.fileCount;
  const eligibleEvents = entries.events.filter((event) => {
    const key = generationKey(event.generation);
    return !protectedGenerations.has(key) && terminatedGenerations.has(key);
  });
  const candidates = [
    ...eligibleEvents.filter((event) => !isTerminalHistoryEvent(event)),
    ...eligibleEvents.filter(isTerminalHistoryEvent),
  ];
  for (const event of candidates) {
    if (remaining <= HISTORY_RETENTION_LIMIT) {
      break;
    }
    await rm(event.path, { force: false });
    remaining -= 1;
  }
}

function historyOwner(identity) {
  if (identity === null || identity === undefined) {
    return null;
  }
  validateProcessIdentity(identity);
  return {
    pid: identity.pid,
    instance_id: identity.instance_id,
    start_fingerprint: identity.start_fingerprint,
    hostname: identity.hostname,
    platform: identity.platform,
    architecture: identity.architecture,
  };
}

async function appendHistory(state, {
  eventType,
  lockId = null,
  generation = null,
  runId = null,
  profile = null,
  owner = null,
  reasonCode,
}) {
  if (!Object.hasOwn(EVENT_DESCRIPTIONS, eventType)) {
    throw new OrchestrationStateError(`Unsupported orchestration history event: ${eventType}.`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(reasonCode)) {
    throw new OrchestrationStateError("Orchestration history reason code is invalid.");
  }
  const metadata = await ensureRepositoryMetadata(state);
  const sequence = metadata.history_sequence + 1;
  await atomicWrite(state.metadataPath, {
    ...metadata,
    history_sequence: sequence,
    updated_at: new Date().toISOString(),
  });
  const eventId = randomUUID();
  const event = {
    version: ORCHESTRATION_STATE_VERSION,
    event_id: eventId,
    sequence,
    event_type: eventType,
    repository: state.repository,
    repository_key: state.key,
    lock_id: lockId,
    generation,
    run_id: runId,
    profile,
    owner: historyOwner(owner),
    timestamp: new Date().toISOString(),
    reason_code: reasonCode,
    description: EVENT_DESCRIPTIONS[eventType],
  };
  const path = join(state.historyDirectory, `${String(sequence).padStart(16, "0")}-${eventId}.json`);
  await atomicCreate(path, event);
  await pruneHistory(state);
  return event;
}

async function inspectProcesses(processes, processInspector) {
  const results = [];
  const cache = new Map();
  for (const processEntry of processes) {
    const cacheKey = JSON.stringify([
      processEntry.identity.hostname,
      processEntry.identity.platform,
      processEntry.identity.architecture,
      processEntry.identity.pid,
      processEntry.identity.start_fingerprint,
      processEntry.identity.instance_id,
    ]);
    let inspection = cache.get(cacheKey);
    if (inspection === undefined) {
      try {
        inspection = await processInspector(processEntry.identity);
      } catch (error) {
        inspection = { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
      }
      if (!["same", "dead", "reused", "unknown"].includes(inspection?.status)) {
        inspection = { status: "unknown", reason: "Process inspector returned invalid state." };
      }
      cache.set(cacheKey, inspection);
    }
    results.push({
      kind: processEntry.kind,
      identity: processEntry.identity,
      status: inspection.status,
      ...(inspection.reason ? { reason: String(inspection.reason).slice(0, 500) } : {}),
    });
  }
  return results;
}

function resolveProcessInspector({ processInspector, processAlive } = {}) {
  if (typeof processInspector === "function") {
    return processInspector;
  }
  if (typeof processAlive === "function") {
    return async (identity) => ({ status: processAlive(identity.pid) ? "same" : "dead" });
  }
  return inspectProcessIdentity;
}

async function removeDeadActiveRuns(state, options = {}) {
  const processInspector = resolveProcessInspector(options);
  const repositoryState = typeof state.historyDirectory === "string";
  const runs = await readRuns(state);
  for (const run of runs) {
    if (run.state !== "active") {
      continue;
    }
    let inactive;
    if (run.version === LEGACY_STATE_VERSION) {
      inactive = !isProcessAlive(run.pid);
    } else {
      const inspections = await inspectProcesses(run.processes, processInspector);
      inactive = inspections.every((entry) => ["dead", "reused"].includes(entry.status));
    }
    if (!inactive || (repositoryState && run.lock_id !== null)) {
      continue;
    }
    if (repositoryState && run.version === ORCHESTRATION_STATE_VERSION) {
      await appendHistory(state, {
        eventType: "dead-lease-pruned",
        lockId: run.lock_id,
        generation: run.generation,
        runId: run.run_id,
        profile: run.profile,
        owner: run.processes[0].identity,
        reasonCode: "executor-launcher-inactive",
      });
    }
    await rm(run.path, { force: true });
  }
  return (await readRuns(state)).filter((run) => run.state === "active");
}

function getRunPool(run) {
  return ["luna", "sol"].includes(run.pool) ? run.pool : "sol";
}

function capacityUsage(runs) {
  return {
    luna: runs.filter((run) => getRunPool(run) === "luna").length,
    sol: runs.filter((run) => getRunPool(run) === "sol").length,
    total: runs.length,
    playwright: runs.filter((run) => run.profile === "playwright").length,
  };
}

function requireExecutorPool(model) {
  if (model === "gpt-5.6-luna") {
    return "luna";
  }
  if (model === "gpt-5.6-sol") {
    return "sol";
  }
  throw new OrchestrationStateError(`Unsupported executor model for capacity routing: ${model}.`);
}

function assertCapacityAvailable(scope, usage, pool, profile) {
  if (usage[pool] >= EXECUTOR_CAPACITY_LIMITS[pool]) {
    throw new OrchestrationStateError(`${scope} ${pool} executor capacity is full (${usage[pool]}/${EXECUTOR_CAPACITY_LIMITS[pool]}).`);
  }
  if (usage.total >= EXECUTOR_CAPACITY_LIMITS.total) {
    throw new OrchestrationStateError(`${scope} total executor capacity is full (${usage.total}/${EXECUTOR_CAPACITY_LIMITS.total}).`);
  }
  if (profile === "playwright" && usage.playwright >= EXECUTOR_CAPACITY_LIMITS.playwright) {
    throw new OrchestrationStateError(`${scope} Playwright executor capacity is full (${usage.playwright}/${EXECUTOR_CAPACITY_LIMITS.playwright}).`);
  }
}

function assertNoLegacyState(lock, runs) {
  if (lock?.version === LEGACY_STATE_VERSION || runs.some((run) => run.version === LEGACY_STATE_VERSION)) {
    throw new OrchestrationStateError("Repository contains legacy-unfenced orchestration state that must drain or be explicitly recovered.");
  }
}

async function rejectStaleEpoch(state, context, reasonCode) {
  const metadata = await readRepositoryMetadata(state);
  if (metadata !== null) {
    await appendHistory(state, {
      eventType: "stale-generation-rejected",
      lockId: context.lockId ?? null,
      generation: Number.isInteger(context.generation) ? context.generation : null,
      runId: context.runId ?? null,
      profile: context.profile ?? null,
      owner: context.owner ?? null,
      reasonCode,
    });
  }
  throw new OrchestrationStateError(
    `Rejected stale generation ${context.generation ?? "null"} for Ultra lock ${context.lockId ?? "null"}.`,
    { lockId: context.lockId, generation: context.generation },
  );
}

async function assertActiveEpoch(state, context, reasonCode) {
  const metadata = await readRepositoryMetadata(state);
  const lock = await readLockFromState(state);
  if (
    metadata === null ||
    lock === null ||
    lock.version !== ORCHESTRATION_STATE_VERSION ||
    lock.state !== "active" ||
    !Number.isInteger(context.generation) ||
    metadata.current_generation !== context.generation ||
    lock.generation !== context.generation ||
    lock.lock_id !== context.lockId
  ) {
    await rejectStaleEpoch(state, context, reasonCode);
  }
  return lock;
}

function launcherIdentity(record, kind) {
  return record.processes.find((entry) => entry.kind === kind)?.identity ?? null;
}

function requireMatchingRun(run, lease) {
  if (
    run.run_id !== lease.run_id ||
    run.lock_id !== lease.lock_id ||
    run.generation !== lease.generation ||
    launcherIdentity(run, "executor-launcher")?.instance_id !== launcherIdentity(lease, "executor-launcher")?.instance_id
  ) {
    throw new OrchestrationStateError(`Executor run ${lease.run_id} lease identity does not match.`);
  }
  return run;
}

export async function readUltraLock(cwd, options = {}) {
  const state = await getRepositoryState(cwd, options);
  return readLockFromState(state);
}

export async function acquireUltraLock({
  cwd,
  reason,
  sandboxMode,
  environment = process.env,
  homeDirectory = homedir(),
  pid = process.pid,
  lockId = randomUUID(),
  processIdentityProvider = createProcessIdentity,
}) {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new OrchestrationStateError("An Ultra takeover reason is required.");
  }
  const state = await getRepositoryState(cwd, { environment, homeDirectory });
  return withStateMutex(state, async () => {
    const existingLock = await readLockFromState(state);
    if (existingLock !== null) {
      if (existingLock.version === LEGACY_STATE_VERSION) {
        assertNoLegacyState(existingLock, []);
      }
      throw new OrchestrationStateError(`Repository already has an Ultra lock in state ${existingLock.state}.`, {
        lockId: existingLock.lock_id,
        generation: existingLock.generation,
      });
    }
    const activeRuns = await removeDeadActiveRuns(state);
    const allRuns = await readRuns(state);
    assertNoLegacyState(null, allRuns);
    if (activeRuns.length > 0) {
      throw new OrchestrationStateError(`Cannot acquire Ultra takeover while ${activeRuns.length} executor run(s) are active.`);
    }
    const ownerIdentity = await processIdentityProvider({ pid });
    validateProcessIdentity(ownerIdentity);
    const metadata = await ensureRepositoryMetadata(state);
    const generation = metadata.current_generation + 1;
    await atomicWrite(state.metadataPath, {
      ...metadata,
      current_generation: generation,
      updated_at: new Date().toISOString(),
    });
    await mkdir(state.lockDirectory);
    const timestamp = new Date().toISOString();
    const lock = {
      version: ORCHESTRATION_STATE_VERSION,
      lock_id: lockId,
      generation,
      repository: state.repository,
      repository_key: state.key,
      state: "active",
      role: ULTRA_ORCHESTRATOR_ROLE,
      pid,
      processes: [{ kind: "ultra-launcher", identity: ownerIdentity }],
      thread_id: null,
      model: ULTRA_MODEL,
      reasoning_effort: ULTRA_REASONING_EFFORT,
      service_tier: ULTRA_SERVICE_TIER,
      sandbox_mode: sandboxMode,
      reason: reason.trim(),
      activation: "human-confirmed",
      created_at: timestamp,
      updated_at: timestamp,
    };
    try {
      await atomicWrite(state.lockPath, lock);
      await appendHistory(state, {
        eventType: "lock-acquired",
        lockId,
        generation,
        owner: ownerIdentity,
        reasonCode: "human-confirmed-takeover",
      });
    } catch (error) {
      await rm(state.lockDirectory, { recursive: true, force: true });
      throw error;
    }
    return lock;
  });
}

export async function updateUltraLock({
  cwd,
  lockId,
  generation,
  state: nextState,
  threadId,
  environment = process.env,
  homeDirectory = homedir(),
}) {
  const repositoryState = await getRepositoryState(cwd, { environment, homeDirectory });
  return withStateMutex(repositoryState, async () => {
    const lock = await assertActiveEpoch(repositoryState, { lockId, generation }, "update-lock-stale");
    const updated = {
      ...lock,
      state: nextState ?? lock.state,
      thread_id: threadId === undefined ? lock.thread_id : threadId,
      updated_at: new Date().toISOString(),
    };
    validateLock(updated);
    const recoveryRequired = lock.state !== "recovery-required" && updated.state === "recovery-required";
    await appendHistory(repositoryState, {
      eventType: recoveryRequired ? "recovery-required" : "lock-updated",
      lockId,
      generation,
      owner: launcherIdentity(lock, "ultra-launcher"),
      reasonCode: recoveryRequired ? "launcher-terminal-failure" : "thread-metadata-updated",
    });
    await atomicWrite(repositoryState.lockPath, updated);
    return updated;
  });
}

export async function registerUltraProcess({
  cwd,
  lockId,
  generation,
  kind,
  pid,
  processIdentity,
  environment = process.env,
  homeDirectory = homedir(),
  processIdentityProvider = createProcessIdentity,
}) {
  if (kind !== "app-server") {
    throw new OrchestrationStateError("Ultra process kind must be app-server.");
  }
  const state = await getRepositoryState(cwd, { environment, homeDirectory });
  return withStateMutex(state, async () => {
    const lock = await assertActiveEpoch(state, { lockId, generation }, "register-ultra-process-stale");
    if (lock.processes.some((entry) => entry.kind === kind)) {
      throw new OrchestrationStateError(`Ultra ${kind} process is already registered.`);
    }
    const identity = processIdentity ?? await processIdentityProvider({ pid });
    validateProcessIdentity(identity);
    const updated = {
      ...lock,
      processes: [...lock.processes, { kind, identity }],
      updated_at: new Date().toISOString(),
    };
    validateLock(updated);
    await atomicWrite(state.lockPath, updated);
    await appendHistory(state, {
      eventType: "lock-updated",
      lockId,
      generation,
      owner: identity,
      reasonCode: "ultra-app-server-registered",
    });
    return updated;
  });
}

export async function beginExecutorRun({
  cwd,
  profile,
  model,
  environment = process.env,
  homeDirectory = homedir(),
  pid = process.pid,
  runId = randomUUID(),
  processIdentityProvider = createProcessIdentity,
  processInspector,
  processAlive,
}) {
  const state = await getRepositoryState(cwd, { environment, homeDirectory });
  const globalState = {
    stateDirectory: state.globalStateDirectory,
    mutexDirectory: state.globalMutexDirectory,
    runsDirectory: state.globalRunsDirectory,
  };
  const pool = requireExecutorPool(model);
  return withStateMutex(globalState, async () => {
    const globalRuns = await removeDeadActiveRuns(globalState, { processInspector, processAlive });
    assertCapacityAvailable("Machine-wide", capacityUsage(globalRuns), pool, profile);
    return withStateMutex(state, async () => {
      const repositoryRuns = await removeDeadActiveRuns(state, { processInspector, processAlive });
      assertNoLegacyState(await readLockFromState(state), await readRuns(state));
      assertCapacityAvailable("Repository", capacityUsage(repositoryRuns), pool, profile);
      const lock = await readLockFromState(state);
      const inheritedLockId = environment[ORCHESTRATION_LOCK_ENV] ?? null;
      const inheritedGenerationValue = environment[ORCHESTRATION_GENERATION_ENV] ?? null;
      const inheritedGeneration = inheritedGenerationValue === null ? null : Number(inheritedGenerationValue);
      if (lock !== null) {
        if (
          lock.state !== "active" ||
          inheritedLockId !== lock.lock_id ||
          !Number.isInteger(inheritedGeneration) ||
          inheritedGeneration !== lock.generation
        ) {
          const detail = inheritedLockId === lock.lock_id && inheritedGeneration !== lock.generation
            ? " The inherited generation does not match."
            : "";
          throw new OrchestrationStateError(`Repository is locked by an exclusive Sol Ultra takeover in state ${lock.state}.${detail}`, {
            lockId: lock.lock_id,
            generation: lock.generation,
          });
        }
      } else if (inheritedLockId !== null || inheritedGenerationValue !== null) {
        throw new OrchestrationStateError("Executor received stale Ultra ownership variables without an active lock.");
      }
      const identity = await processIdentityProvider({ pid });
      validateProcessIdentity(identity);
      await ensureRepositoryMetadata(state);
      await mkdir(state.runsDirectory, { recursive: true });
      await mkdir(globalState.runsDirectory, { recursive: true });
      const timestamp = new Date().toISOString();
      const run = {
        version: ORCHESTRATION_STATE_VERSION,
        run_id: runId,
        repository: state.repository,
        repository_key: state.key,
        state: "active",
        pid,
        processes: [{ kind: "executor-launcher", identity }],
        profile,
        model,
        pool,
        lock_id: lock?.lock_id ?? null,
        generation: lock?.generation ?? null,
        created_at: timestamp,
        updated_at: timestamp,
        result: null,
      };
      const path = join(state.runsDirectory, `${runId}.json`);
      const globalPath = join(globalState.runsDirectory, `${runId}.json`);
      let repositoryLeaseCreated = false;
      let globalLeaseCreated = false;
      try {
        await atomicCreate(path, run);
        repositoryLeaseCreated = true;
        await atomicCreate(globalPath, run);
        globalLeaseCreated = true;
        await appendHistory(state, {
          eventType: "executor-started",
          lockId: run.lock_id,
          generation: run.generation,
          runId,
          profile,
          owner: identity,
          reasonCode: "executor-lease-acquired",
        });
      } catch (error) {
        if (repositoryLeaseCreated) {
          await rm(path, { force: true });
        }
        if (globalLeaseCreated) {
          await rm(globalPath, { force: true });
        }
        throw error;
      }
      return {
        ...run,
        path,
        globalPath,
        stateDirectory: state.stateDirectory,
        globalStateDirectory: globalState.stateDirectory,
      };
    });
  });
}

function statesFromLease(lease) {
  return {
    repository: {
      repository: lease.repository,
      key: lease.repository_key,
      stateDirectory: lease.stateDirectory,
      mutexDirectory: join(lease.stateDirectory, "state.mutex"),
      metadataPath: join(lease.stateDirectory, "repository-state.json"),
      lockDirectory: join(lease.stateDirectory, "ultra.lock"),
      lockPath: join(lease.stateDirectory, "ultra.lock", "lock.json"),
      runsDirectory: join(lease.stateDirectory, "runs"),
      historyDirectory: join(lease.stateDirectory, "history"),
    },
    global: {
      stateDirectory: lease.globalStateDirectory,
      mutexDirectory: join(lease.globalStateDirectory, "state.mutex"),
      runsDirectory: join(lease.globalStateDirectory, "runs"),
    },
  };
}

async function updateGlobalRun(globalPath, expectedRun, updatedRun) {
  if ((await getEntry(globalPath)) === null) {
    throw new OrchestrationStateError(`Global executor lease ${expectedRun.run_id} is missing.`);
  }
  const globalRun = validateRun(await readJson(globalPath, `Global executor lease ${expectedRun.run_id}`), expectedRun.run_id);
  requireMatchingRun(globalRun, expectedRun);
  await atomicWrite(globalPath, updatedRun);
}

export async function registerExecutorProcess(lease, {
  kind,
  pid,
  processIdentity,
  processIdentityProvider = createProcessIdentity,
} = {}) {
  if (kind !== "app-server") {
    throw new OrchestrationStateError("Executor process kind must be app-server.");
  }
  const states = statesFromLease(lease);
  return withStateMutex(states.global, async () => {
    return withStateMutex(states.repository, async () => {
      if (lease.version === ORCHESTRATION_STATE_VERSION && lease.lock_id !== null) {
        await assertActiveEpoch(states.repository, {
          lockId: lease.lock_id,
          generation: lease.generation,
          runId: lease.run_id,
          profile: lease.profile,
          owner: launcherIdentity(lease, "executor-launcher"),
        }, "register-executor-process-stale");
      }
      const run = requireMatchingRun(
        validateRun(await readJson(lease.path, `Executor run ${lease.run_id}`), lease.run_id),
        lease,
      );
      if (run.processes.some((entry) => entry.kind === kind)) {
        throw new OrchestrationStateError(`Executor ${kind} process is already registered.`);
      }
      const identity = processIdentity ?? await processIdentityProvider({ pid });
      validateProcessIdentity(identity);
      const updated = {
        ...run,
        processes: [...run.processes, { kind, identity }],
        updated_at: new Date().toISOString(),
      };
      validateRun(updated, lease.run_id);
      await atomicWrite(lease.path, updated);
      await updateGlobalRun(lease.globalPath, run, updated);
      lease.processes = updated.processes;
      return updated;
    });
  });
}

function executorDescriptor(execution) {
  return {
    profile: execution.result.profile,
    status: execution.result.status,
    thread_id: execution.result.thread_id,
    model: execution.result.model,
    reasoning_effort: execution.result.reasoning_effort,
    service_tier: execution.result.service_tier,
    routing_verified: execution.result.routing_verified,
  };
}

async function assertRegisteredChildrenInactive(run, processInspector, label) {
  const childProcesses = run.processes.filter((entry) => entry.kind === "app-server");
  const statuses = await inspectProcesses(childProcesses, processInspector);
  const unsafe = statuses.find((entry) => ["same", "unknown"].includes(entry.status));
  if (unsafe !== undefined) {
    throw new OrchestrationStateError(`${label} ${unsafe.kind} process state is ${unsafe.status}; the transition is fenced.`);
  }
}

async function removeGlobalLease(globalPath, run) {
  if ((await getEntry(globalPath)) === null) {
    return;
  }
  const globalRun = validateRun(await readJson(globalPath, `Global executor lease ${run.run_id}`), run.run_id);
  requireMatchingRun(globalRun, run);
  await rm(globalPath, { force: false });
}

async function transitionExecutorRun(lease, transition, options = {}) {
  const states = statesFromLease(lease);
  const processInspector = resolveProcessInspector(options);
  return withStateMutex(states.global, async () => {
    return withStateMutex(states.repository, async () => {
      if (lease.version === LEGACY_STATE_VERSION) {
        if (lease.lock_id === null) {
          await rm(lease.path, { force: true });
        } else {
          const legacyLock = await readLockFromState(states.repository);
          if (legacyLock?.version !== LEGACY_STATE_VERSION || legacyLock.lock_id !== lease.lock_id) {
            throw new OrchestrationStateError("Legacy executor lease no longer owns its Ultra lock.");
          }
          const legacyRun = await readJson(lease.path, `Executor run ${lease.run_id}`);
          await atomicWrite(lease.path, transition(legacyRun));
        }
        await rm(lease.globalPath, { force: true });
        return;
      }
      if (lease.lock_id !== null) {
        await assertActiveEpoch(states.repository, {
          lockId: lease.lock_id,
          generation: lease.generation,
          runId: lease.run_id,
          profile: lease.profile,
          owner: launcherIdentity(lease, "executor-launcher"),
        }, transition.reasonCode);
      }
      if ((await getEntry(lease.path)) === null) {
        if (lease.lock_id !== null) {
          await rejectStaleEpoch(states.repository, {
            lockId: lease.lock_id,
            generation: lease.generation,
            runId: lease.run_id,
            profile: lease.profile,
            owner: launcherIdentity(lease, "executor-launcher"),
          }, transition.reasonCode);
        }
        throw new OrchestrationStateError(`Executor run ${lease.run_id} is missing.`);
      }
      const run = requireMatchingRun(
        validateRun(await readJson(lease.path, `Executor run ${lease.run_id}`), lease.run_id),
        lease,
      );
      await assertRegisteredChildrenInactive(run, processInspector, `Executor ${lease.run_id}`);
      const updated = transition(run);
      await appendHistory(states.repository, {
        eventType: updated.state === "completed" ? "executor-completed" : "executor-abandoned",
        lockId: run.lock_id,
        generation: run.generation,
        runId: run.run_id,
        profile: run.profile,
        owner: launcherIdentity(run, "executor-launcher"),
        reasonCode: updated.state === "completed" ? "verified-terminal-result" : "executor-terminal-failure",
      });
      if (run.lock_id === null) {
        await rm(lease.path, { force: false });
      } else {
        await atomicWrite(lease.path, updated);
      }
      await removeGlobalLease(lease.globalPath, run);
    });
  });
}

export async function finishExecutorRun(lease, execution, options = {}) {
  const transition = (run) => ({
    ...run,
    state: "completed",
    updated_at: new Date().toISOString(),
    exit_code: execution.exitCode,
    result: executorDescriptor(execution),
  });
  transition.reasonCode = "finish-executor-stale";
  return transitionExecutorRun(lease, transition, options);
}

export async function abandonExecutorRun(lease, error, options = {}) {
  const transition = (run) => ({
    ...run,
    state: "abandoned",
    updated_at: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  });
  transition.reasonCode = "abandon-executor-stale";
  return transitionExecutorRun(lease, transition, options);
}

export async function listUltraExecutorResults({
  cwd,
  lockId,
  generation,
  environment = process.env,
  homeDirectory = homedir(),
}) {
  const state = await getRepositoryState(cwd, { environment, homeDirectory });
  return withStateMutex(state, async () => {
    await assertActiveEpoch(state, { lockId, generation }, "list-results-stale");
    const runs = (await readRuns(state)).filter((run) => run.lock_id === lockId && run.generation === generation);
    const unfinished = runs.filter((run) => run.state !== "completed");
    if (unfinished.length > 0) {
      throw new OrchestrationStateError(`Ultra takeover has ${unfinished.length} executor run(s) without a verified terminal result.`);
    }
    return runs
      .map((run) => run.result)
      .sort((left, right) => String(left.thread_id).localeCompare(String(right.thread_id)));
  });
}

export async function releaseUltraLock({
  cwd,
  lockId,
  generation,
  environment = process.env,
  homeDirectory = homedir(),
  processInspector,
  processAlive,
}) {
  const state = await getRepositoryState(cwd, { environment, homeDirectory });
  const inspector = resolveProcessInspector({ processInspector, processAlive });
  return withStateMutex(state, async () => {
    const candidate = await readLockFromState(state);
    if (
      candidate?.version === ORCHESTRATION_STATE_VERSION &&
      candidate.lock_id === lockId &&
      candidate.generation === generation &&
      candidate.state === "recovery-required"
    ) {
      throw new OrchestrationStateError("A recovery-required Ultra lock must use exact-id recovery.");
    }
    const lock = await assertActiveEpoch(state, { lockId, generation }, "release-lock-stale");
    const runs = await readRuns(state);
    const unfinished = runs.filter(
      (run) => run.lock_id === lockId && run.generation === generation && run.state !== "completed",
    );
    if (unfinished.length > 0) {
      throw new OrchestrationStateError(`Cannot release Ultra takeover while ${unfinished.length} executor run(s) are unfinished.`);
    }
    await assertRegisteredChildrenInactive(lock, inspector, "Ultra takeover");
    for (const run of runs.filter((entry) => entry.lock_id === lockId && entry.generation === generation)) {
      await assertRegisteredChildrenInactive(run, inspector, `Executor ${run.run_id}`);
    }
    await appendHistory(state, {
      eventType: "lock-released",
      lockId,
      generation,
      owner: launcherIdentity(lock, "ultra-launcher"),
      reasonCode: "verified-terminal-release",
    });
    await rm(state.lockDirectory, { recursive: true, force: false });
    await rm(state.runsDirectory, { recursive: true, force: true });
  });
}

function legacyProcesses(lock, runs) {
  return [
    { kind: "ultra-launcher", pid: lock.pid, run: null },
    ...runs.filter((run) => run.state === "active").map((run) => ({
      kind: "executor-launcher",
      pid: run.pid,
      run,
    })),
  ];
}

async function rejectRecovery(state, lock, reasonCode, message) {
  if (lock.version === ORCHESTRATION_STATE_VERSION) {
    await appendHistory(state, {
      eventType: "recovery-rejected",
      lockId: lock.lock_id,
      generation: lock.generation,
      owner: launcherIdentity(lock, "ultra-launcher"),
      reasonCode,
    });
  }
  throw new OrchestrationStateError(message);
}

export async function recoverUltraLock({
  cwd,
  lockId,
  environment = process.env,
  homeDirectory = homedir(),
  processInspector,
  processAlive,
  confirmLegacyRecovery = false,
}) {
  const state = await getRepositoryState(cwd, { environment, homeDirectory });
  return withStateMutex(state, async () => {
    const lock = await readLockFromState(state);
    if (lock === null) {
      throw new OrchestrationStateError("Repository does not have an Ultra lock.");
    }
    if (lock.lock_id !== lockId) {
      await rejectRecovery(state, lock, "lock-id-mismatch", "The supplied lock id does not match the repository Ultra lock.");
    }
    const runs = await readRuns(state);
    if (lock.version === LEGACY_STATE_VERSION) {
      if (!confirmLegacyRecovery) {
        throw new OrchestrationStateError("Legacy lock recovery requires --confirm-legacy-recovery.");
      }
      const legacyAlive = processAlive ?? isProcessAlive;
      const active = legacyProcesses(lock, runs).find((entry) => legacyAlive(entry.pid));
      if (active !== undefined) {
        throw new OrchestrationStateError(`Legacy ${active.kind} process ${active.pid} is still active.`);
      }
      await ensureRepositoryMetadata(state);
      await appendHistory(state, {
        eventType: "legacy-lock-recovered",
        lockId,
        generation: null,
        reasonCode: "explicit-legacy-recovery",
      });
      await rm(state.lockDirectory, { recursive: true, force: false });
      await rm(state.runsDirectory, { recursive: true, force: true });
      return { status: "recovered", repository: state.repository, lock_id: lockId, generation: null };
    }
    const metadata = await readRepositoryMetadata(state);
    if (metadata === null || metadata.current_generation !== lock.generation) {
      await rejectRecovery(state, lock, "generation-state-mismatch", "Ultra recovery generation does not match repository generation metadata.");
    }
    const inspector = resolveProcessInspector({ processInspector, processAlive });
    const registered = (await inspectProcesses(lock.processes, inspector)).map((entry) => ({
      ...entry,
      scope: "Ultra",
      run: null,
    }));
    for (const run of runs.filter((entry) => entry.lock_id === lockId && entry.generation === lock.generation)) {
      registered.push(...(await inspectProcesses(run.processes, inspector)).map((entry) => ({
        ...entry,
        scope: `executor ${run.run_id}`,
        run,
      })));
    }
    const unsafe = registered.find((entry) => ["same", "unknown"].includes(entry.status));
    if (unsafe !== undefined) {
      await rejectRecovery(
        state,
        lock,
        unsafe.status === "same" ? "registered-process-active" : "registered-process-unknown",
        `${unsafe.scope} ${unsafe.kind} process state is ${unsafe.status === "same" ? "still active" : "unknown"}.`,
      );
    }
    for (const processEntry of registered.filter((entry) => entry.status === "dead")) {
      await appendHistory(state, {
        eventType: "owner-observed-dead",
        lockId,
        generation: lock.generation,
        runId: processEntry.run?.run_id ?? null,
        profile: processEntry.run?.profile ?? null,
        owner: processEntry.identity,
        reasonCode: `${processEntry.kind}-dead`,
      });
    }
    for (const run of runs.filter((entry) =>
      entry.lock_id === lockId && entry.generation === lock.generation && entry.state !== "completed"
    )) {
      await appendHistory(state, {
        eventType: "executor-abandoned",
        lockId,
        generation: lock.generation,
        runId: run.run_id,
        profile: run.profile,
        owner: launcherIdentity(run, "executor-launcher"),
        reasonCode: "recovery-abandoned-run",
      });
      const { path, ...storedRun } = run;
      await atomicWrite(run.path, {
        ...storedRun,
        state: "abandoned",
        updated_at: new Date().toISOString(),
        error: "Abandoned during exact-id recovery.",
      });
    }
    await appendHistory(state, {
      eventType: "lock-recovered",
      lockId,
      generation: lock.generation,
      owner: launcherIdentity(lock, "ultra-launcher"),
      reasonCode: "all-registered-processes-inactive",
    });
    await rm(state.lockDirectory, { recursive: true, force: false });
    await rm(state.runsDirectory, { recursive: true, force: true });
    return {
      status: "recovered",
      repository: state.repository,
      lock_id: lockId,
      generation: lock.generation,
    };
  });
}

async function decorateLegacyProcesses(record, processAlive, kind) {
  return [{ kind, identity: null, pid: record.pid, status: processAlive(record.pid) ? "same" : "dead" }];
}

async function statusRecord(record, inspector, processAlive, launcherKind) {
  if (record.version === LEGACY_STATE_VERSION) {
    return {
      ...record,
      process_statuses: await decorateLegacyProcesses(record, processAlive, launcherKind),
    };
  }
  return { ...record, process_statuses: await inspectProcesses(record.processes, inspector) };
}

export async function readOrchestrationHistory(
  cwd,
  { environment = process.env, homeDirectory = homedir(), limit = DEFAULT_HISTORY_LIMIT } = {},
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
    throw new OrchestrationStateError(`History limit must be an integer between 1 and ${MAX_HISTORY_LIMIT}.`);
  }
  const state = await getRepositoryState(cwd, { environment, homeDirectory });
  return withStateMutex(state, async () => {
    const history = await readHistoryEntries(state);
    return {
      status: "completed",
      repository: state.repository,
      repository_key: state.key,
      events: history.events.slice(-limit).map(({ path, ...event }) => event),
      warnings: history.warnings,
    };
  });
}

export async function getOrchestrationStatus(cwd, options = {}) {
  const {
    environment = process.env,
    homeDirectory = homedir(),
    processInspector,
    processAlive = isProcessAlive,
  } = options;
  const state = await getRepositoryState(cwd, { environment, homeDirectory });
  const globalState = {
    stateDirectory: state.globalStateDirectory,
    mutexDirectory: state.globalMutexDirectory,
    runsDirectory: state.globalRunsDirectory,
  };
  const inspector = resolveProcessInspector({ processInspector });
  return withStateMutex(globalState, async () => {
    const globalRuns = await removeDeadActiveRuns(globalState, { processInspector: inspector });
    return withStateMutex(state, async () => {
      const repositoryActiveRuns = await removeDeadActiveRuns(state, { processInspector: inspector });
      const lock = await readLockFromState(state);
      const runs = await readRuns(state);
      const metadata = await readRepositoryMetadata(state);
      const history = await readHistoryEntries(state);
      const statusRuns = [];
      for (const run of runs) {
        const { path, ...publicRun } = run;
        statusRuns.push(await statusRecord(publicRun, inspector, processAlive, "executor-launcher"));
      }
      const lastHistory = history.events.at(-1);
      return {
        status: "completed",
        repository: state.repository,
        repository_key: state.key,
        generation: {
          current: metadata?.current_generation ?? null,
          lock: lock?.version === ORCHESTRATION_STATE_VERSION ? lock.generation : null,
        },
        legacy_state:
          lock?.version === LEGACY_STATE_VERSION || runs.some((run) => run.version === LEGACY_STATE_VERSION)
            ? "legacy-unfenced"
            : "none",
        lock: lock === null ? null : await statusRecord(lock, inspector, processAlive, "ultra-launcher"),
        runs: statusRuns,
        history: {
          count: history.fileCount,
          last_event: lastHistory === undefined
            ? null
            : (({ path, ...event }) => event)(lastHistory),
          warnings: history.warnings,
        },
        capacity: {
          limits: { ...EXECUTOR_CAPACITY_LIMITS },
          repository: capacityUsage(repositoryActiveRuns),
          machine: capacityUsage(globalRuns),
        },
      };
    });
  });
}
