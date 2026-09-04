import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runGit } from "../.agents/skills/sol-luna-orchestration/scripts/git-workspace.mjs";
import { evaluateHook } from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs";
import {
  ORCHESTRATION_LOCK_ENV,
  ORCHESTRATION_GENERATION_ENV,
  EXECUTOR_CAPACITY_LIMITS,
  acquireUltraLock,
  abandonExecutorRun,
  beginExecutorRun,
  finishExecutorRun,
  getCodexHome,
  getOrchestrationStatus,
  getRepositoryKey,
  getRepositoryState,
  listUltraExecutorResults,
  readOrchestrationHistory,
  readUltraLock,
  recoverUltraLock,
  registerExecutorProcess,
  registerUltraProcess,
  releaseUltraLock,
  updateUltraLock,
} from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-state.mjs";

async function createFixture(context, prefix = "sol-ultra-state-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  const homeDirectory = join(root, "home");
  const repository = join(root, "repository");
  await mkdir(repository, { recursive: true });
  await runGit(["init"], { cwd: repository });
  return { root, homeDirectory, repository };
}

function completedExecution(
  profile,
  effort,
  model = ["explore", "implement-lite", "playwright"].includes(profile)
    ? "gpt-5.6-luna"
    : "gpt-5.6-sol",
  serviceTier = ["explore", "implement-lite"].includes(profile) ? "fast" : "standard",
) {
  return {
    exitCode: 0,
    result: {
      status: "completed",
      profile,
      thread_id: `${profile}-thread`,
      model,
      reasoning_effort: effort,
      service_tier: serviceTier,
      routing_verified: true,
    },
  };
}

function epochEnvironment(lock) {
  return {
    [ORCHESTRATION_LOCK_ENV]: lock.lock_id,
    [ORCHESTRATION_GENERATION_ENV]: String(lock.generation),
  };
}

function testProcessIdentity(pid, fingerprint = `start-${pid}`) {
  return {
    pid,
    instance_id: `instance-${pid}`,
    start_fingerprint: fingerprint,
    hostname: "test-host",
    platform: process.platform,
    architecture: process.arch,
  };
}

async function addLinkedWorktree(fixture) {
  await runGit(["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-m", "initial"], { cwd: fixture.repository });
  const linked = join(fixture.root, "linked");
  await runGit(["worktree", "add", "--detach", linked, "HEAD"], { cwd: fixture.repository });
  return linked;
}

test("linked writers exclude main takeover and inherit the same Ultra generation", async (context) => {
  const fixture = await createFixture(context, "common-repository-lock-");
  const linked = await addLinkedWorktree(fixture);
  const lease = await beginExecutorRun({ cwd: linked, profile: "implement", model: "gpt-5.6-sol", homeDirectory: fixture.homeDirectory });
  await assert.rejects(acquireUltraLock({ cwd: fixture.repository, reason: "Must wait", sandboxMode: "read-only", homeDirectory: fixture.homeDirectory }), /executor run.*active/);
  await finishExecutorRun(lease, completedExecution("implement", "high"));
  const lock = await acquireUltraLock({ cwd: fixture.repository, reason: "Exclusive", sandboxMode: "read-only", homeDirectory: fixture.homeDirectory });
  const hook = { hook_event_name: "PreToolUse", cwd: linked, tool_name: "apply_patch" };
  const environment = { CODEX_HOME: join(fixture.homeDirectory, ".codex") };
  const blockedHook = await evaluateHook(hook, { environment });
  assert.equal(blockedHook.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(await evaluateHook(hook, { environment: { ...environment, ...epochEnvironment(lock) } }), null);
  const ownedLease = await beginExecutorRun({ cwd: linked, profile: "implement", model: "gpt-5.6-sol", homeDirectory: fixture.homeDirectory, environment: epochEnvironment(lock) });
  assert.equal(ownedLease.repository_key, lock.repository_key);
  assert.equal(ownedLease.generation, lock.generation);
  await finishExecutorRun(ownedLease, completedExecution("implement", "high"));
  await releaseUltraLock({ cwd: linked, lockId: lock.lock_id, generation: lock.generation, homeDirectory: fixture.homeDirectory });
});

test("legacy worktree locks remain recoverable and retain their generation after worktree removal", async (context) => {
  const fixture = await createFixture(context, "legacy-linked-lock-");
  const linked = await addLinkedWorktree(fixture);
  const options = { homeDirectory: fixture.homeDirectory };
  const lock = await acquireUltraLock({ cwd: fixture.repository, reason: "Old worktree domain", sandboxMode: "read-only", ...options });
  const canonical = await getRepositoryState(fixture.repository, options);
  const legacyKey = getRepositoryKey(linked);
  const legacyDirectory = join(dirname(canonical.stateDirectory), legacyKey);
  await rename(canonical.stateDirectory, legacyDirectory);
  const metadataPath = join(legacyDirectory, "repository-state.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  await writeFile(metadataPath, JSON.stringify({ ...metadata, repository: linked, repository_key: legacyKey, current_generation: 7, related_repositories: [] }));
  await writeFile(join(legacyDirectory, "ultra.lock", "lock.json"), JSON.stringify({ ...lock, repository: linked, repository_key: legacyKey, generation: 7 }));
  const status = await getOrchestrationStatus(fixture.repository, options);
  assert.equal(status.legacy_namespaces[0].lock_id, lock.lock_id);
  assert.equal(status.legacy_namespaces[0].blocked, true);
  await assert.rejects(beginExecutorRun({ cwd: fixture.repository, profile: "review", model: "gpt-5.6-sol", ...options }), /pending legacy state/);
  await assert.rejects(recoverUltraLock({ cwd: fixture.repository, lockId: lock.lock_id, ...options, processInspector: async () => ({ status: "unknown" }) }), /unknown/);
  await recoverUltraLock({ cwd: fixture.repository, lockId: lock.lock_id, ...options, processInspector: async () => ({ status: "dead" }) });
  await runGit(["worktree", "remove", linked], { cwd: fixture.repository });
  const next = await acquireUltraLock({ cwd: fixture.repository, reason: "New common epoch", sandboxMode: "read-only", ...options });
  assert.equal(next.generation, 8);
  assert.equal(JSON.parse(await readFile(metadataPath, "utf8")).current_generation, 7);
});

test("Ultra lock acquisition is exclusive and repository scoped", async (context) => {
  const fixture = await createFixture(context);
  const otherRepository = join(fixture.root, "other-repository");
  await mkdir(otherRepository, { recursive: true });
  await runGit(["init"], { cwd: otherRepository });
  const first = await acquireUltraLock({
    cwd: fixture.repository,
    reason: "First repository",
    sandboxMode: "read-only",
    homeDirectory: fixture.homeDirectory,
  });
  await assert.rejects(
    acquireUltraLock({
      cwd: fixture.repository,
      reason: "Conflicting takeover",
      sandboxMode: "read-only",
      homeDirectory: fixture.homeDirectory,
    }),
    /already has an Ultra lock/,
  );
  const second = await acquireUltraLock({
    cwd: otherRepository,
    reason: "Independent repository",
    sandboxMode: "workspace-write",
    homeDirectory: fixture.homeDirectory,
  });
  assert.notEqual(first.lock_id, second.lock_id);
  await releaseUltraLock({
    cwd: fixture.repository,
    lockId: first.lock_id,
    generation: first.generation,
    homeDirectory: fixture.homeDirectory,
  });
  await releaseUltraLock({
    cwd: otherRepository,
    lockId: second.lock_id,
    generation: second.generation,
    homeDirectory: fixture.homeDirectory,
  });
});

test("executor leases block Ultra and Ultra admits only the matching lock id", async (context) => {
  const fixture = await createFixture(context);
  const lease = await beginExecutorRun({
    cwd: fixture.repository,
    profile: "explore",
    model: "gpt-5.6-luna",
    homeDirectory: fixture.homeDirectory,
  });
  await assert.rejects(
    acquireUltraLock({
      cwd: fixture.repository,
      reason: "Must wait for executor",
      sandboxMode: "read-only",
      homeDirectory: fixture.homeDirectory,
    }),
    /executor run.*active/,
  );
  await finishExecutorRun(lease, completedExecution("explore", "max"));
  const lock = await acquireUltraLock({
    cwd: fixture.repository,
    reason: "Executor finished",
    sandboxMode: "read-only",
    homeDirectory: fixture.homeDirectory,
  });
  await assert.rejects(
    beginExecutorRun({
      cwd: fixture.repository,
      profile: "review",
      model: "gpt-5.6-sol",
      homeDirectory: fixture.homeDirectory,
    }),
    /locked by an exclusive Sol Ultra takeover/,
  );
  const inheritedLease = await beginExecutorRun({
    cwd: fixture.repository,
    profile: "review",
    model: "gpt-5.6-sol",
    environment: epochEnvironment(lock),
    homeDirectory: fixture.homeDirectory,
  });
  assert.equal(inheritedLease.generation, lock.generation);
  await finishExecutorRun(inheritedLease, completedExecution("review", "high"));
  assert.deepEqual(
    await listUltraExecutorResults({
      cwd: fixture.repository,
      lockId: lock.lock_id,
      generation: lock.generation,
      homeDirectory: fixture.homeDirectory,
    }),
    [
      {
        profile: "review",
        status: "completed",
        thread_id: "review-thread",
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        service_tier: "standard",
        routing_verified: true,
      },
    ],
  );
  await releaseUltraLock({
    cwd: fixture.repository,
    lockId: lock.lock_id,
    generation: lock.generation,
    homeDirectory: fixture.homeDirectory,
  });
});

test("simultaneous executor and Ultra acquisition cannot both succeed", async (context) => {
  const fixture = await createFixture(context, "sol-ultra-race-");
  const [executorAttempt, ultraAttempt] = await Promise.allSettled([
    beginExecutorRun({
      cwd: fixture.repository,
      profile: "explore",
      model: "gpt-5.6-luna",
      homeDirectory: fixture.homeDirectory,
    }),
    acquireUltraLock({
      cwd: fixture.repository,
      reason: "Race test",
      sandboxMode: "read-only",
      homeDirectory: fixture.homeDirectory,
    }),
  ]);
  assert.equal(
    [executorAttempt, ultraAttempt].filter((result) => result.status === "fulfilled").length,
    1,
  );
  if (executorAttempt.status === "fulfilled") {
    await finishExecutorRun(executorAttempt.value, completedExecution("explore", "max"));
  }
  if (ultraAttempt.status === "fulfilled") {
    await releaseUltraLock({
      cwd: fixture.repository,
      lockId: ultraAttempt.value.lock_id,
      generation: ultraAttempt.value.generation,
      homeDirectory: fixture.homeDirectory,
    });
  }
});

test("corrupt locks fail closed", async (context) => {
  const fixture = await createFixture(context, "sol-ultra-corrupt-");
  const state = await getRepositoryState(fixture.repository, {
    homeDirectory: fixture.homeDirectory,
  });
  await mkdir(state.lockDirectory, { recursive: true });
  await writeFile(state.lockPath, "{not-json}\n");
  await assert.rejects(
    readUltraLock(fixture.repository, { homeDirectory: fixture.homeDirectory }),
    /invalid JSON/,
  );
  await rm(state.lockDirectory, { recursive: true, force: false });
  await acquireUltraLock({
    cwd: fixture.repository,
    reason: "Corrupt process shape",
    sandboxMode: "read-only",
    homeDirectory: fixture.homeDirectory,
  });
  const stored = JSON.parse(await readFile(state.lockPath, "utf8"));
  stored.processes = [{ ...stored.processes[0], kind: "app-server" }];
  await writeFile(state.lockPath, `${JSON.stringify(stored)}\n`);
  await assert.rejects(
    readUltraLock(fixture.repository, { homeDirectory: fixture.homeDirectory }),
    /ultra-launcher/,
  );
});

test("recovery requires the exact lock id and an inactive owner", async (context) => {
  const fixture = await createFixture(context, "sol-ultra-recovery-");
  const lock = await acquireUltraLock({
    cwd: fixture.repository,
    reason: "Recovery test",
    sandboxMode: "read-only",
    homeDirectory: fixture.homeDirectory,
  });
  await updateUltraLock({
    cwd: fixture.repository,
    lockId: lock.lock_id,
    generation: lock.generation,
    state: "recovery-required",
    homeDirectory: fixture.homeDirectory,
  });
  await assert.rejects(
    releaseUltraLock({
      cwd: fixture.repository,
      lockId: lock.lock_id,
      generation: lock.generation,
      homeDirectory: fixture.homeDirectory,
    }),
    /must use exact-id recovery/,
  );
  await assert.rejects(
    recoverUltraLock({
      cwd: fixture.repository,
      lockId: "incorrect",
      homeDirectory: fixture.homeDirectory,
      processAlive: () => false,
    }),
    /does not match/,
  );
  await assert.rejects(
    recoverUltraLock({
      cwd: fixture.repository,
      lockId: lock.lock_id,
      homeDirectory: fixture.homeDirectory,
      processAlive: () => true,
    }),
    /still active/,
  );
  const recovered = await recoverUltraLock({
    cwd: fixture.repository,
    lockId: lock.lock_id,
    homeDirectory: fixture.homeDirectory,
    processAlive: () => false,
  });
  assert.equal(recovered.status, "recovered");
  assert.equal(await readUltraLock(fixture.repository, { homeDirectory: fixture.homeDirectory }), null);
});

test("lock state never expires automatically", async (context) => {
  const fixture = await createFixture(context, "sol-ultra-no-expiry-");
  const lock = await acquireUltraLock({
    cwd: fixture.repository,
    reason: "Persistent lock",
    sandboxMode: "read-only",
    homeDirectory: fixture.homeDirectory,
  });
  const state = await getRepositoryState(fixture.repository, {
    homeDirectory: fixture.homeDirectory,
  });
  const stored = JSON.parse(await readFile(state.lockPath, "utf8"));
  stored.created_at = "2000-01-01T00:00:00.000Z";
  stored.updated_at = "2000-01-01T00:00:00.000Z";
  await writeFile(state.lockPath, `${JSON.stringify(stored)}\n`);
  const status = await getOrchestrationStatus(fixture.repository, {
    homeDirectory: fixture.homeDirectory,
  });
  assert.equal(status.lock.lock_id, lock.lock_id);
  assert.equal(status.lock.state, "active");
  await releaseUltraLock({
    cwd: fixture.repository,
    lockId: lock.lock_id,
    generation: lock.generation,
    homeDirectory: fixture.homeDirectory,
  });
});

test("Ultra generations are monotonic and persist after release", async (context) => {
  const fixture = await createFixture(context, "sol-ultra-generation-");
  const first = await acquireUltraLock({
    cwd: fixture.repository,
    reason: "First epoch",
    sandboxMode: "read-only",
    homeDirectory: fixture.homeDirectory,
  });
  assert.equal(first.version, 2);
  assert.equal(first.generation, 1);
  await releaseUltraLock({
    cwd: fixture.repository,
    lockId: first.lock_id,
    generation: first.generation,
    homeDirectory: fixture.homeDirectory,
  });
  const second = await acquireUltraLock({
    cwd: fixture.repository,
    reason: "Second epoch",
    sandboxMode: "read-only",
    homeDirectory: fixture.homeDirectory,
  });
  assert.equal(second.generation, 2);
  const status = await getOrchestrationStatus(fixture.repository, {
    homeDirectory: fixture.homeDirectory,
  });
  assert.deepEqual(status.generation, { current: 2, lock: 2 });
  await releaseUltraLock({
    cwd: fixture.repository,
    lockId: second.lock_id,
    generation: second.generation,
    homeDirectory: fixture.homeDirectory,
  });
});

test("executors require both the Ultra lock id and its generation", async (context) => {
  const fixture = await createFixture(context, "sol-ultra-generation-env-");
  const lock = await acquireUltraLock({
    cwd: fixture.repository,
    reason: "Fenced epoch",
    sandboxMode: "read-only",
    homeDirectory: fixture.homeDirectory,
  });
  await assert.rejects(
    beginExecutorRun({
      cwd: fixture.repository,
      profile: "review",
      model: "gpt-5.6-sol",
      environment: { [ORCHESTRATION_LOCK_ENV]: lock.lock_id },
      homeDirectory: fixture.homeDirectory,
    }),
    /generation/,
  );
  await assert.rejects(
    beginExecutorRun({
      cwd: fixture.repository,
      profile: "review",
      model: "gpt-5.6-sol",
      environment: {
        [ORCHESTRATION_LOCK_ENV]: lock.lock_id,
        [ORCHESTRATION_GENERATION_ENV]: String(lock.generation + 1),
      },
      homeDirectory: fixture.homeDirectory,
    }),
    /generation/,
  );
  await releaseUltraLock({
    cwd: fixture.repository,
    lockId: lock.lock_id,
    generation: lock.generation,
    homeDirectory: fixture.homeDirectory,
  });
});

test("stale executor completion and abandonment cannot mutate a newer epoch", async (context) => {
  const fixture = await createFixture(context, "sol-ultra-stale-result-");
  const first = await acquireUltraLock({
    cwd: fixture.repository,
    reason: "Old epoch",
    sandboxMode: "read-only",
    homeDirectory: fixture.homeDirectory,
  });
  const completedLease = await beginExecutorRun({
    cwd: fixture.repository,
    profile: "review",
    model: "gpt-5.6-sol",
    environment: epochEnvironment(first),
    homeDirectory: fixture.homeDirectory,
  });
  const abandonedLease = await beginExecutorRun({
    cwd: fixture.repository,
    profile: "review",
    model: "gpt-5.6-sol",
    environment: epochEnvironment(first),
    homeDirectory: fixture.homeDirectory,
  });
  await updateUltraLock({
    cwd: fixture.repository,
    lockId: first.lock_id,
    generation: first.generation,
    state: "recovery-required",
    homeDirectory: fixture.homeDirectory,
  });
  await recoverUltraLock({
    cwd: fixture.repository,
    lockId: first.lock_id,
    homeDirectory: fixture.homeDirectory,
    processInspector: async () => ({ status: "dead" }),
  });
  const second = await acquireUltraLock({
    cwd: fixture.repository,
    reason: "New epoch",
    sandboxMode: "read-only",
    homeDirectory: fixture.homeDirectory,
  });
  await assert.rejects(
    finishExecutorRun(completedLease, completedExecution("review", "high")),
    /stale generation/,
  );
  await assert.rejects(
    abandonExecutorRun(abandonedLease, new Error("Bearer should-not-be-recorded")),
    /stale generation/,
  );
  assert.deepEqual(
    await listUltraExecutorResults({
      cwd: fixture.repository,
      lockId: second.lock_id,
      generation: second.generation,
      homeDirectory: fixture.homeDirectory,
    }),
    [],
  );
  await releaseUltraLock({
    cwd: fixture.repository,
    lockId: second.lock_id,
    generation: second.generation,
    homeDirectory: fixture.homeDirectory,
  });
  const history = await readOrchestrationHistory(fixture.repository, {
    homeDirectory: fixture.homeDirectory,
    limit: 200,
  });
  assert.equal(
    history.events.filter((event) => event.event_type === "stale-generation-rejected").length,
    2,
  );
  assert.doesNotMatch(JSON.stringify(history), /should-not-be-recorded/);
});

test("recovery fails closed for registered live or unknown processes", async (context) => {
  const fixture = await createFixture(context, "sol-ultra-process-recovery-");
  const lock = await acquireUltraLock({
    cwd: fixture.repository,
    reason: "Process recovery",
    sandboxMode: "read-only",
    homeDirectory: fixture.homeDirectory,
  });
  await registerUltraProcess({
    cwd: fixture.repository,
    lockId: lock.lock_id,
    generation: lock.generation,
    kind: "app-server",
    processIdentity: testProcessIdentity(9876),
    homeDirectory: fixture.homeDirectory,
  });
  await updateUltraLock({
    cwd: fixture.repository,
    lockId: lock.lock_id,
    generation: lock.generation,
    state: "recovery-required",
    homeDirectory: fixture.homeDirectory,
  });
  await assert.rejects(
    recoverUltraLock({
      cwd: fixture.repository,
      lockId: lock.lock_id,
      homeDirectory: fixture.homeDirectory,
      processInspector: async (identity) => ({
        status: identity.pid === 9876 ? "same" : "dead",
      }),
    }),
    /app-server.*still active/,
  );
  await assert.rejects(
    recoverUltraLock({
      cwd: fixture.repository,
      lockId: lock.lock_id,
      homeDirectory: fixture.homeDirectory,
      processInspector: async (identity) => ({
        status: identity.pid === 9876 ? "unknown" : "dead",
      }),
    }),
    /app-server.*unknown/,
  );
  const recovered = await recoverUltraLock({
    cwd: fixture.repository,
    lockId: lock.lock_id,
    homeDirectory: fixture.homeDirectory,
    processInspector: async () => ({ status: "dead" }),
  });
  assert.equal(recovered.generation, lock.generation);
});

test("recovery inspects reused PIDs by full process identity", async (context) => {
  const fixture = await createFixture(context, "sol-ultra-reused-pid-");
  const pid = 7654;
  const lock = await acquireUltraLock({
    cwd: fixture.repository,
    reason: "Reused PID recovery",
    sandboxMode: "read-only",
    pid,
    processIdentityProvider: async () => testProcessIdentity(pid, "old-start"),
    homeDirectory: fixture.homeDirectory,
  });
  await registerUltraProcess({
    cwd: fixture.repository,
    lockId: lock.lock_id,
    generation: lock.generation,
    kind: "app-server",
    processIdentity: {
      ...testProcessIdentity(pid, "new-start"),
      instance_id: "instance-new-start",
    },
    homeDirectory: fixture.homeDirectory,
  });
  await updateUltraLock({
    cwd: fixture.repository,
    lockId: lock.lock_id,
    generation: lock.generation,
    state: "recovery-required",
    homeDirectory: fixture.homeDirectory,
  });
  await assert.rejects(
    recoverUltraLock({
      cwd: fixture.repository,
      lockId: lock.lock_id,
      homeDirectory: fixture.homeDirectory,
      processInspector: async (identity) => ({
        status: identity.start_fingerprint === "new-start" ? "same" : "reused",
      }),
    }),
    /app-server.*still active/,
  );
});

test("executor App Server identities are recorded in status and recovery", async (context) => {
  const fixture = await createFixture(context, "sol-ultra-executor-process-");
  const lock = await acquireUltraLock({
    cwd: fixture.repository,
    reason: "Executor process",
    sandboxMode: "read-only",
    homeDirectory: fixture.homeDirectory,
  });
  const lease = await beginExecutorRun({
    cwd: fixture.repository,
    profile: "review",
    model: "gpt-5.6-sol",
    environment: epochEnvironment(lock),
    homeDirectory: fixture.homeDirectory,
  });
  await registerExecutorProcess(lease, {
    kind: "app-server",
    processIdentity: testProcessIdentity(8765),
  });
  const status = await getOrchestrationStatus(fixture.repository, {
    homeDirectory: fixture.homeDirectory,
    processInspector: async (identity) => ({
      status: identity.pid === 8765 ? "same" : "dead",
    }),
  });
  assert.equal(status.runs[0].process_statuses[1].kind, "app-server");
  assert.equal(status.runs[0].process_statuses[1].status, "same");
  await updateUltraLock({
    cwd: fixture.repository,
    lockId: lock.lock_id,
    generation: lock.generation,
    state: "recovery-required",
    homeDirectory: fixture.homeDirectory,
  });
  await assert.rejects(
    recoverUltraLock({
      cwd: fixture.repository,
      lockId: lock.lock_id,
      homeDirectory: fixture.homeDirectory,
      processInspector: async (identity) => ({
        status: identity.pid === 8765 ? "same" : "dead",
      }),
    }),
    /executor.*app-server.*still active/,
  );
  await recoverUltraLock({
    cwd: fixture.repository,
    lockId: lock.lock_id,
    homeDirectory: fixture.homeDirectory,
    processInspector: async () => ({ status: "dead" }),
  });
});

test("executor process registration preserves fail-closed repository evidence", async (context) => {
  const fixture = await createFixture(context, "sol-ultra-registration-evidence-");
  const lock = await acquireUltraLock({
    cwd: fixture.repository,
    reason: "Registration evidence",
    sandboxMode: "read-only",
    homeDirectory: fixture.homeDirectory,
  });
  const lease = await beginExecutorRun({
    cwd: fixture.repository,
    profile: "review",
    model: "gpt-5.6-sol",
    environment: epochEnvironment(lock),
    homeDirectory: fixture.homeDirectory,
  });
  await rm(lease.globalPath, { force: false });
  await assert.rejects(
    registerExecutorProcess(lease, {
      kind: "app-server",
      processIdentity: testProcessIdentity(6543),
    }),
    /Global executor lease.*missing/,
  );
  const status = await getOrchestrationStatus(fixture.repository, {
    homeDirectory: fixture.homeDirectory,
    processInspector: async () => ({ status: "dead" }),
  });
  assert.deepEqual(
    status.runs[0].process_statuses.map((entry) => entry.kind),
    ["executor-launcher", "app-server"],
  );
});

test("history is immutable, ordered, redacted, and survives lock removal", async (context) => {
  const fixture = await createFixture(context, "sol-ultra-history-");
  const lock = await acquireUltraLock({
    cwd: fixture.repository,
    reason: "Bearer super-secret-value",
    sandboxMode: "read-only",
    homeDirectory: fixture.homeDirectory,
  });
  await releaseUltraLock({
    cwd: fixture.repository,
    lockId: lock.lock_id,
    generation: lock.generation,
    homeDirectory: fixture.homeDirectory,
  });
  const state = await getRepositoryState(fixture.repository, {
    homeDirectory: fixture.homeDirectory,
  });
  const files = await readdir(state.historyDirectory);
  assert.equal(files.length, 2);
  const history = await readOrchestrationHistory(fixture.repository, {
    homeDirectory: fixture.homeDirectory,
  });
  assert.deepEqual(history.events.map((event) => event.event_type), [
    "lock-acquired",
    "lock-released",
  ]);
  assert.ok(history.events[0].sequence < history.events[1].sequence);
  assert.doesNotMatch(JSON.stringify(history), /super-secret-value/);
  await assert.rejects(
    writeFile(join(state.historyDirectory, files[0]), "replacement", { flag: "wx" }),
    /EEXIST/,
  );
  await writeFile(join(state.historyDirectory, "corrupt.json"), "{invalid}\n");
  const historyWithWarning = await readOrchestrationHistory(fixture.repository, {
    homeDirectory: fixture.homeDirectory,
  });
  assert.equal(historyWithWarning.events.length, 2);
  assert.equal(historyWithWarning.warnings.length, 1);
  assert.match(historyWithWarning.warnings[0], /invalid JSON/);
});

test("history retention removes only terminated generations and preserves the active epoch", async (context) => {
  const fixture = await createFixture(context, "sol-ultra-history-retention-");
  const lock = await acquireUltraLock({
    cwd: fixture.repository,
    reason: "Protected epoch",
    sandboxMode: "read-only",
    homeDirectory: fixture.homeDirectory,
  });
  const state = await getRepositoryState(fixture.repository, {
    homeDirectory: fixture.homeDirectory,
  });
  for (let offset = 0; offset < 1_001; offset += 100) {
    await Promise.all(
      Array.from({ length: Math.min(100, 1_001 - offset) }, async (_, index) => {
        const sequence = offset + index + 2;
        const event = {
          version: 2,
          event_id: `old-${sequence}`,
          sequence,
          event_type: sequence === 2 ? "lock-recovered" : "lock-acquired",
          repository: state.repository,
          repository_key: state.key,
          lock_id: "old-lock",
          generation: 0,
          run_id: null,
          profile: null,
          owner: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          reason_code: "retention-fixture",
          description: "Retention fixture.",
        };
        await writeFile(
          join(state.historyDirectory, `${String(sequence).padStart(16, "0")}-old-${sequence}.json`),
          `${JSON.stringify(event)}\n`,
        );
      }),
    );
  }
  const metadata = JSON.parse(await readFile(state.metadataPath, "utf8"));
  metadata.history_sequence = 1_002;
  await writeFile(state.metadataPath, `${JSON.stringify(metadata)}\n`);
  await updateUltraLock({
    cwd: fixture.repository,
    lockId: lock.lock_id,
    generation: lock.generation,
    threadId: "retention-thread",
    homeDirectory: fixture.homeDirectory,
  });
  const status = await getOrchestrationStatus(fixture.repository, {
    homeDirectory: fixture.homeDirectory,
  });
  assert.equal(status.history.count, 1_000);
  await updateUltraLock({
    cwd: fixture.repository,
    lockId: lock.lock_id,
    generation: lock.generation,
    threadId: "retention-thread-second-update",
    homeDirectory: fixture.homeDirectory,
  });
  const secondStatus = await getOrchestrationStatus(fixture.repository, {
    homeDirectory: fixture.homeDirectory,
  });
  assert.equal(secondStatus.history.count, 1_000);
  const retainedFiles = await readdir(state.historyDirectory);
  const retainedEvents = await Promise.all(
    retainedFiles.map(async (file) => JSON.parse(await readFile(join(state.historyDirectory, file), "utf8"))),
  );
  assert.equal(
    retainedEvents.some((event) => event.event_type === "lock-acquired" && event.lock_id === lock.lock_id),
    true,
  );
  assert.equal(
    retainedEvents.some((event) => event.event_type === "lock-updated" && event.lock_id === lock.lock_id),
    true,
  );
  await releaseUltraLock({
    cwd: fixture.repository,
    lockId: lock.lock_id,
    generation: lock.generation,
    homeDirectory: fixture.homeDirectory,
  });
});

test("legacy v1 locks block v2 acquisition and require explicit recovery confirmation", async (context) => {
  const fixture = await createFixture(context, "sol-ultra-legacy-");
  const state = await getRepositoryState(fixture.repository, {
    homeDirectory: fixture.homeDirectory,
  });
  await mkdir(state.lockDirectory, { recursive: true });
  await writeFile(state.lockPath, `${JSON.stringify({
    version: 1,
    lock_id: "legacy-lock",
    repository: state.repository,
    repository_key: state.key,
    state: "recovery-required",
    role: "ultra-orchestrator",
    pid: 2_147_483_647,
    thread_id: null,
    model: "gpt-5.6-sol",
    reasoning_effort: "ultra",
    service_tier: "standard",
    sandbox_mode: "read-only",
    reason: "Legacy takeover",
    activation: "human-confirmed",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  })}\n`);
  await assert.rejects(
    acquireUltraLock({
      cwd: fixture.repository,
      reason: "New takeover",
      sandboxMode: "read-only",
      homeDirectory: fixture.homeDirectory,
    }),
    /legacy-unfenced/,
  );
  const status = await getOrchestrationStatus(fixture.repository, {
    homeDirectory: fixture.homeDirectory,
  });
  assert.equal(status.legacy_state, "legacy-unfenced");
  await assert.rejects(
    recoverUltraLock({
      cwd: fixture.repository,
      lockId: "legacy-lock",
      homeDirectory: fixture.homeDirectory,
      processAlive: () => false,
    }),
    /confirm-legacy-recovery/,
  );
  await writeFile(state.metadataPath, "{invalid}\n");
  await assert.rejects(
    recoverUltraLock({
      cwd: fixture.repository,
      lockId: "legacy-lock",
      homeDirectory: fixture.homeDirectory,
      processAlive: () => false,
      confirmLegacyRecovery: true,
    }),
    /invalid JSON/,
  );
  await assert.rejects(readUltraLock(fixture.repository, {
    homeDirectory: fixture.homeDirectory,
  }), /invalid JSON/);
  assert.equal(JSON.parse(await readFile(state.lockPath, "utf8")).lock_id, "legacy-lock");
  await rm(state.metadataPath, { force: false });
  await recoverUltraLock({
    cwd: fixture.repository,
    lockId: "legacy-lock",
    homeDirectory: fixture.homeDirectory,
    processAlive: () => false,
    confirmLegacyRecovery: true,
  });
  const next = await acquireUltraLock({
    cwd: fixture.repository,
    reason: "First fenced takeover",
    sandboxMode: "read-only",
    homeDirectory: fixture.homeDirectory,
  });
  assert.equal(next.generation, 1);
  const history = await readOrchestrationHistory(fixture.repository, {
    homeDirectory: fixture.homeDirectory,
  });
  assert.equal(history.events[0].event_type, "legacy-lock-recovered");
  await releaseUltraLock({
    cwd: fixture.repository,
    lockId: next.lock_id,
    generation: next.generation,
    homeDirectory: fixture.homeDirectory,
  });
});

test("Windows repository keys normalize path casing", () => {
  assert.equal(
    getRepositoryKey("C:\\Users\\MAURI\\Repo", "win32"),
    getRepositoryKey("c:\\users\\mauri\\repo", "win32"),
  );
});

test("Linux and macOS repository keys preserve path casing", () => {
  for (const platform of ["linux", "darwin"]) {
    assert.notEqual(
      getRepositoryKey("/Users/Mauri/Repo", platform),
      getRepositoryKey("/Users/mauri/repo", platform),
    );
  }
});

test("CODEX_HOME takes precedence over the supplied home directory", () => {
  assert.equal(
    getCodexHome({ CODEX_HOME: "custom-codex-home", HOME: "ignored-home" }, "fallback-home"),
    join(process.cwd(), "custom-codex-home"),
  );
  assert.equal(
    getCodexHome({ HOME: "ignored-home" }, "fallback-home"),
    join(process.cwd(), "fallback-home", ".codex"),
  );
  assert.equal(
    getCodexHome({ HOME: "environment-home" }),
    join(process.cwd(), "environment-home", ".codex"),
  );
});

test("Luna and Sol capacity acquisition is atomic and releases in finally paths", async (context) => {
  const fixture = await createFixture(context, "sol-luna-capacity-");
  const lunaAttempts = await Promise.allSettled(
    Array.from({ length: EXECUTOR_CAPACITY_LIMITS.luna + 1 }, (_, index) =>
      beginExecutorRun({
        cwd: fixture.repository,
        profile: "explore",
        model: "gpt-5.6-luna",
        runId: `luna-${index}`,
        homeDirectory: fixture.homeDirectory,
      }),
    ),
  );
  const lunaLeases = lunaAttempts
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  assert.equal(lunaLeases.length, EXECUTOR_CAPACITY_LIMITS.luna);
  assert.equal(
    lunaAttempts.filter((result) => result.status === "rejected").length,
    1,
  );
  for (const lease of lunaLeases) {
    await finishExecutorRun(lease, completedExecution("explore", "max"));
  }

  const solLeases = [];
  for (let index = 0; index < EXECUTOR_CAPACITY_LIMITS.sol; index += 1) {
    solLeases.push(
      await beginExecutorRun({
        cwd: fixture.repository,
        profile: "review",
        model: "gpt-5.6-sol",
        runId: `sol-${index}`,
        homeDirectory: fixture.homeDirectory,
      }),
    );
  }
  await assert.rejects(
    beginExecutorRun({
      cwd: fixture.repository,
      profile: "review",
      model: "gpt-5.6-sol",
      homeDirectory: fixture.homeDirectory,
    }),
    /sol executor capacity is full \(4\/4\)/,
  );
  for (const lease of solLeases) {
    await finishExecutorRun(lease, completedExecution("review", "high"));
  }
});

test("machine capacity spans repositories and Playwright is capped at two", async (context) => {
  const fixture = await createFixture(context, "sol-luna-global-capacity-");
  const otherRepository = join(fixture.root, "other-repository");
  await mkdir(otherRepository, { recursive: true });
  await runGit(["init"], { cwd: otherRepository });
  const playwrightLeases = [
    await beginExecutorRun({
      cwd: fixture.repository,
      profile: "playwright",
      model: "gpt-5.6-luna",
      homeDirectory: fixture.homeDirectory,
    }),
    await beginExecutorRun({
      cwd: otherRepository,
      profile: "playwright",
      model: "gpt-5.6-luna",
      homeDirectory: fixture.homeDirectory,
    }),
  ];
  await assert.rejects(
    beginExecutorRun({
      cwd: fixture.repository,
      profile: "playwright",
      model: "gpt-5.6-luna",
      homeDirectory: fixture.homeDirectory,
    }),
    /Machine-wide Playwright executor capacity is full \(2\/2\)/,
  );
  for (const lease of playwrightLeases) {
    await finishExecutorRun(lease, completedExecution("playwright", "max"));
  }

  const leases = [];
  for (let index = 0; index < EXECUTOR_CAPACITY_LIMITS.luna; index += 1) {
    leases.push(
      await beginExecutorRun({
        cwd: index % 2 === 0 ? fixture.repository : otherRepository,
        profile: "explore",
        model: "gpt-5.6-luna",
        runId: `global-luna-${index}`,
        homeDirectory: fixture.homeDirectory,
      }),
    );
  }
  await assert.rejects(
    beginExecutorRun({
      cwd: fixture.repository,
      profile: "explore",
      model: "gpt-5.6-luna",
      homeDirectory: fixture.homeDirectory,
    }),
    /Machine-wide luna executor capacity is full \(10\/10\)/,
  );
  for (const lease of leases) {
    await finishExecutorRun(lease, completedExecution("explore", "max"));
  }
});

test("dead leases are pruned and corrupt capacity state fails closed", async (context) => {
  const fixture = await createFixture(context, "sol-luna-stale-capacity-");
  await beginExecutorRun({
    cwd: fixture.repository,
    profile: "explore",
    model: "gpt-5.6-luna",
    pid: 2_147_483_647,
    runId: "dead-run",
    homeDirectory: fixture.homeDirectory,
    processIdentityProvider: async ({ pid }) => testProcessIdentity(pid),
  });
  const active = await beginExecutorRun({
    cwd: fixture.repository,
    profile: "explore",
    model: "gpt-5.6-luna",
    runId: "active-run",
    homeDirectory: fixture.homeDirectory,
    processInspector: async (identity) => ({
      status: identity.pid === 2_147_483_647 ? "dead" : "same",
    }),
  });
  const status = await getOrchestrationStatus(fixture.repository, {
    homeDirectory: fixture.homeDirectory,
  });
  assert.equal(status.capacity.repository.luna, 1);
  assert.equal(status.capacity.machine.luna, 1);
  await finishExecutorRun(active, completedExecution("explore", "max"));

  const state = await getRepositoryState(fixture.repository, {
    homeDirectory: fixture.homeDirectory,
  });
  await mkdir(state.globalRunsDirectory, { recursive: true });
  await writeFile(join(state.globalRunsDirectory, "corrupt.json"), "{invalid}\n");
  await assert.rejects(
    beginExecutorRun({
      cwd: fixture.repository,
      profile: "review",
      model: "gpt-5.6-sol",
      homeDirectory: fixture.homeDirectory,
    }),
    /invalid JSON/,
  );
});

test("dead launcher leases retain capacity while a registered child may be active", async (context) => {
  const fixture = await createFixture(context, "sol-luna-active-child-");
  const orphaned = await beginExecutorRun({
    cwd: fixture.repository,
    profile: "explore",
    model: "gpt-5.6-luna",
    pid: 1111,
    runId: "orphaned-launcher",
    homeDirectory: fixture.homeDirectory,
    processIdentityProvider: async ({ pid }) => testProcessIdentity(pid),
  });
  await registerExecutorProcess(orphaned, {
    kind: "app-server",
    processIdentity: testProcessIdentity(2222),
  });
  await beginExecutorRun({
    cwd: fixture.repository,
    profile: "explore",
    model: "gpt-5.6-luna",
    runId: "next-launcher",
    homeDirectory: fixture.homeDirectory,
    processInspector: async (identity) => ({
      status: identity.pid === 1111 ? "dead" : "same",
    }),
  });
  const status = await getOrchestrationStatus(fixture.repository, {
    homeDirectory: fixture.homeDirectory,
    processInspector: async () => ({ status: "same" }),
  });
  assert.equal(status.capacity.repository.luna, 2);
  assert.equal(status.capacity.machine.luna, 2);
});
