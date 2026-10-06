import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runGit } from "../.agents/skills/sol-luna-orchestration/scripts/git-workspace.mjs";
import { acquireUltraLock, getRepositoryState } from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-state.mjs";
import { acquireRuntimeResources, releaseRuntimeResources, inspectRuntimeResources, recoverRuntimeResources, validateRuntimeResources, withRuntimeResources, registerRuntimeProcess } from "../.agents/skills/sol-luna-orchestration/scripts/runtime-resources.mjs";

test("runtime contracts reject ambiguous resources and environment overrides", () => {
  assert.throws(() => validateRuntimeResources([{ name: "db", kind: "database", mode: "isolated", env: "PATH" }]), /environment/i);
  assert.throws(() => validateRuntimeResources([{ name: "port", kind: "port", mode: "exclusive", key: "0" }]), /port/i);
  assert.throws(() => validateRuntimeResources([{ name: "db", kind: "database", mode: "exclusive", key: "postgres://user:secret@host/db" }]), /key/i);
  const value = { name: "api", kind: "port", mode: "exclusive", key: "3000", env: "APP_PORT" };
  assert.throws(() => validateRuntimeResources([value, value]), /duplicate/i);
});

test("runtime reservations exclude other repositories and preserve unrelated environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-resources-test-"));
  const options = { stateRoot: join(root, "state"), temporaryRoot: root, environment: { KEEP: "unchanged" } };
  const resources = [{ name: "database", kind: "database", mode: "exclusive", key: "shared-test-db", env: "TEST_DATABASE" }];
  let first;
  try {
    first = await acquireRuntimeResources(resources, { ...options, repository: "first" });
    assert.equal(first.environment.KEEP, "unchanged");
    assert.equal(first.environment.TEST_DATABASE, "shared-test-db");
    await assert.rejects(acquireRuntimeResources(resources, { ...options, repository: "second" }), /reserved/i);
    const entries = await inspectRuntimeResources(options);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].reservation_id, first.reservationId);
    await releaseRuntimeResources(first);
    first = null;
    const second = await acquireRuntimeResources(resources, { ...options, repository: "second" });
    await releaseRuntimeResources(second);
    assert.deepEqual(await inspectRuntimeResources(options), []);
  } finally { if (first) await releaseRuntimeResources(first); await rm(root, { recursive: true, force: true }); }
});

test("isolated runtime names and directories differ and partial acquisition rolls back", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-isolation-test-"));
  const options = { stateRoot: join(root, "state"), temporaryRoot: root };
  const resources = [{ name: "cache", kind: "cache", mode: "isolated", env: "BUILD_CACHE" }, { name: "db", kind: "database", mode: "isolated", env: "TEST_DATABASE" }];
  const first = await acquireRuntimeResources(resources, options);
  const second = await acquireRuntimeResources(resources, options);
  try {
    assert.notEqual(first.environment.BUILD_CACHE, second.environment.BUILD_CACHE);
    assert.notEqual(first.environment.TEST_DATABASE, second.environment.TEST_DATABASE);
    await writeFile(join(first.environment.BUILD_CACHE, "data"), "first");
    await assert.rejects(readFile(join(second.environment.BUILD_CACHE, "data")), /ENOENT/);
    const exclusive = [{ name: "port", kind: "port", mode: "exclusive", key: "3000" }];
    const held = await acquireRuntimeResources(exclusive, options);
    try {
      await assert.rejects(acquireRuntimeResources([...exclusive, { name: "other", kind: "database", mode: "exclusive", key: "other-db" }], options), /reserved/);
      assert.equal((await inspectRuntimeResources(options)).length, 3);
      await assert.rejects(recoverRuntimeResources(held.reservationId, options), /live|unknown/);
    } finally { await releaseRuntimeResources(held); }
  } finally { await releaseRuntimeResources(first); await releaseRuntimeResources(second); await rm(root, { recursive: true, force: true }); }
});

test("concurrent claims have one owner and explicit recovery refuses unknown processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-race-test-"));
  const options = { stateRoot: join(root, "state"), temporaryRoot: root };
  const resource = [{ name: "api", kind: "port", mode: "exclusive", key: "3001" }, { name: "cache", kind: "cache", mode: "isolated", env: "APP_CACHE" }];
  try {
    const attempts = await Promise.allSettled([acquireRuntimeResources(resource, options), acquireRuntimeResources(resource, options)]);
    assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
    const runtime = attempts.find((entry) => entry.status === "fulfilled").value;
    await assert.rejects(recoverRuntimeResources(runtime.reservationId, { ...options, processInspector: async (identities) => identities.map(() => ({ status: "unknown" })) }), /unknown/);
    assert.equal((await inspectRuntimeResources(options)).length, 1);
    await recoverRuntimeResources(runtime.reservationId, { ...options, processInspector: async (identities) => identities.map(() => ({ status: "reused" })) });
    assert.deepEqual(await inspectRuntimeResources(options), []);
    await assert.rejects(readFile(join(runtime.directory, "owner.json")), /ENOENT/);
    assert.equal((await acquireRuntimeResources([], options)).locks.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("corrupt resource state blocks acquisition and empty contracts create no state", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-corrupt-test-"));
  const options = { stateRoot: join(root, "state"), temporaryRoot: root };
  try {
    await withRuntimeResources([], options, async () => {});
    await assert.rejects(readFile(join(root, "state")), /ENOENT/);
    const runtime = await acquireRuntimeResources([{ name: "db", kind: "database", mode: "exclusive", key: "db" }], options);
    await writeFile(join(runtime.locks[0], "owner.json"), "{}");
    await assert.rejects(acquireRuntimeResources([{ name: "other", kind: "database", mode: "exclusive", key: "other" }], options), /corrupt/);
    await assert.rejects(releaseRuntimeResources(runtime), /corrupt/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cleanup failure retains reservations and verified metadata in the returned failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-cleanup-test-"));
  const options = { stateRoot: join(root, "state"), processInspector: async (identities) => identities.map(() => ({ status: "unknown" })) };
  try {
    const result = await withRuntimeResources([{ name: "db", kind: "database", mode: "exclusive", key: "integration-db" }], options, async (runtime) => {
      await registerRuntimeProcess(runtime, process.pid, { processIdentityProvider: async () => runtime.processes[0] });
      return { exitCode: 0, result: { status: "completed", routing_verified: true, model: "test-model", summary: "Finished.", blockers: [] } };
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.result.status, "failed");
    assert.equal(result.result.routing_verified, true);
    assert.equal(result.result.model, "test-model");
    assert.match(result.result.summary, /recover-runtime/);
    assert.equal((await inspectRuntimeResources(options)).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime recovery rechecks Ultra ownership after process inspection", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-ultra-race-"));
  const repository = join(root, "repository");
  const options = { environment: { ...process.env, CODEX_HOME: join(root, "codex") }, homeDirectory: root, repository };
  try {
    await mkdir(repository);
    await runGit(["init"], { cwd: repository });
    const repositoryState = await getRepositoryState(repository, options);
    const runtime = await acquireRuntimeResources([{ name: "db", kind: "database", mode: "exclusive", key: "db" }], options);
    await assert.rejects(recoverRuntimeResources(runtime.reservationId, { ...options, repositoryState, processInspector: async (identities) => {
      await acquireUltraLock({ ...options, cwd: repository, reason: "Test takeover race", sandboxMode: "read-only" });
      return identities.map(() => ({ status: "dead" }));
    } }), /Ultra takeover/);
    const records = await inspectRuntimeResources(options);
    assert.equal(records.length, 1);
    assert.equal(records[0].phase, "active");
  } finally { await rm(root, { recursive: true, force: true }); }
});
