import assert from "node:assert/strict";
import { mkdir, mkdtemp, access, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { runGit } from "../.agents/skills/sol-luna-orchestration/scripts/git-workspace.mjs";
import { beginExecutorRun, registerExecutorProcess, abandonExecutorRun, getOrchestrationStatus } from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-state.mjs";
import * as processes from "../.agents/skills/sol-luna-orchestration/scripts/process-identity.mjs";
import * as stateApi from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-state.mjs";

function identity(pid, fingerprint = `start-${pid}`) {
  return { pid, instance_id: `instance-${pid}`, start_fingerprint: fingerprint, hostname: "test-host", platform: "win32", architecture: "x64" };
}

async function setup(context) {
  const root = await mkdtemp(join(tmpdir(), "orchestration-contention-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repo");
  await mkdir(repository);
  await runGit(["init", "--quiet"], { cwd: repository });
  const options = { environment: { CODEX_HOME: join(root, "codex") }, homeDirectory: join(root, "home"), processInspector: async () => ({ status: "same" }) };
  const begin = () => beginExecutorRun({ cwd: repository, profile: "playwright", model: "gpt-5.6-luna", pid: 400001, processIdentityProvider: async ({ pid }) => identity(pid), ...options });
  return { root, repository, options, begin };
}

test("status does not initialize an absent state namespace", async (context) => {
  const { repository, options } = await setup(context);
  const status = await getOrchestrationStatus(repository, options);
  assert.equal(status.capacity.machine.total, 0);
  await assert.rejects(access(options.environment.CODEX_HOME), { code: "ENOENT" });
});

test("slow status inspection does not hold the mutex needed to close a lease", async (context) => {
  const { repository, options, begin } = await setup(context);
  const lease = await begin();
  let started;
  const inspecting = new Promise((resolve) => { started = resolve; });
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const reading = getOrchestrationStatus(repository, { ...options, processInspector: async () => { started(); await barrier; return { status: "same" }; } });
  await inspecting;
  let error;
  try { await abandonExecutorRun(lease, "Test finished", { processInspector: async () => ({ status: "dead" }) }); }
  catch (caught) { error = caught; }
  finally { release(); await reading; }
  assert.equal(error, undefined);
});

test("status inspects each identity once and does not prune dead reservations", async (context) => {
  const { repository, options, begin } = await setup(context);
  for (const pid of [400002, 400003]) {
    const lease = await begin();
    await registerExecutorProcess(lease, { kind: "app-server", processIdentity: identity(pid) });
  }
  const seen = [];
  const status = await getOrchestrationStatus(repository, { ...options, processInspector: async (value) => { seen.push(value.pid); return { status: "dead" }; } });
  assert.deepEqual(seen.sort(), [400001, 400002, 400003]);
  assert.equal(status.capacity.repository.total, 2);
  assert.equal(status.orphaned_run_ids.length, 2);
  assert.equal((await getOrchestrationStatus(repository, options)).capacity.repository.total, 2);
});

test("Windows batches fingerprints while comparing every expected identity", async () => {
  const invocations = [];
  const results = await processes.inspectProcessIdentities([identity(12), identity(12, "old"), identity(13)], {
    platform: "win32", architecture: "x64", hostnameValue: "test-host", processAlive: () => true,
    execFileImplementation: async (command, args, options) => {
      invocations.push({ command, args, options });
      return { stdout: JSON.stringify([{ pid: 12, fingerprint: "start-12" }, { pid: 13, fingerprint: "start-13" }]) };
    },
  });
  assert.deepEqual(results.map((value) => value.status), ["same", "reused", "same"]);
  assert.equal(invocations.length, 1);
  assert.match(invocations[0].args.at(-1), /ProcessId,CreationDate/);
  assert.equal(invocations[0].options.timeout, 5000);
  assert.notEqual(invocations[0].options.shell, true);
});

const execution = { exitCode: 0, result: { status: "completed", profile: "playwright", thread_id: "test-thread", model: "gpt-5.6-luna", reasoning_effort: "max", service_tier: "standard", routing_verified: true, sandbox_mode: "read-only", summary: "Done.", changed_files: [], checks: [], blockers: [], warnings: [] } };

test("a pending receipt keeps its reservation and blocks a new Ultra epoch", async (context) => {
  const fixture = await setup(context);
  const lease = await fixture.begin();
  await stateApi.saveExecutorFinalization(lease, execution);
  const options = { ...fixture.options, processInspector: async () => ({ status: "dead" }) };
  const status = await getOrchestrationStatus(fixture.repository, options);
  assert.equal(status.pending_finalizations[0].run_id, lease.run_id);
  assert.equal(status.capacity.repository.total, 1);
  await assert.rejects(stateApi.acquireUltraLock({ cwd: fixture.repository, reason: "Wait", sandboxMode: "read-only", ...options, processIdentityProvider: async () => identity(400004) }), /pending finalization/);
});

test("manual finalization rejects live identities and exact replay closes once", async (context) => {
  const fixture = await setup(context);
  const lease = await fixture.begin();
  await stateApi.saveExecutorFinalization(lease, execution);
  await assert.rejects(stateApi.finalizeExecutorReceipt({ cwd: fixture.repository, runId: lease.run_id, ...fixture.options }), /live or unknown/);
  const options = { cwd: fixture.repository, runId: lease.run_id, ...fixture.options, processInspector: async () => ({ status: "dead" }) };
  await Promise.all([stateApi.finalizeExecutorReceipt(options), stateApi.finalizeExecutorReceipt(options)]);
  const status = await getOrchestrationStatus(fixture.repository, fixture.options);
  assert.equal(status.capacity.machine.total, 0);
  assert.deepEqual(status.pending_finalizations, []);
  const history = await stateApi.readOrchestrationHistory(fixture.repository, fixture.options);
  assert.equal(history.events.filter((event) => event.event_type === "executor-completed").length, 1);
});

for (const boundary of ["closure-prepared", "history-written", "local-closed", "global-closed", "confirmed"]) {
  test(`finalization survives an interruption at ${boundary}`, async (context) => {
    const fixture = await setup(context);
    const lease = await fixture.begin();
    const receipt = await stateApi.saveExecutorFinalization(lease, execution);
    await assert.rejects(stateApi.closeExecutorFinalization(lease, receipt, { ...fixture.options, onFinalizationBoundary: async (at) => { if (at === boundary) throw new Error("Controlled interruption"); } }), /Controlled interruption/);
    if (boundary !== "confirmed") {
      const pending = await getOrchestrationStatus(fixture.repository, fixture.options);
      assert.equal(pending.capacity.machine.total, 1);
      assert.equal(pending.capacity.repository.total, 1);
    }
    await stateApi.finalizeExecutorReceipt({ cwd: fixture.repository, runId: lease.run_id, ...fixture.options, processInspector: async () => ({ status: "dead" }) });
    const status = await getOrchestrationStatus(fixture.repository, fixture.options);
    assert.equal(status.capacity.machine.total, 0);
    const history = await stateApi.readOrchestrationHistory(fixture.repository, fixture.options);
    assert.equal(history.events.filter((event) => event.event_type === "executor-completed").length, 1);
  });
}

test("altered receipts fail closed without releasing reservations", async (context) => {
  const fixture = await setup(context);
  const lease = await fixture.begin();
  await stateApi.saveExecutorFinalization(lease, execution);
  const path = join(lease.stateDirectory, "finalizations", lease.run_id, "receipt.json");
  const receipt = JSON.parse(await readFile(path, "utf8"));
  receipt.execution.result.summary = "Altered";
  await writeFile(path, JSON.stringify(receipt));
  await assert.rejects(stateApi.finalizeExecutorReceipt({ cwd: fixture.repository, runId: lease.run_id, ...fixture.options }), /hash verification/);
  await access(lease.path);
  await access(lease.globalPath);
});

test("Ultra receipts reject missing authority and recovery-required epochs", async (context) => {
  const fixture = await setup(context);
  const lock = await stateApi.acquireUltraLock({ cwd: fixture.repository, reason: "Receipt fencing test", sandboxMode: "read-only", ...fixture.options, pid: 400005, processIdentityProvider: async () => identity(400005) });
  const environment = { ...fixture.options.environment, CODEX_ORCHESTRATION_LOCK_ID: lock.lock_id, CODEX_ORCHESTRATION_GENERATION: String(lock.generation) };
  const lease = await beginExecutorRun({ cwd: fixture.repository, profile: "playwright", model: "gpt-5.6-luna", ...fixture.options, environment, pid: 400001, processIdentityProvider: async ({ pid }) => identity(pid) });
  await stateApi.saveExecutorFinalization(lease, execution);
  const args = { cwd: fixture.repository, runId: lease.run_id, ...fixture.options, processInspector: async () => ({ status: "dead" }) };
  await assert.rejects(stateApi.finalizeExecutorReceipt(args), /owner/);
  await stateApi.updateUltraLock({ cwd: fixture.repository, lockId: lock.lock_id, generation: lock.generation, state: "recovery-required", ...fixture.options });
  await assert.rejects(stateApi.finalizeExecutorReceipt({ ...args, environment }), /stale generation/);
  await access(lease.path);
  assert.equal((await stateApi.readUltraLock(fixture.repository, fixture.options)).state, "recovery-required");
});

test("a busy repository mutex does not hold the machine mutex", async (context) => {
  const fixture = await setup(context);
  const state = await stateApi.getRepositoryState(fixture.repository, fixture.options);
  const global = stateApi.getGlobalCapacityState(fixture.options);
  let release;
  let ready;
  const acquired = new Promise((resolve) => { ready = resolve; });
  const held = stateApi.withStateMutex(state, async () => { ready(); await new Promise((resolve) => { release = resolve; }); });
  await acquired;
  const waiting = stateApi.withCoordinationMutexes([global, state], async () => {});
  try { await stateApi.withStateMutex(global, async () => {}); }
  finally { release(); await Promise.all([held, waiting]); }
});

test("unknown Windows batch responses never release live PIDs", async () => {
  const result = await processes.inspectProcessIdentities([identity(12), identity(13)], { platform: "win32", architecture: "x64", hostnameValue: "test-host", processAlive: (pid) => pid === 12, execFileImplementation: async () => { throw new Error("CIM unavailable"); } });
  assert.deepEqual(result.map((entry) => entry.status), ["unknown", "dead"]);
  assert.equal(processes.isPidAlive(12, () => { throw Object.assign(new Error("Unknown failure"), { code: "EIO" }); }), true);
});

test("Unix fingerprint batches deduplicate PIDs and cap parallel queries at four", async () => {
  let active = 0;
  let maximum = 0;
  const seen = [];
  const identities = Array.from({ length: 10 }, (_, index) => ({ ...identity(index + 1), platform: "linux" }));
  identities.push({ ...identities[0], start_fingerprint: "older" });
  const result = await processes.inspectProcessIdentities(identities, { platform: "linux", architecture: "x64", hostnameValue: "test-host", captureFingerprint: async (pid) => { seen.push(pid); maximum = Math.max(maximum, ++active); await new Promise((resolve) => setImmediate(resolve)); active--; return { status: "found", fingerprint: `start-${pid}` }; } });
  assert.equal(seen.length, 10);
  assert.equal(maximum, 4);
  assert.equal(result.at(-1).status, "reused");
});

test("changed records exhaust only three preflights without applying an effect", async (context) => {
  const fixture = await setup(context);
  const lease = await fixture.begin();
  const state = await stateApi.getRepositoryState(fixture.repository, fixture.options);
  let queries = 0;
  let effects = 0;
  await assert.rejects(stateApi.withInspectedState([state], async () => { effects++; }, { processInspector: async () => {
    queries++;
    await stateApi.withStateMutex(state, async () => {
      const run = JSON.parse(await readFile(lease.path, "utf8"));
      await writeFile(lease.path, JSON.stringify({ ...run, updated_at: new Date(queries * 1000).toISOString() }));
    });
    return { status: "same" };
  } }), /three preflight/);
  assert.equal(queries, 3);
  assert.equal(effects, 0);
});

test("Windows native status uses one query and allows another repository to start", { skip: process.platform !== "win32" }, async (context) => {
  const fixture = await setup(context);
  const other = join(fixture.root, "other");
  await mkdir(other);
  await runGit(["init", "--quiet"], { cwd: other });
  const children = [];
  context.after(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit").catch(() => {}); } });
  const leases = [];
  for (let index = 0; index < 2; index++) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    children.push(child);
    const lease = await beginExecutorRun({ cwd: fixture.repository, profile: "playwright", model: "gpt-5.6-luna", environment: fixture.options.environment });
    await registerExecutorProcess(lease, { kind: "app-server", pid: child.pid });
    leases.push(lease);
  }
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  let nativeQueries = 0;
  const reading = getOrchestrationStatus(fixture.repository, { environment: fixture.options.environment, processBatchInspector: async (identities) => {
    const result = await processes.inspectProcessIdentities(identities, { execFileImplementation: async (...args) => { nativeQueries++; return promisify(execFile)(...args); } });
    started(); await barrier; return result;
  } });
  await ready;
  try {
    const independent = await beginExecutorRun({ cwd: other, profile: "review", model: "gpt-6-astra", environment: fixture.options.environment });
    await abandonExecutorRun(independent, "Native concurrency probe completed.");
    for (const child of children) { child.kill(); await once(child, "exit"); }
    for (const lease of leases) await abandonExecutorRun(lease, "Native concurrency probe completed.");
  } finally { release(); await reading; }
  assert.equal(nativeQueries, 1);
});
