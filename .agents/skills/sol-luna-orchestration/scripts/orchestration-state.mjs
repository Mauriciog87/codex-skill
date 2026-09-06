import { createHash, randomUUID } from "node:crypto";
import {
  constants as fileConstants,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { resolveRepositoryIdentity } from "./repository-identity.mjs";
import { ADVANCED_MODEL, ADVANCED_EXECUTOR_POOL, ULTRA_POLICY } from "./model-policy.mjs";
import {
  ProcessIdentityError,
  createProcessIdentity,
  inspectProcessIdentity,
  inspectProcessIdentities,
  isPidAlive,
  validateProcessIdentity,
} from "./process-identity.mjs";

export const ORCHESTRATION_LOCK_ENV = "CODEX_ORCHESTRATION_LOCK_ID";
export const ORCHESTRATION_GENERATION_ENV = "CODEX_ORCHESTRATION_GENERATION";
export const ORCHESTRATION_ROLE_ENV = "CODEX_ORCHESTRATION_ROLE";
export const ULTRA_ORCHESTRATOR_ROLE = "ultra-orchestrator";
export const ULTRA_MODEL = ULTRA_POLICY.model;
export const ULTRA_REASONING_EFFORT = ULTRA_POLICY.reasoningEffort;
export const ULTRA_SERVICE_TIER = ULTRA_POLICY.serviceTier;
export const ULTRA_CONFIGURED_SERVICE_TIER = ULTRA_POLICY.configuredServiceTier;
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

export async function getEntry(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function readJson(path, label) {
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

export async function atomicWrite(path, value) {
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

export async function atomicCreate(path, value) {
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
  let identity;
  try {
    identity = await resolveRepositoryIdentity(resolve(cwd));
  } catch (error) {
    throw new OrchestrationStateError(`Repository identity could not be verified: ${error.message}`);
  }
  return { ...repositoryStatePaths(identity.repository, { environment, homeDirectory, platform }), ...identity };
}

function repositoryStatePaths(repository, { environment = process.env, homeDirectory, platform = process.platform } = {}) {
  const key = getRepositoryKey(repository, platform);
  const stateDirectory = join(
    getCodexHome(environment, homeDirectory),
    "sol-sol-orchestration",
    "state",
    key,
  );
  const worktreesDirectory = join(
    getCodexHome(environment, homeDirectory),
    "sol-sol-orchestration",
    "worktrees",
    key.slice(0, 16),
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
    assignmentsDirectory: join(stateDirectory, "assignments"),
    controlEventsDirectory: join(stateDirectory, "control-events"),
    artifactsDirectory: join(stateDirectory, "artifacts"),
    finalizationsDirectory: join(stateDirectory, "finalizations"),
    worktreesDirectory,
    globalStateDirectory: globalState.stateDirectory,
    globalMutexDirectory: globalState.mutexDirectory,
    globalRunsDirectory: globalState.runsDirectory,
  };
}

export async function getLegacyRepositoryStates(state) {
  const repositories = new Set(state.relatedRepositories ?? []);
  const ownMetadata = await readRepositoryMetadata(state);
  for (const path of ownMetadata?.related_repositories ?? []) repositories.add(path);
  const assignments = await getEntry(state.assignmentsDirectory);
  if (assignments !== null) {
    for (const entry of await readdir(state.assignmentsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) throw new OrchestrationStateError("Assignment namespace contains an unexpected entry.");
      const record = await readJson(join(state.assignmentsDirectory, entry.name, "record.json"), "Assignment identity");
      for (const attempt of [record, ...(record.previous_attempts ?? [])]) {
        for (const path of [attempt.workspace?.path, attempt.workspace?.archive_path]) {
          if (typeof path !== "string") continue;
          const nested = relative(state.worktreesDirectory, path);
          if (nested && !nested.startsWith("..") && !nested.includes(":")) repositories.add(path);
        }
      }
    }
  }
  const states = [];
  for (const repository of repositories) {
    const key = getRepositoryKey(repository);
    if (key === state.key) continue;
    const directory = join(dirname(state.stateDirectory), key);
    if ((await getEntry(directory)) === null) continue;
    const legacy = repositoryStatePaths(repository, { environment: { CODEX_HOME: resolve(state.stateDirectory, "../../..") } });
    legacy.mutexDirectory = state.mutexDirectory;
    legacy.canonicalState = state;
    const metadata = await readRepositoryMetadata(legacy);
    const lock = await readLockFromState(legacy);
    const runs = await readRuns(legacy);
    const pending = [];
    if ((await getEntry(legacy.assignmentsDirectory)) !== null) {
      for (const entry of await readdir(legacy.assignmentsDirectory, { withFileTypes: true })) {
        if (!entry.isDirectory()) throw new OrchestrationStateError("Legacy assignment namespace is malformed.");
        const record = await readJson(join(legacy.assignmentsDirectory, entry.name, "record.json"), "Legacy assignment");
        if (!["acknowledged", "abandoned"].includes(record.state) || (record.workspace?.path && !record.workspace.cleaned && !record.workspace.shared)) pending.push(record.assignment_id);
      }
    }
    states.push({ state: legacy, metadata, lock, runs, pending, blocked: lock !== null || runs.some((run) => run.state === "active") || pending.length > 0 });
  }
  return states;
}

export async function assertNoLegacyRepositoryWork(state) {
  const legacy = (await getLegacyRepositoryStates(state.canonicalState ?? state)).filter((entry) => entry.blocked);
  if (legacy.length > 0) {
    throw new OrchestrationStateError("Linked worktree namespaces contain pending legacy state. Inspect status and recover exact locks or assignments before starting new work.");
  }
}

export async function resolveAssignmentState(cwd, assignmentId, options = {}) {
  const state = await getRepositoryState(cwd, options);
  const candidates = [state, ...(await getLegacyRepositoryStates(state)).map((entry) => entry.state)];
  const found = [];
  for (const candidate of candidates) {
    if ((await getEntry(join(candidate.assignmentsDirectory, assignmentId, "record.json"))) !== null) found.push(candidate);
  }
  if (found.length > 1) throw new OrchestrationStateError("Assignment id exists in multiple repository namespaces.");
  return found[0] ?? state;
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
  if (owner === null || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || isProcessAlive(owner.pid)) {
    return false;
  }
  await rm(state.mutexDirectory, { recursive: true, force: true });
  return true;
}

async function tryStateMutex(state, observational) {
  if (observational && (await getEntry(state.stateDirectory)) === null) return () => {};
  if (!observational) await mkdir(state.stateDirectory, { recursive: true });
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
      return () => rm(state.mutexDirectory, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      if (!observational) await removeStaleMutex(state);
      return null;
    }
}

export async function withCoordinationMutexes(states, action, { operation = "state transition", observational = false } = {}) {
  const startedAt = Date.now();
  while (true) {
    const releases = [];
    let busy;
    try {
      for (const state of states) {
        const release = await tryStateMutex(state, observational);
        if (release === null) { busy = state; break; }
        releases.push(release);
      }
      if (!busy) return await action();
    } finally {
      for (const release of releases.reverse()) await release();
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed >= MUTEX_TIMEOUT_MS) {
      const scope = busy.key ? `repository ${busy.key}` : basename(busy.stateDirectory);
      throw new OrchestrationStateError(`Timed out waiting for the orchestration state mutex (${scope}; ${operation}; waited ${elapsed} ms).`);
    }
    await wait(Math.min(25, MUTEX_TIMEOUT_MS - elapsed));
  }
}

export async function withStateMutex(state, action, options = {}) {
  return withCoordinationMutexes([state], action, options);
}

function canonicalHash(value) {
  const canonical = (item) => Array.isArray(item) ? item.map(canonical) : item !== null && typeof item === "object"
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

async function captureCoordination(states) {
  return Promise.all(states.map(async (state) => ({
    runs: await readRuns(state),
    lock: state.lockPath ? await readLockFromState(state) : null,
    metadata: state.metadataPath ? await readRepositoryMetadata(state) : null,
    finalizations: await pendingFinalizations(state),
  })));
}

async function preparedProcessInspector(records, options = {}) {
  const identities = [...new Map(records.flatMap((record) => [record.lock, ...record.runs])
    .filter(Boolean).flatMap((record) => record.processes ?? []).filter((entry) => !options.inspectionKinds || options.inspectionKinds.includes(entry.kind))
    .map(({ identity }) => [canonicalHash(identity), identity])).values()];
  let results;
  if (options.processInspector || options.processAlive) {
    const inspect = resolveProcessInspector(options);
    results = new Array(identities.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, identities.length) }, async () => {
      while (next < identities.length) {
        const index = next++;
        try { results[index] = await inspect(identities[index]); }
        catch { results[index] = { status: "unknown", reason: "Process inspection failed." }; }
      }
    }));
  } else results = await (options.processBatchInspector ?? inspectProcessIdentities)(identities);
  const cache = new Map(identities.map((identity, index) => [canonicalHash(identity), results[index]]));
  return async (identity) => cache.get(canonicalHash(identity)) ?? { status: "unknown", reason: "Identity was not captured by this preflight." };
}

export async function withInspectedState(states, action, options = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await withCoordinationMutexes(states, () => captureCoordination(states), options);
    const inspector = await preparedProcessInspector([...snapshot, { lock: null, runs: [{ processes: options.additionalProcesses ?? [] }] }], options);
    let changed = false;
    const result = await withCoordinationMutexes(states, async () => {
      if (canonicalHash(snapshot) !== canonicalHash(await captureCoordination(states))) { changed = true; return; }
      for (const state of states.filter((entry) => entry.repository)) {
        const canonical = state.canonicalState ?? state;
        const identity = await resolveRepositoryIdentity(canonical.repository);
        if (getRepositoryKey(identity.repository) !== canonical.key) throw new OrchestrationStateError("Repository identity changed during process inspection.");
      }
      return action(inspector);
    }, options);
    if (!changed) return result;
  }
  throw new OrchestrationStateError(`Coordination conflict during ${options.operation ?? "state transition"}: records changed during all three preflight attempts.`);
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

export async function readLockFromState(state) {
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
    (value.related_repositories !== undefined && (!Array.isArray(value.related_repositories) || value.related_repositories.some((path) => typeof path !== "string" || path.length === 0))) ||
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

export async function ensureRepositoryMetadata(state) {
  const existing = await readRepositoryMetadata(state);
  if (existing !== null) {
    const related = [...new Set([...(existing.related_repositories ?? []), ...(state.relatedRepositories ?? [])])];
    if (JSON.stringify(related) !== JSON.stringify(existing.related_repositories ?? [])) {
      const updated = { ...existing, related_repositories: related };
      await atomicWrite(state.metadataPath, updated);
      return updated;
    }
    return existing;
  }
  const metadata = {
    version: ORCHESTRATION_STATE_VERSION,
    repository: state.repository,
    repository_key: state.key,
    current_generation: 0,
    history_sequence: 0,
    related_repositories: state.relatedRepositories ?? [],
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
    || (run.assignment_id !== undefined && run.assignment_id !== null && !/^[0-9a-f-]{36}$/i.test(run.assignment_id))
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
  return runs.sort((left, right) => left.run_id.localeCompare(right.run_id));
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

async function readHistoryEntries(state, maximumSequence = Infinity, capturedNames) {
  if ((await getEntry(state.historyDirectory)) === null) {
    return { events: [], warnings: capturedNames?.length ? ["History snapshot is incomplete: captured entries were removed."] : [], fileCount: capturedNames?.length ?? 0 };
  }
  const entries = capturedNames ? capturedNames.map((name) => ({ name })) : (await readdir(state.historyDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .filter((entry) => !Number.isFinite(Number(entry.name.split("-")[0])) || Number(entry.name.split("-")[0]) <= maximumSequence)
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
      if (event.sequence <= maximumSequence) events.push({ ...event, path: join(state.historyDirectory, entry.name) });
    } catch (error) {
      warnings.push(`History snapshot is incomplete: ${error.message}`);
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

export async function assertRepositoryQuiescent(state, assignmentId, options = {}) {
  if ((await pendingFinalizations(state)).some((receipt) => receipt.assignment_id === assignmentId)) throw new OrchestrationStateError("Assignment has a pending finalization; recover the saved result before cleaning its worktree.");
  const runs = (await readRuns(state)).filter((run) => run.assignment_id === assignmentId ||
    (run.state === "active" && (run.assignment_id === undefined || run.assignment_id === null)));
  for (const run of runs) {
    if (run.version === LEGACY_STATE_VERSION) {
      if (isProcessAlive(run.pid)) throw new OrchestrationStateError("Workspace still has a live or unknown legacy executor.");
    } else {
      const inspections = await inspectProcesses(run.processes, resolveProcessInspector(options));
      if (inspections.some((entry) => !["dead", "reused"].includes(entry.status))) {
        throw new OrchestrationStateError("Workspace still has a live or unknown executor process.");
      }
    }
  }
}

async function removeDeadActiveRuns(state, options = {}) {
  const processInspector = resolveProcessInspector(options);
  const repositoryState = typeof state.historyDirectory === "string";
  const runs = await readRuns(state);
  for (const run of runs) {
    if (run.state !== "active") {
      continue;
    }
    const receiptState = repositoryState ? state : { stateDirectory: join(dirname(state.stateDirectory), run.repository_key) };
    if ((await pendingFinalizations(receiptState)).some((receipt) => receipt.run_id === run.run_id)) continue;
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
    if (repositoryState && options.globalState) {
      const path = join(options.globalState.runsDirectory, `${run.run_id}.json`);
      if ((await getEntry(path)) !== null && canonicalHash(await readJson(path, "Orphan global lease")) !== canonicalHash((({ path, ...value }) => value)(run))) throw new OrchestrationStateError("Orphan lease differs between repository and machine reservations.");
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
    if (repositoryState && options.globalState) await rm(join(options.globalState.runsDirectory, `${run.run_id}.json`), { force: true });
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

async function reservedRuns(state, runs) {
  const pending = await pendingFinalizations(state);
  const reservations = new Map(runs.filter((run) => run.state === "active").map((run) => [run.run_id, run]));
  for (const receipt of pending) if (!reservations.has(receipt.run_id)) reservations.set(receipt.run_id, receipt);
  return [...reservations.values()];
}

function requireExecutorPool(model) {
  if (model === "gpt-5.6-luna") {
    return "luna";
  }
  if (model === ADVANCED_MODEL) {
    return ADVANCED_EXECUTOR_POOL;
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
  await assertNoLegacyRepositoryWork(state);
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
  processInspector,
}) {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new OrchestrationStateError("An Ultra takeover reason is required.");
  }
  const state = await getRepositoryState(cwd, { environment, homeDirectory });
  const ownerIdentity = await processIdentityProvider({ pid });
  validateProcessIdentity(ownerIdentity);
  const globalState = getGlobalCapacityState({ environment, homeDirectory });
  return withInspectedState([globalState, state], async (inspector) => {
    await assertNoLegacyRepositoryWork(state);
    if ((await pendingFinalizations(state)).length > 0) throw new OrchestrationStateError("Cannot acquire Ultra takeover while a pending finalization needs explicit recovery.");
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
    const activeRuns = await removeDeadActiveRuns(state, { processInspector: inspector, globalState });
    const allRuns = await readRuns(state);
    assertNoLegacyState(null, allRuns);
    if (activeRuns.length > 0) {
      throw new OrchestrationStateError(`Cannot acquire Ultra takeover while ${activeRuns.length} executor run(s) are active.`);
    }
    if ((await getEntry(state.assignmentsDirectory)) !== null) {
      for (const entry of await readdir(state.assignmentsDirectory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const assignment = await readJson(join(state.assignmentsDirectory, entry.name, "record.json"), "Assignment execution state");
        if (assignment.state === "running") throw new OrchestrationStateError("Cannot acquire Ultra takeover while an assignment is running.");
      }
    }
    const metadata = await ensureRepositoryMetadata(state);
    const legacyGenerations = (await getLegacyRepositoryStates(state)).map((entry) => entry.metadata?.current_generation ?? 0);
    const generation = Math.max(metadata.current_generation, ...legacyGenerations) + 1;
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
  }, { processInspector, operation: "acquire Ultra lock" });
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
  const identity = processIdentity ?? await processIdentityProvider({ pid });
  validateProcessIdentity(identity);
  const state = await getRepositoryState(cwd, { environment, homeDirectory });
  return withStateMutex(state, async () => {
    const lock = await assertActiveEpoch(state, { lockId, generation }, "register-ultra-process-stale");
    if (lock.processes.some((entry) => entry.kind === kind)) {
      throw new OrchestrationStateError(`Ultra ${kind} process is already registered.`);
    }
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
  const identity = await processIdentityProvider({ pid });
  validateProcessIdentity(identity);
  return withInspectedState([globalState, state], async (inspector) => {
    const repositoryRuns = await removeDeadActiveRuns(state, { processInspector: inspector, globalState });
    const globalRuns = await reservedRuns(globalState, await readRuns(globalState));
    assertCapacityAvailable("Machine-wide", capacityUsage(globalRuns), pool, profile);
      await assertNoLegacyRepositoryWork(state);
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
          throw new OrchestrationStateError(`Repository is locked by an exclusive Ultra takeover in state ${lock.state}.${detail}`, {
            lockId: lock.lock_id,
            generation: lock.generation,
          });
        }
      } else if (inheritedLockId !== null || inheritedGenerationValue !== null) {
        throw new OrchestrationStateError("Executor received stale Ultra ownership variables without an active lock.");
      }
      await ensureRepositoryMetadata(state);
      await mkdir(state.runsDirectory, { recursive: true });
      await mkdir(globalState.runsDirectory, { recursive: true });
      const timestamp = new Date().toISOString();
      const run = {
        version: ORCHESTRATION_STATE_VERSION,
        run_id: runId,
        assignment_id: environment.CODEX_ORCHESTRATION_ASSIGNMENT_ID ?? null,
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
  }, { processInspector, processAlive, operation: "acquire executor lease" });
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
      finalizationsDirectory: join(lease.stateDirectory, "finalizations"),
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
  if (canonicalHash(globalRun) !== canonicalHash(expectedRun)) throw new OrchestrationStateError("Global and repository executor records differ before registration.");
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
  const identity = processIdentity ?? await processIdentityProvider({ pid });
  validateProcessIdentity(identity);
  return withCoordinationMutexes([states.global, states.repository], async () => {
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
  }, { operation: "register executor process" });
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
  if (canonicalHash(globalRun) !== canonicalHash(run)) throw new OrchestrationStateError("Global and repository executor records differ before closure.");
  await rm(globalPath, { force: false });
}

async function transitionExecutorRun(lease, transition, options = {}) {
  const states = statesFromLease(lease);
  return withInspectedState([states.global, states.repository], async (processInspector) => {
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
  }, { ...options, inspectionKinds: ["app-server"], operation: "close executor lease" });
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

function finalizationPaths(state, runId) {
  if (typeof runId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId)) throw new OrchestrationStateError("Finalization run id is invalid.");
  const directory = join(state.stateDirectory, "finalizations", runId);
  return { directory, receipt: join(directory, "receipt.json"), confirmation: join(directory, "completed.json"), closure: join(directory, "closure.json"), publication: join(directory, "publication.json") };
}

export async function readExecutorFinalization(state, runId) {
  const paths = finalizationPaths(state, runId);
  const receipt = await readJson(paths.receipt, `Finalization ${runId}`);
  const { receipt_sha256: digest, ...body } = receipt;
  if (receipt.version !== 1 || receipt.run_id !== runId || receipt.repository_key !== basename(state.stateDirectory) || canonicalHash(body) !== digest || canonicalHash(receipt.execution) !== receipt.result_sha256) {
    throw new OrchestrationStateError(`Finalization ${runId} failed its identity or hash verification.`);
  }
  validateRun(receipt.run, runId);
  if (receipt.run.repository_key !== receipt.repository_key || receipt.run.run_id !== runId || receipt.execution.result.profile !== receipt.run.profile) throw new OrchestrationStateError("Finalization lease binding does not match.");
  return receipt;
}

async function pendingFinalizations(state) {
  if (basename(state.stateDirectory) === "global-capacity") {
    const parent = dirname(state.stateDirectory);
    if ((await getEntry(parent)) === null) return [];
    const summaries = [];
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (/^[a-f0-9]{64}$/.test(entry.name)) {
        if (!entry.isDirectory()) throw new OrchestrationStateError("Repository state namespace is not a directory.");
        summaries.push(...await pendingFinalizations({ stateDirectory: join(parent, entry.name) }));
      }
    }
    return summaries.sort((a, b) => a.repository_key.localeCompare(b.repository_key) || a.run_id.localeCompare(b.run_id));
  }
  const directory = join(state.stateDirectory, "finalizations");
  if ((await getEntry(directory)) === null) return [];
  const summaries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory()) throw new OrchestrationStateError("Finalization namespace contains an unexpected entry.");
    const paths = finalizationPaths(state, entry.name);
    if ((await getEntry(paths.confirmation)) !== null) {
      const confirmation = await readJson(paths.confirmation, "Finalization confirmation");
      const manifest = await readJson(join(paths.directory, "manifest.json"), "Finalization manifest");
      if (confirmation.version !== 1 || manifest.version !== 1 || confirmation.receipt_sha256 !== manifest.receipt_sha256 || manifest.run_id !== entry.name) throw new OrchestrationStateError("Finalization confirmation does not match its receipt.");
      continue;
    }
    const receipt = await readExecutorFinalization(state, entry.name);
    summaries.push({ run_id: receipt.run_id, repository_key: receipt.repository_key, pool: receipt.run.pool, profile: receipt.run.profile, thread_id: receipt.execution.result.thread_id, lock_id: receipt.run.lock_id, generation: receipt.run.generation, assignment_id: receipt.assignment?.assignment_id ?? null, expected_revision: receipt.assignment?.state_revision ?? null, created_at: receipt.created_at });
  }
  return summaries.sort((a, b) => a.run_id.localeCompare(b.run_id));
}

export async function saveExecutorFinalization(lease, execution, { assignment = null, workspaceFingerprint = null } = {}) {
  const states = statesFromLease(lease);
  const paths = finalizationPaths(states.repository, lease.run_id);
  const run = requireMatchingRun(validateRun(await readJson(lease.path, "Executor finalization lease"), lease.run_id), lease);
  const storedExecution = { exitCode: execution.exitCode, result: execution.result, ...(execution.operatorRequests ? { operatorRequests: execution.operatorRequests } : {}) };
  if (![0, 1, 2].includes(execution.exitCode) || execution.result?.profile !== run.profile) throw new OrchestrationStateError("Executor result cannot be bound to its finalization lease.");
  const body = { version: 1, run_id: run.run_id, repository: run.repository, repository_key: run.repository_key, run, assignment, workspace_fingerprint: workspaceFingerprint, execution: storedExecution, result_sha256: canonicalHash(storedExecution), created_at: new Date().toISOString() };
  const receipt = { ...body, receipt_sha256: canonicalHash(body) };
  await mkdir(dirname(paths.directory), { recursive: true });
  const temporary = join(dirname(paths.directory), `.${run.run_id}-${randomUUID()}`);
  await mkdir(temporary);
  try {
    await atomicWrite(join(temporary, "receipt.json"), receipt);
    await atomicWrite(join(temporary, "manifest.json"), { version: 1, run_id: receipt.run_id, receipt_sha256: receipt.receipt_sha256 });
    try { await rename(temporary, paths.directory); }
    catch (error) {
      if ((await getEntry(paths.directory)) === null) throw error;
      const prior = await readExecutorFinalization(states.repository, run.run_id);
      if (prior.result_sha256 !== receipt.result_sha256 || canonicalHash(prior.run) !== canonicalHash(run) || canonicalHash(prior.assignment) !== canonicalHash(assignment) || prior.workspace_fingerprint !== workspaceFingerprint) throw new OrchestrationStateError("Finalization run id already belongs to different evidence.");
      return prior;
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return receipt;
}

export function finalizationFailure(execution, lease, error, revision = null) {
  const command = `node .agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs finalize --cwd ${JSON.stringify(lease.repository)} --run-id ${lease.run_id}${revision === null ? "" : ` --expected-revision ${revision}`}`;
  const message = `Result saved for run ${lease.run_id}, but finalization failed: ${error.message ?? String(error)}. Recover explicitly with: ${command}`;
  return { ...execution, exitCode: 2, finalizationPending: true, result: { ...execution.result, status: "failed", summary: message, blockers: [...(execution.result.blockers ?? []), message] } };
}

export async function validateExecutorFinalization(lease, receipt, options = {}) {
  const states = statesFromLease(lease);
  return withInspectedState([states.global, states.repository], async (inspector) => {
    const current = await readExecutorFinalization(states.repository, lease.run_id);
    if (current.receipt_sha256 !== receipt.receipt_sha256) throw new OrchestrationStateError("Finalization receipt was replaced.");
    if (receipt.run.lock_id !== null) {
      await assertActiveEpoch(states.repository, { lockId: receipt.run.lock_id, generation: receipt.run.generation }, "finalization-stale");
      const environment = options.environment ?? process.env;
      if (environment[ORCHESTRATION_LOCK_ENV] !== receipt.run.lock_id || environment[ORCHESTRATION_GENERATION_ENV] !== String(receipt.run.generation)) throw new OrchestrationStateError("Finalization requires the active Ultra owner's lock id and generation.");
    } else if ((await readLockFromState(states.repository)) !== null) throw new OrchestrationStateError("A normal finalization cannot cross an Ultra epoch.");
    const inspected = await inspectProcesses(options.manual ? receipt.run.processes : receipt.run.processes.filter((entry) => entry.kind === "app-server"), inspector);
    if (inspected.some((entry) => !["dead", "reused"].includes(entry.status))) throw new OrchestrationStateError("Finalization is blocked by live or unknown process identities.");
    const paths = finalizationPaths(states.repository, lease.run_id);
    for (const path of [lease.path, lease.globalPath]) {
      if ((await getEntry(path)) === null) {
        if ((await getEntry(paths.closure)) === null) throw new OrchestrationStateError("Finalization reservation is missing without closure evidence.");
      } else {
        const run = await readJson(path, "Finalization reservation");
        requireMatchingRun(run, receipt.run);
        if (run.state === "active" && canonicalHash(run) !== canonicalHash(receipt.run)) throw new OrchestrationStateError("Finalization reservation changed.");
      }
    }
  }, { ...options, additionalProcesses: receipt.run.processes, inspectionKinds: options.manual ? undefined : ["app-server"], operation: "validate saved executor result" });
}

export async function closeExecutorFinalization(lease, receipt, options = {}) {
  const states = statesFromLease(lease);
  const paths = finalizationPaths(states.repository, lease.run_id);
  return withInspectedState([states.global, states.repository], async (inspector) => {
    const currentReceipt = await readExecutorFinalization(states.repository, lease.run_id);
    if (currentReceipt.receipt_sha256 !== receipt.receipt_sha256) throw new OrchestrationStateError("Finalization receipt changed during coordination.");
    if ((await getEntry(paths.confirmation)) !== null) {
      const confirmation = await readJson(paths.confirmation, "Finalization confirmation");
      if (confirmation.receipt_sha256 !== receipt.receipt_sha256) throw new OrchestrationStateError("Finalization confirmation mismatch.");
      return;
    }
    if (receipt.run.lock_id !== null) await assertActiveEpoch(states.repository, { lockId: receipt.run.lock_id, generation: receipt.run.generation }, "finalization-stale");
    else if ((await readLockFromState(states.repository)) !== null) throw new OrchestrationStateError("A normal finalization cannot cross an Ultra epoch.");
    const inspections = await inspectProcesses(options.manual ? receipt.run.processes : receipt.run.processes.filter((entry) => entry.kind === "app-server"), inspector);
    if (inspections.some((entry) => !["dead", "reused"].includes(entry.status))) throw new OrchestrationStateError("Finalization is blocked by live or unknown process identities.");
    const completedRun = { ...receipt.run, state: "completed", exit_code: receipt.execution.exitCode, result: executorDescriptor(receipt.execution), updated_at: receipt.created_at };
    for (const [path, allowCompleted] of [[lease.path, receipt.run.lock_id !== null], [lease.globalPath, false]]) {
      if ((await getEntry(path)) === null) {
        if ((await getEntry(paths.closure)) === null) throw new OrchestrationStateError("Finalization lease is missing without closure evidence.");
      } else {
        const run = await readJson(path, "Finalization current lease");
        if (canonicalHash(run) !== canonicalHash(receipt.run) && !(allowCompleted && canonicalHash(run) === canonicalHash(completedRun))) throw new OrchestrationStateError("Finalization lease changed after the result was saved.");
      }
    }
    let closure;
    if ((await getEntry(paths.closure)) === null) {
      const metadata = await ensureRepositoryMetadata(states.repository);
      const event = { version: 2, event_id: randomUUID(), sequence: metadata.history_sequence + 1, event_type: "executor-completed", repository: receipt.repository, repository_key: receipt.repository_key, lock_id: receipt.run.lock_id, generation: receipt.run.generation, run_id: receipt.run_id, profile: receipt.run.profile, owner: historyOwner(launcherIdentity(receipt.run, "executor-launcher")), timestamp: receipt.created_at, reason_code: "verified-terminal-result", description: EVENT_DESCRIPTIONS["executor-completed"] };
      const body = { version: 1, receipt_sha256: receipt.receipt_sha256, event };
      closure = { ...body, closure_sha256: canonicalHash(body) };
      await atomicWrite(states.repository.metadataPath, { ...metadata, history_sequence: event.sequence, updated_at: new Date().toISOString() });
      await atomicCreate(paths.closure, closure);
      await options.onFinalizationBoundary?.("closure-prepared");
    } else closure = await readJson(paths.closure, "Finalization closure");
    const { closure_sha256: closureHash, ...closureBody } = closure;
    if (canonicalHash(closureBody) !== closureHash || closure.receipt_sha256 !== receipt.receipt_sha256 || closure.event?.run_id !== receipt.run_id) throw new OrchestrationStateError("Finalization closure evidence is invalid.");
    const metadata = await ensureRepositoryMetadata(states.repository);
    if (metadata.history_sequence < closure.event.sequence) await atomicWrite(states.repository.metadataPath, { ...metadata, history_sequence: closure.event.sequence, updated_at: new Date().toISOString() });
    const eventPath = join(states.repository.historyDirectory, `${String(closure.event.sequence).padStart(16, "0")}-${closure.event.event_id}.json`);
    if ((await getEntry(eventPath)) === null) await atomicCreate(eventPath, closure.event);
    else if (canonicalHash(await readJson(eventPath, "Finalization history")) !== canonicalHash(closure.event)) throw new OrchestrationStateError("Finalization history conflicts with its receipt.");
    await options.onFinalizationBoundary?.("history-written");
    if (receipt.run.lock_id === null) await rm(lease.path, { force: true });
    else await atomicWrite(lease.path, completedRun);
    await options.onFinalizationBoundary?.("local-closed");
    await rm(lease.globalPath, { force: true });
    await options.onFinalizationBoundary?.("global-closed");
    await atomicCreate(paths.confirmation, { version: 1, receipt_sha256: receipt.receipt_sha256, completed_at: new Date().toISOString() });
    await options.onFinalizationBoundary?.("confirmed");
  }, { ...options, additionalProcesses: receipt.run.processes, inspectionKinds: options.manual ? undefined : ["app-server"], operation: "finalize saved executor result" });
}

export async function finalizeExecutorReceipt({ cwd, runId, expectedRevision, ...options }) {
  const state = await getRepositoryState(cwd, options);
  const receipt = await readExecutorFinalization(state, runId);
  const paths = finalizationPaths(state, runId);
  return withStateMutex({ stateDirectory: paths.directory, mutexDirectory: join(paths.directory, "finalize.mutex") }, async () => {
  if (receipt.assignment !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision !== receipt.assignment.state_revision)) throw new OrchestrationStateError("Assignment finalization requires its exact --expected-revision.");
  if (receipt.assignment === null && expectedRevision !== undefined) throw new OrchestrationStateError("--expected-revision applies only to assignment finalizations.");
  const lease = { ...receipt.run, path: join(state.runsDirectory, `${runId}.json`), globalPath: join(state.globalRunsDirectory, `${runId}.json`), stateDirectory: state.stateDirectory, globalStateDirectory: state.globalStateDirectory };
  if ((await getEntry(paths.confirmation)) !== null) {
    const confirmation = await readJson(paths.confirmation, "Finalization confirmation");
    if (confirmation.receipt_sha256 !== receipt.receipt_sha256) throw new OrchestrationStateError("Finalization confirmation mismatch.");
    return { status: "completed", run_id: runId, repository: state.repository };
  }
  await validateExecutorFinalization(lease, receipt, { ...options, manual: true });
  if (receipt.assignment !== null) {
    const { resumeExecutorFinalization } = await import("./durable-executor.mjs");
    await resumeExecutorFinalization({ state, lease, receipt, expectedRevision, ...options });
  }
  await closeExecutorFinalization(lease, receipt, { ...options, manual: true });
  return { status: "completed", run_id: runId, repository: state.repository };
  }, { operation: `finalize run ${runId}` });
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
  return withInspectedState([state], async (inspector) => {
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
  }, { processInspector, processAlive, inspectionKinds: ["app-server"], operation: "release Ultra lock" });
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
  const canonical = await getRepositoryState(cwd, { environment, homeDirectory });
  const matches = [];
  for (const namespace of [canonical, ...(await getLegacyRepositoryStates(canonical)).map((entry) => entry.state)]) {
    if ((await readLockFromState(namespace))?.lock_id === lockId) matches.push(namespace);
  }
  if (matches.length > 1) throw new OrchestrationStateError("Lock id exists in multiple repository namespaces.");
  const state = matches[0] ?? canonical;
  return withInspectedState([state], async (inspector) => {
    if (state.canonicalState) await ensureRepositoryMetadata(canonical);
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
  }, { processInspector, processAlive, operation: "recover Ultra lock" });
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
  const snapshot = await withStateMutex(state, async () => {
    const legacy = await getLegacyRepositoryStates(state);
    const captures = [];
    for (const namespace of [state, ...legacy.map((entry) => entry.state)]) {
      const metadata = await readRepositoryMetadata(namespace);
      const names = (await getEntry(namespace.historyDirectory)) === null ? [] : (await readdir(namespace.historyDirectory)).filter((name) => name.endsWith(".json") && (!Number.isFinite(Number(name.split("-")[0])) || Number(name.split("-")[0]) <= (metadata?.history_sequence ?? 0)));
      captures.push({ state: namespace, sequence: metadata?.history_sequence ?? 0, names });
    }
    return captures;
  }, { operation: "history snapshot", observational: true });
    const history = { events: [], warnings: [] };
    for (const entry of snapshot) {
      const previous = await readHistoryEntries(entry.state, entry.sequence, entry.names);
      history.events.push(...previous.events);
      history.warnings.push(...previous.warnings);
    }
    if (snapshot.length > 1) history.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.repository_key.localeCompare(b.repository_key) || a.sequence - b.sequence);
    return {
      status: "completed",
      repository: state.repository,
      repository_key: state.key,
      events: history.events.slice(-limit).map(({ path, ...event }) => event),
      warnings: history.warnings,
    };
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
  const snapshot = await withCoordinationMutexes([globalState, state], async () => {
      const globalRuns = await reservedRuns(globalState, await readRuns(globalState));
      const lock = await readLockFromState(state);
      const runs = await readRuns(state);
      const metadata = await readRepositoryMetadata(state);
      const legacyNamespaces = await getLegacyRepositoryStates(state);
      const historyNames = (await getEntry(state.historyDirectory)) === null ? [] : (await readdir(state.historyDirectory))
        .filter((name) => name.endsWith(".json") && (!Number.isFinite(Number(name.split("-")[0])) || Number(name.split("-")[0]) <= (metadata?.history_sequence ?? 0)));
      const pending = await pendingFinalizations(state);
      return { globalRuns, lock, runs, metadata, legacyNamespaces, historyNames, pending, snapshotAt: new Date().toISOString() };
  }, { operation: "status snapshot", observational: true });
      const { globalRuns, lock, runs, metadata, legacyNamespaces } = snapshot;
      const inspector = await preparedProcessInspector([{ lock, runs: [...runs, ...globalRuns] }, ...legacyNamespaces], { processInspector, processBatchInspector: options.processBatchInspector });
      const history = await readHistoryEntries(state, metadata?.history_sequence ?? 0, snapshot.historyNames);
      const statusRuns = [];
      for (const run of runs) {
        const { path, ...publicRun } = run;
        statusRuns.push(await statusRecord(publicRun, inspector, processAlive, "executor-launcher"));
      }
      const lastHistory = history.events.at(-1);
      return {
        status: "completed",
        snapshot_at: snapshot.snapshotAt,
        repository: state.repository,
        repository_key: state.key,
        legacy_namespaces: legacyNamespaces.map((entry) => ({
          repository: entry.state.repository,
          repository_key: entry.state.key,
          lock_id: entry.lock?.lock_id ?? null,
          generation: entry.metadata?.current_generation ?? null,
          active_run_ids: entry.runs.filter((run) => run.state === "active").map((run) => run.run_id),
          pending_assignment_ids: entry.pending,
          blocked: entry.blocked,
        })),
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
        pending_finalizations: snapshot.pending,
        orphaned_run_ids: statusRuns.filter((run) => run.state === "active" && run.process_statuses.every((entry) => ["dead", "reused"].includes(entry.status))).map((run) => run.run_id),
        history: {
          count: history.fileCount,
          last_event: lastHistory === undefined
            ? null
            : (({ path, ...event }) => event)(lastHistory),
          warnings: history.warnings,
        },
        capacity: {
          limits: { ...EXECUTOR_CAPACITY_LIMITS },
          repository: capacityUsage([...new Map([...runs.filter((run) => run.state === "active"), ...snapshot.pending].map((run) => [run.run_id, run])).values()]),
          machine: capacityUsage(globalRuns),
        },
      };
}
