import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ORCHESTRATION_LOCK_ENV,
  acquireUltraLock,
  beginExecutorRun,
  finishExecutorRun,
  getOrchestrationStatus,
  getRepositoryKey,
  getRepositoryState,
  listUltraExecutorResults,
  readUltraLock,
  recoverUltraLock,
  releaseUltraLock,
  updateUltraLock,
} from "../.agents/skills/sol-sol-orchestration/scripts/orchestration-state.mjs";

async function createFixture(context, prefix = "sol-ultra-state-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  const homeDirectory = join(root, "home");
  const repository = join(root, "repository");
  await mkdir(join(repository, ".git"), { recursive: true });
  return { root, homeDirectory, repository };
}

function completedExecution(profile, effort) {
  return {
    exitCode: 0,
    result: {
      status: "completed",
      profile,
      thread_id: `${profile}-thread`,
      model: "gpt-5.6-sol",
      reasoning_effort: effort,
      routing_verified: true,
    },
  };
}

test("Ultra lock acquisition is exclusive and repository scoped", async (context) => {
  const fixture = await createFixture(context);
  const otherRepository = join(fixture.root, "other-repository");
  await mkdir(join(otherRepository, ".git"), { recursive: true });
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
    homeDirectory: fixture.homeDirectory,
  });
  await releaseUltraLock({
    cwd: otherRepository,
    lockId: second.lock_id,
    homeDirectory: fixture.homeDirectory,
  });
});

test("executor leases block Ultra and Ultra admits only the matching lock id", async (context) => {
  const fixture = await createFixture(context);
  const lease = await beginExecutorRun({
    cwd: fixture.repository,
    profile: "explore",
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
  await finishExecutorRun(lease, completedExecution("explore", "medium"));
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
      homeDirectory: fixture.homeDirectory,
    }),
    /locked by an exclusive Sol Ultra takeover/,
  );
  const inheritedLease = await beginExecutorRun({
    cwd: fixture.repository,
    profile: "review",
    environment: { [ORCHESTRATION_LOCK_ENV]: lock.lock_id },
    homeDirectory: fixture.homeDirectory,
  });
  await finishExecutorRun(inheritedLease, completedExecution("review", "high"));
  assert.deepEqual(
    await listUltraExecutorResults({
      cwd: fixture.repository,
      lockId: lock.lock_id,
      homeDirectory: fixture.homeDirectory,
    }),
    [
      {
        profile: "review",
        status: "completed",
        thread_id: "review-thread",
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        routing_verified: true,
      },
    ],
  );
  await releaseUltraLock({
    cwd: fixture.repository,
    lockId: lock.lock_id,
    homeDirectory: fixture.homeDirectory,
  });
});

test("simultaneous executor and Ultra acquisition cannot both succeed", async (context) => {
  const fixture = await createFixture(context, "sol-ultra-race-");
  const [executorAttempt, ultraAttempt] = await Promise.allSettled([
    beginExecutorRun({
      cwd: fixture.repository,
      profile: "explore",
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
    await finishExecutorRun(executorAttempt.value, completedExecution("explore", "medium"));
  }
  if (ultraAttempt.status === "fulfilled") {
    await releaseUltraLock({
      cwd: fixture.repository,
      lockId: ultraAttempt.value.lock_id,
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
    state: "recovery-required",
    homeDirectory: fixture.homeDirectory,
  });
  await assert.rejects(
    releaseUltraLock({
      cwd: fixture.repository,
      lockId: lock.lock_id,
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
    homeDirectory: fixture.homeDirectory,
  });
});

test("Windows repository keys normalize path casing", () => {
  assert.equal(
    getRepositoryKey("C:\\Users\\MAURI\\Repo", "win32"),
    getRepositoryKey("c:\\users\\mauri\\repo", "win32"),
  );
});
