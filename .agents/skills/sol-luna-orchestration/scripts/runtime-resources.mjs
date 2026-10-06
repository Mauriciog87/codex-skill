import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { atomicCreate, atomicWrite, getGlobalCapacityState, withCoordinationMutexes, readLockFromState, ORCHESTRATION_LOCK_ENV, ORCHESTRATION_GENERATION_ENV } from "./orchestration-state.mjs";
import { createProcessIdentity, inspectProcessIdentities, validateProcessIdentity } from "./process-identity.mjs";

const NAME = /^[a-z][a-z0-9_-]{0,47}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED_ENV = /^(?:PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|COMSPEC|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|GIT_.*|CODEX_.*|PLAYWRIGHT_.*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validateRuntimeResources(value = []) {
  if (!Array.isArray(value) || value.length > 32) throw new Error("runtime_resources must be an array of at most 32 resources.");
  const names = new Set(), keys = new Set(), variables = new Set();
  return value.map((resource) => {
    if (!resource || typeof resource !== "object" || Array.isArray(resource) || Object.keys(resource).some((key) => !["name", "kind", "mode", "key", "env"].includes(key))) throw new Error("Each runtime resource must be an object with only name, kind, mode, key, and env fields.");
    const { name, kind, mode, key = null, env = null } = resource;
    if (typeof name !== "string" || !NAME.test(name) || !["port", "database", "cache", "directory", "service"].includes(kind) || !["exclusive", "isolated"].includes(mode)) throw new Error("Invalid runtime resource name, kind, or mode.");
    if (env !== null && (typeof env !== "string" || !ENV.test(env) || RESERVED_ENV.test(env))) throw new Error("Runtime environment variable is invalid or reserved.");
    if (mode === "exclusive" && (typeof key !== "string" || !KEY.test(key))) throw new Error("Exclusive resource key must be a non-secret identifier, not a URL or path.");
    if (mode === "isolated" && (key !== null || !["database", "cache", "directory"].includes(kind) || env === null)) throw new Error("An isolated resource must use kind database, cache, or directory. Set env and leave key unset.");
    if (kind === "port" && (!/^[1-9][0-9]*$/.test(key ?? "") || Number(key) > 65535)) throw new Error("Port keys must be integers between 1 and 65535.");
    if (mode === "exclusive" && env !== null && !["port", "database"].includes(kind)) throw new Error("Only exclusive port and database resources can set an environment variable. Leave env unset for other exclusive resources.");
    const resourceKey = `${kind}:${key}`;
    if (names.has(name) || (env !== null && variables.has(env)) || (mode === "exclusive" && keys.has(resourceKey))) throw new Error("Duplicate runtime resource, key, or environment variable.");
    names.add(name); variables.add(env); if (mode === "exclusive") keys.add(resourceKey);
    return { name, kind, mode, key, env };
  });
}

function stateRoot(options) {
  const environment = options.environment ?? process.env;
  return resolve(options.stateRoot ?? join(getGlobalCapacityState({ environment, homeDirectory: options.homeDirectory ?? environment.HOME }).stateDirectory, "runtime-resources"));
}

function withRuntimeMutex(root, action, options = {}) {
  const states = [{ stateDirectory: dirname(root), mutexDirectory: `${root}.mutex` }, ...(options.repositoryState ? [options.repositoryState] : [])];
  return withCoordinationMutexes(states, async () => {
    if (options.repositoryState) {
      const lock = await readLockFromState(options.repositoryState);
      const environment = options.environment ?? process.env;
      if (lock !== null && (lock.state !== "active" || lock.version !== 2 || environment[ORCHESTRATION_LOCK_ENV] !== lock.lock_id || environment[ORCHESTRATION_GENERATION_ENV] !== String(lock.generation))) throw new Error("Runtime recovery is blocked by the repository's Ultra takeover.");
    }
    return action();
  }, { operation: "runtime resource reservation" });
}

async function assertDirectory(path) {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Runtime resource state must use directories, not files or symbolic links.");
}

async function readReservation(path) {
  await assertDirectory(path);
  const entry = await lstat(join(path, "owner.json"));
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Runtime owner.json must be a regular file, not a directory or symbolic link.");
  const record = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
  if (record.version !== 1 || !UUID.test(record.reservation_id) || basename(path) !== `${record.reservation_id}.run` || !["active", "releasing"].includes(record.phase) || !Array.isArray(record.processes) || record.processes.length === 0) throw new Error("Runtime reservation is corrupt; inspect it before recovery.");
  if (!Array.isArray(record.resources) || record.resources.length === 0) throw new Error("The runtime reservation must contain a nonempty resource list.");
  validateRuntimeResources(record.resources);
  if (record.directory !== null && (typeof record.directory !== "string" || resolve(record.directory) !== record.directory || basename(record.directory) !== `codex-runtime-${record.reservation_id}`)) throw new Error("The runtime directory path is invalid or does not match the reservation.");
  for (const identity of record.processes) validateProcessIdentity(identity);
  return record;
}

function assignEnvironment(runtime, name, value) {
  if (process.platform === "win32") for (const key of Object.keys(runtime.environment)) if (key.toUpperCase() === name) delete runtime.environment[key];
  runtime.environment[name] = value;
}

export async function inspectRuntimeResources(options = {}) {
  const root = stateRoot(options);
  let entries;
  try { await assertDirectory(root); entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const results = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith(".run") || !UUID.test(entry.name.slice(0, -4)) || !entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Runtime reservation state contains an unexpected entry.");
    const path = join(root, entry.name);
    try { results.push({ ...await readReservation(path), path }); }
    catch (error) { if (error.code !== "ENOENT") throw error; throw new Error("Runtime reservation is being updated or is incomplete; retry inspection."); }
  }
  return results;
}

export async function acquireRuntimeResources(value, options = {}) {
  const resources = validateRuntimeResources(value);
  const runtime = { reservationId: randomUUID(), root: stateRoot(options), locks: [], directory: null, environment: { ...(options.environment ?? process.env) }, processes: [] };
  if (resources.length === 0) return runtime;
  const identity = await (options.processIdentityProvider ?? createProcessIdentity)({ pid: process.pid });
  validateProcessIdentity(identity);
  runtime.processes.push(identity);
  return withRuntimeMutex(runtime.root, async () => {
  try {
    const existing = await inspectRuntimeResources({ ...options, stateRoot: runtime.root });
    for (const resource of resources.filter((entry) => entry.mode === "exclusive")) {
      if (existing.some((owner) => owner.resources.some((held) => held.mode === "exclusive" && held.kind === resource.kind && held.key === resource.key))) throw new Error(`Runtime resource ${resource.kind}:${resource.key} is already reserved. Check runtime_reservations in gate status; do not remove reservations manually.`);
      if (resource.env) assignEnvironment(runtime, resource.env, resource.key);
    }
    await mkdir(runtime.root, { recursive: true });
    await assertDirectory(runtime.root);
    const path = join(runtime.root, `${runtime.reservationId}.run`);
    await mkdir(path);
    runtime.locks.push(path);
    if (resources.some((resource) => resource.mode === "isolated")) {
      runtime.directory = resolve(options.temporaryRoot ?? tmpdir(), `codex-runtime-${runtime.reservationId}`);
    }
    await atomicCreate(join(path, "owner.json"), { version: 1, phase: "active", reservation_id: runtime.reservationId, repository: options.repository ?? null, resources, directory: runtime.directory, processes: runtime.processes, created_at: new Date().toISOString() });
    if (runtime.directory) {
      await mkdir(runtime.directory);
      await atomicCreate(join(runtime.directory, "owner.json"), { reservation_id: runtime.reservationId });
    }
    for (const resource of resources.filter((entry) => entry.mode === "isolated")) {
      let assigned = `codex_${runtime.reservationId.replaceAll("-", "")}_${resource.name}`;
      if (resource.kind !== "database") { assigned = join(runtime.directory, resource.name); await mkdir(assigned); }
      assignEnvironment(runtime, resource.env, assigned);
    }
    return runtime;
  } catch (error) {
    try {
      if (runtime.directory) await removeRuntimeDirectory(runtime.directory, runtime.reservationId);
      for (const path of runtime.locks.reverse()) { await assertDirectory(path); await rm(path, { recursive: true }); }
    } catch (cleanupError) { error.cause ??= cleanupError; error.message += ` Runtime reservation ${runtime.reservationId} needs inspection.`; }
    throw error;
  }
  });
}

export async function registerRuntimeProcess(runtime, pid, options = {}) {
  if (!runtime.locks.length) return;
  const identity = await (options.processIdentityProvider ?? createProcessIdentity)({ pid });
  validateProcessIdentity(identity);
  runtime.processes.push(identity);
  return withRuntimeMutex(runtime.root, async () => {
  for (const path of runtime.locks) {
    const record = await readReservation(path);
    if (record.reservation_id !== runtime.reservationId || record.phase !== "active") throw new Error("Runtime reservation ownership changed or release has started.");
    await atomicWrite(join(path, "owner.json"), { ...record, processes: runtime.processes });
  }
  });
}

export async function assertRuntimeProcessesQuiescent(runtime, options = {}) {
  const identities = JSON.stringify(runtime.processes);
  if (runtime.quiescentProcesses === identities) return;
  if (runtime.processes.length > 1) {
    const inspected = await (options.processInspector ?? inspectProcessIdentities)(runtime.processes.slice(1));
    if (inspected.length !== runtime.processes.length - 1 || inspected.some((entry) => !["dead", "reused"].includes(entry.status))) throw new Error("A registered runtime child process is still running or has an unknown identity; reservations were kept.");
  }
  runtime.quiescentProcesses = identities;
}

export async function releaseRuntimeResources(runtime, options = {}) {
  if (!runtime.locks.length) return;
  await assertRuntimeProcessesQuiescent(runtime, options);
  const records = [];
  for (const path of runtime.locks) {
    const record = await readReservation(path);
    if (record.reservation_id !== runtime.reservationId) throw new Error("Runtime reservation ownership changed; it was not released.");
    if (JSON.stringify(record.processes) !== JSON.stringify(runtime.processes)) throw new Error("The registered runtime processes changed before release.");
    records.push({ ...record, path });
  }
  await finalizeReservations(records, runtime.root);
}

export async function recoverRuntimeResources(reservationId, options = {}) {
  if (!UUID.test(reservationId)) throw new Error("An exact runtime reservation id is required.");
  const records = (await inspectRuntimeResources(options)).filter((record) => record.reservation_id === reservationId);
  if (records.length === 0) throw new Error("Runtime reservation was not found.");
  if (options.repository && records.some((record) => record.repository !== options.repository)) throw new Error("Runtime reservation belongs to another repository.");
  const statuses = await (options.processInspector ?? inspectProcessIdentities)(records.flatMap((record) => record.processes));
  if (statuses.length !== records.reduce((total, record) => total + record.processes.length, 0) || statuses.some((entry) => !["dead", "reused"].includes(entry.status))) throw new Error("A registered process is still running or has an unknown identity; runtime recovery is blocked.");
  await finalizeReservations(records, stateRoot(options), options);
  return { reservation_id: reservationId, released: records.length };
}

async function finalizeReservations(records, root, options = {}) {
  const releasing = await withRuntimeMutex(root, async () => {
    const prepared = [];
    for (const { path, ...record } of records) {
      if (JSON.stringify(await readReservation(path)) !== JSON.stringify(record)) throw new Error("The runtime reservation changed while release checks were running.");
      const next = { ...record, phase: "releasing", release_id: randomUUID() };
      await atomicWrite(join(path, "owner.json"), next);
      prepared.push({ path, record: next });
    }
    return prepared;
  }, options);
  for (const { record } of releasing) if (record.directory) await removeRuntimeDirectory(record.directory, record.reservation_id);
  await withRuntimeMutex(root, async () => {
    for (const { path, record } of releasing) {
      if (JSON.stringify(await readReservation(path)) !== JSON.stringify(record)) throw new Error("Runtime reservation changed before release completed.");
      await rm(path, { recursive: true });
    }
  }, options);
}

async function removeRuntimeDirectory(path, reservationId) {
  if (basename(resolve(path)) !== `codex-runtime-${reservationId}`) throw new Error("The runtime directory name does not match the reservation id.");
  try { await assertDirectory(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  const marker = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
  if (marker.reservation_id !== reservationId) throw new Error("Runtime directory belongs to another reservation.");
  await rm(path, { recursive: true });
}

export async function withRuntimeResources(resources, options, action) {
  if (options.runtimeContext) return action(options.runtimeContext);
  const runtime = await acquireRuntimeResources(resources, options);
  let failure;
  let outcome;
  try { outcome = await action(runtime); return outcome; }
  catch (error) { failure = error; throw error; }
  finally {
    try { await releaseRuntimeResources(runtime, options); }
    catch (error) {
      error.message += ` Reservation: ${runtime.reservationId}. Use orchestration-gate.mjs recover-runtime --cwd <repository> --reservation-id ${runtime.reservationId}.`;
      if (failure) { failure.cause ??= error; failure.message += ` Runtime cleanup also failed: ${error.message}`; }
      else if (outcome?.result) return { ...outcome, exitCode: 2, result: { ...outcome.result, status: "failed", summary: `${outcome.result.summary} Runtime cleanup failed: ${error.message}`, blockers: [...(outcome.result.blockers ?? []), error.message] } };
      else throw error;
    }
  }
}
