import { createHash, randomUUID } from "node:crypto";
import {
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

export const ORCHESTRATION_LOCK_ENV = "CODEX_ORCHESTRATION_LOCK_ID";
export const ORCHESTRATION_ROLE_ENV = "CODEX_ORCHESTRATION_ROLE";
export const ULTRA_ORCHESTRATOR_ROLE = "ultra-orchestrator";
export const ULTRA_MODEL = "gpt-5.6-sol";
export const ULTRA_REASONING_EFFORT = "ultra";
export const ULTRA_SERVICE_TIER = "standard";
export const ULTRA_CONFIGURED_SERVICE_TIER = "default";
export const SOL_MODEL_VERBOSITY = "low";

const STATE_VERSION = 1;
const MUTEX_TIMEOUT_MS = 5_000;
const MUTEX_STALE_MS = 30_000;

export const EXECUTOR_CAPACITY_LIMITS = Object.freeze({
  luna: 10,
  sol: 4,
  total: 14,
  playwright: 2,
});

export class OrchestrationStateError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "OrchestrationStateError";
    this.lockId = details.lockId ?? null;
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

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, "utf8");
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

export function isProcessAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid < 1) {
    return false;
  }
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
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
    lockDirectory: join(stateDirectory, "ultra.lock"),
    lockPath: join(stateDirectory, "ultra.lock", "lock.json"),
    runsDirectory: join(stateDirectory, "runs"),
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
          version: STATE_VERSION,
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

function validateLock(lock) {
  if (
    lock === null ||
    typeof lock !== "object" ||
    lock.version !== STATE_VERSION ||
    typeof lock.lock_id !== "string" ||
    lock.lock_id.length === 0 ||
    typeof lock.repository !== "string" ||
    !["active", "recovery-required"].includes(lock.state) ||
    !Number.isInteger(lock.pid) ||
    typeof lock.reason !== "string" ||
    !["read-only", "workspace-write"].includes(lock.sandbox_mode)
  ) {
    throw new OrchestrationStateError("The repository Ultra lock metadata is malformed.");
  }
  return lock;
}

async function readLockFromState(state) {
  if ((await getEntry(state.lockDirectory)) === null) {
    return null;
  }
  return validateLock(await readJson(state.lockPath, "Repository Ultra lock"));
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
    const run = await readJson(path, `Executor run ${entry.name}`);
    if (
      run === null ||
      typeof run !== "object" ||
      run.version !== STATE_VERSION ||
      typeof run.run_id !== "string" ||
      !Number.isInteger(run.pid) ||
      typeof run.profile !== "string" ||
      (run.model !== undefined && typeof run.model !== "string") ||
      (run.pool !== undefined && !["luna", "sol"].includes(run.pool)) ||
      !["active", "completed", "abandoned"].includes(run.state)
    ) {
      throw new OrchestrationStateError(`Executor run ${entry.name} is malformed.`);
    }
    runs.push({ ...run, path });
  }
  return runs;
}

async function removeDeadActiveRuns(state) {
  const runs = await readRuns(state);
  for (const run of runs) {
    if (run.state === "active" && !isProcessAlive(run.pid)) {
      await rm(run.path, { force: true });
    }
  }
  return (await readRuns(state)).filter((run) => run.state === "active");
}

function getRunPool(run) {
  if (["luna", "sol"].includes(run.pool)) {
    return run.pool;
  }
  return "sol";
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
    throw new OrchestrationStateError(
      `${scope} ${pool} executor capacity is full (${usage[pool]}/${EXECUTOR_CAPACITY_LIMITS[pool]}).`,
    );
  }
  if (usage.total >= EXECUTOR_CAPACITY_LIMITS.total) {
    throw new OrchestrationStateError(
      `${scope} total executor capacity is full (${usage.total}/${EXECUTOR_CAPACITY_LIMITS.total}).`,
    );
  }
  if (
    profile === "playwright" &&
    usage.playwright >= EXECUTOR_CAPACITY_LIMITS.playwright
  ) {
    throw new OrchestrationStateError(
      `${scope} Playwright executor capacity is full (${usage.playwright}/${EXECUTOR_CAPACITY_LIMITS.playwright}).`,
    );
  }
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
}) {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new OrchestrationStateError("An Ultra takeover reason is required.");
  }
  const state = await getRepositoryState(cwd, { environment, homeDirectory });
  return withStateMutex(state, async () => {
    const existingLock = await readLockFromState(state);
    if (existingLock !== null) {
      throw new OrchestrationStateError(
        `Repository already has an Ultra lock in state ${existingLock.state}.`,
        { lockId: existingLock.lock_id },
      );
    }
    const activeRuns = await removeDeadActiveRuns(state);
    if (activeRuns.length > 0) {
      throw new OrchestrationStateError(
        `Cannot acquire Ultra takeover while ${activeRuns.length} executor run(s) are active.`,
      );
    }
    await mkdir(state.lockDirectory);
    const timestamp = new Date().toISOString();
    const lock = {
      version: STATE_VERSION,
      lock_id: lockId,
      repository: state.repository,
      repository_key: state.key,
      state: "active",
      role: ULTRA_ORCHESTRATOR_ROLE,
      pid,
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
  state: nextState,
  threadId,
  environment = process.env,
  homeDirectory = homedir(),
}) {
  const repositoryState = await getRepositoryState(cwd, { environment, homeDirectory });
  return withStateMutex(repositoryState, async () => {
    const lock = await readLockFromState(repositoryState);
    if (lock === null || lock.lock_id !== lockId) {
      throw new OrchestrationStateError("The Ultra lock id does not match the active repository lock.");
    }
    const updated = {
      ...lock,
      state: nextState ?? lock.state,
      thread_id: threadId === undefined ? lock.thread_id : threadId,
      updated_at: new Date().toISOString(),
    };
    validateLock(updated);
    await atomicWrite(repositoryState.lockPath, updated);
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
}) {
  const state = await getRepositoryState(cwd, { environment, homeDirectory });
  const globalState = {
    stateDirectory: state.globalStateDirectory,
    mutexDirectory: state.globalMutexDirectory,
    runsDirectory: state.globalRunsDirectory,
  };
  const pool = requireExecutorPool(model);
  return withStateMutex(globalState, async () => {
    const globalRuns = await removeDeadActiveRuns(globalState);
    assertCapacityAvailable("Machine-wide", capacityUsage(globalRuns), pool, profile);
    return withStateMutex(state, async () => {
      const repositoryRuns = await removeDeadActiveRuns(state);
      assertCapacityAvailable("Repository", capacityUsage(repositoryRuns), pool, profile);
      const lock = await readLockFromState(state);
      const inheritedLockId = environment[ORCHESTRATION_LOCK_ENV] ?? null;
      if (
        lock !== null &&
        (lock.state !== "active" || inheritedLockId !== lock.lock_id)
      ) {
        throw new OrchestrationStateError(
          `Repository is locked by an exclusive Sol Ultra takeover in state ${lock.state}.`,
          { lockId: lock.lock_id },
        );
      }
      await mkdir(state.runsDirectory, { recursive: true });
      await mkdir(globalState.runsDirectory, { recursive: true });
      const timestamp = new Date().toISOString();
      const run = {
        version: STATE_VERSION,
        run_id: runId,
        repository: state.repository,
        repository_key: state.key,
        state: "active",
        pid,
        profile,
        model,
        pool,
        lock_id: lock?.lock_id ?? null,
        created_at: timestamp,
        updated_at: timestamp,
        result: null,
      };
      const path = join(state.runsDirectory, `${runId}.json`);
      const globalPath = join(globalState.runsDirectory, `${runId}.json`);
      await atomicWrite(globalPath, run);
      try {
        await atomicWrite(path, run);
      } catch (error) {
        await rm(globalPath, { force: true });
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

function statesFromLease(lease) {
  return {
    repository: {
      stateDirectory: lease.stateDirectory,
      mutexDirectory: join(lease.stateDirectory, "state.mutex"),
      lockDirectory: join(lease.stateDirectory, "ultra.lock"),
      lockPath: join(lease.stateDirectory, "ultra.lock", "lock.json"),
      runsDirectory: join(lease.stateDirectory, "runs"),
    },
    global: {
      stateDirectory: lease.globalStateDirectory,
      mutexDirectory: join(lease.globalStateDirectory, "state.mutex"),
      runsDirectory: join(lease.globalStateDirectory, "runs"),
    },
  };
}

export async function finishExecutorRun(lease, execution) {
  const states = statesFromLease(lease);
  return withStateMutex(states.global, async () => {
    return withStateMutex(states.repository, async () => {
      if (lease.lock_id === null) {
        await rm(lease.path, { force: true });
      } else {
        const run = await readJson(lease.path, `Executor run ${lease.run_id}`);
        await atomicWrite(lease.path, {
          ...run,
          state: "completed",
          updated_at: new Date().toISOString(),
          exit_code: execution.exitCode,
          result: executorDescriptor(execution),
        });
      }
      await rm(lease.globalPath, { force: true });
    });
  });
}

export async function abandonExecutorRun(lease, error) {
  const states = statesFromLease(lease);
  return withStateMutex(states.global, async () => {
    return withStateMutex(states.repository, async () => {
      if (lease.lock_id === null) {
        await rm(lease.path, { force: true });
      } else {
        const run = await readJson(lease.path, `Executor run ${lease.run_id}`);
        await atomicWrite(lease.path, {
          ...run,
          state: "abandoned",
          updated_at: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await rm(lease.globalPath, { force: true });
    });
  });
}

export async function listUltraExecutorResults({
  cwd,
  lockId,
  environment = process.env,
  homeDirectory = homedir(),
}) {
  const state = await getRepositoryState(cwd, { environment, homeDirectory });
  const runs = (await readRuns(state)).filter((run) => run.lock_id === lockId);
  const unfinished = runs.filter((run) => run.state !== "completed");
  if (unfinished.length > 0) {
    throw new OrchestrationStateError(
      `Ultra takeover has ${unfinished.length} executor run(s) without a verified terminal result.`,
    );
  }
  return runs
    .map((run) => run.result)
    .sort((left, right) => String(left.thread_id).localeCompare(String(right.thread_id)));
}

export async function releaseUltraLock({
  cwd,
  lockId,
  environment = process.env,
  homeDirectory = homedir(),
}) {
  const state = await getRepositoryState(cwd, { environment, homeDirectory });
  return withStateMutex(state, async () => {
    const lock = await readLockFromState(state);
    if (lock === null || lock.lock_id !== lockId) {
      throw new OrchestrationStateError("The Ultra lock id does not match the active repository lock.");
    }
    if (lock.state !== "active") {
      throw new OrchestrationStateError("A recovery-required Ultra lock must use exact-id recovery.");
    }
    const unfinished = (await readRuns(state)).filter((run) => run.state !== "completed");
    if (unfinished.length > 0) {
      throw new OrchestrationStateError(
        `Cannot release Ultra takeover while ${unfinished.length} executor run(s) are unfinished.`,
      );
    }
    await rm(state.lockDirectory, { recursive: true, force: false });
    await rm(state.runsDirectory, { recursive: true, force: true });
  });
}

export async function recoverUltraLock({
  cwd,
  lockId,
  environment = process.env,
  homeDirectory = homedir(),
  processAlive = isProcessAlive,
}) {
  const state = await getRepositoryState(cwd, { environment, homeDirectory });
  return withStateMutex(state, async () => {
    const lock = await readLockFromState(state);
    if (lock === null) {
      throw new OrchestrationStateError("Repository does not have an Ultra lock.");
    }
    if (lock.lock_id !== lockId) {
      throw new OrchestrationStateError("The supplied lock id does not match the repository Ultra lock.");
    }
    if (processAlive(lock.pid)) {
      throw new OrchestrationStateError("The Ultra lock owner process is still active.");
    }
    await rm(state.lockDirectory, { recursive: true, force: false });
    await rm(state.runsDirectory, { recursive: true, force: true });
    return { status: "recovered", repository: state.repository, lock_id: lockId };
  });
}

export async function getOrchestrationStatus(cwd, options = {}) {
  const state = await getRepositoryState(cwd, options);
  const globalState = {
    stateDirectory: state.globalStateDirectory,
    mutexDirectory: state.globalMutexDirectory,
    runsDirectory: state.globalRunsDirectory,
  };
  return withStateMutex(globalState, async () => {
    const globalRuns = await removeDeadActiveRuns(globalState);
    return withStateMutex(state, async () => {
      const repositoryActiveRuns = await removeDeadActiveRuns(state);
      return {
        status: "completed",
        repository: state.repository,
        repository_key: state.key,
        lock: await readLockFromState(state),
        runs: (await readRuns(state)).map(({ path, ...run }) => run),
        capacity: {
          limits: { ...EXECUTOR_CAPACITY_LIMITS },
          repository: capacityUsage(repositoryActiveRuns),
          machine: capacityUsage(globalRuns),
        },
      };
    });
  });
}
