import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAction,
  dispatchAssignmentAction,
  readAssignment,
} from "../.agents/skills/sol-luna-orchestration/scripts/control-plane.mjs";
import { invokeDurableExecutor } from "../.agents/skills/sol-luna-orchestration/scripts/durable-executor.mjs";
import { cleanupAssignmentWorktree, runGit } from "../.agents/skills/sol-luna-orchestration/scripts/git-workspace.mjs";
import {
  ORCHESTRATION_GENERATION_ENV,
  ORCHESTRATION_LOCK_ENV,
  ORCHESTRATION_ROLE_ENV,
  acquireUltraLock,
} from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-state.mjs";

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "sol-luna-durable-executor-"));
  const repository = join(root, "repository");
  const home = join(root, "home");
  await mkdir(join(repository, "src"), { recursive: true });
  await mkdir(home, { recursive: true });
  await runGit(["init"], { cwd: repository });
  await writeFile(join(repository, "src", "value.txt"), "base\n", "utf8");
  await runGit(["add", "-A"], { cwd: repository });
  await runGit(
    ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "initial"],
    { cwd: repository },
  );
  const environment = { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex") };
  return {
    root,
    repository,
    environment,
    coordinationOptions: { environment, homeDirectory: home, platform: process.platform },
  };
}

function options(repository, profile = "implement") {
  return {
    profile,
    cwd: repository,
    sandboxMode: profile === "implement" ? "workspace-write" : "read-only",
    timeoutSeconds: 10,
    controlPlane: "v2",
    resultFormat: "v2",
    assignmentId: null,
    enqueueOnly: false,
    priority: "normal",
    writeRoots: profile === "implement" ? ["src"] : [],
    forbiddenRoots: [],
    requiredChecks: [],
    artifacts: [],
    reviewPolicy: "root",
    operatorApprovalRequired: false,
    allowSymlinks: false,
    allowSubmodules: false,
    candidateId: null,
  };
}

function execution(profile, changedFiles, summary = "completed") {
  return {
    result: {
      status: "completed",
      profile,
      thread_id: "thread-id",
      model: profile === "explore" ? "gpt-5.6-luna" : "gpt-5.6-sol",
      reasoning_effort: profile === "explore" ? "max" : "high",
      service_tier: profile === "explore" ? "fast" : "standard",
      routing_verified: true,
      sandbox_mode: profile === "implement" ? "workspace-write" : "read-only",
      summary,
      changed_files: changedFiles,
      checks: [],
      blockers: [],
      warnings: [],
    },
    operatorRequests: [],
    exitCode: 0,
  };
}

async function dispatch(record, op, authority, payload, fixture) {
  return (
    await dispatchAssignmentAction(
      record.repository,
      createAction({ op, authority, record, payload }),
      fixture.coordinationOptions,
    )
  ).record;
}

test("durable writer executes inside sandbox worktree and publishes an immutable candidate", async () => {
  const fixture = await createFixture();
  let record;
  try {
    let invokedCwd = null;
    const response = await invokeDurableExecutor({
      briefing: "Change the scoped value.",
      options: options(fixture.repository),
      environment: fixture.environment,
      coordinationOptions: fixture.coordinationOptions,
      invokeLegacy: async (input) => {
        invokedCwd = input.options.cwd;
        assert.notEqual(input.options.cwd, fixture.repository);
        assert.equal(input.options.sandboxMode, "workspace-write");
        await writeFile(join(input.options.cwd, "src", "value.txt"), "candidate\n", "utf8");
        return execution("implement", ["src/value.txt"]);
      },
    });
    assert.notEqual(invokedCwd, fixture.repository);
    assert.equal(response.result.schema_version, 2);
    assert.equal(response.result.status, "completed");
    assert.ok(response.result.candidate.candidate_id.length === 64);
    assert.equal(await readFile(join(fixture.repository, "src", "value.txt"), "utf8"), "base\n");
    record = await readAssignment(
      fixture.repository,
      response.result.assignment_id,
      fixture.coordinationOptions,
    );
    assert.equal(record.state, "result_ready");
    assert.equal(record.workspace.path, invokedCwd);
    await cleanupAssignmentWorktree(record, fixture.coordinationOptions);
  } finally {
    await runGit(["worktree", "prune"], { cwd: fixture.repository, allowFailure: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("durable writer fails closed when main checkout overlaps its scope", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.repository, "src", "value.txt"), "dirty\n", "utf8");
    let invoked = false;
    const response = await invokeDurableExecutor({
      briefing: "Do not overwrite local work.",
      options: options(fixture.repository),
      environment: fixture.environment,
      coordinationOptions: fixture.coordinationOptions,
      invokeLegacy: async () => {
        invoked = true;
        return execution("implement", []);
      },
    });
    assert.equal(invoked, false);
    assert.equal(response.result.status, "failed");
    assert.match(response.result.summary, /local changes inside the assignment scope/);
    const record = await readAssignment(
      fixture.repository,
      response.result.assignment_id,
      fixture.coordinationOptions,
    );
    assert.equal(record.state, "failed");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("enqueue-only persists work without starting an executor", async () => {
  const fixture = await createFixture();
  try {
    const invocationOptions = options(fixture.repository, "explore");
    invocationOptions.enqueueOnly = true;
    let invoked = false;
    const response = await invokeDurableExecutor({
      briefing: "Queue exploration.",
      options: invocationOptions,
      environment: fixture.environment,
      coordinationOptions: fixture.coordinationOptions,
      invokeLegacy: async () => {
        invoked = true;
        return execution("explore", []);
      },
    });
    assert.equal(invoked, false);
    assert.equal(response.result.status, "queued");
    const record = await readAssignment(
      fixture.repository,
      response.result.assignment_id,
      fixture.coordinationOptions,
    );
    assert.equal(record.state, "queued");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("candidate reviewer runs on the exact candidate revision and advances the parent", async () => {
  const fixture = await createFixture();
  let writerRecord;
  let reviewerRecord;
  try {
    const writerOptions = options(fixture.repository);
    writerOptions.reviewPolicy = "independent";
    const writerResponse = await invokeDurableExecutor({
      briefing: "Create candidate.",
      options: writerOptions,
      environment: fixture.environment,
      coordinationOptions: fixture.coordinationOptions,
      invokeLegacy: async (input) => {
        await writeFile(join(input.options.cwd, "src", "value.txt"), "candidate\n", "utf8");
        return execution("implement", ["src/value.txt"]);
      },
    });
    writerRecord = await readAssignment(
      fixture.repository,
      writerResponse.result.assignment_id,
      fixture.coordinationOptions,
    );
    writerRecord = await dispatch(writerRecord, "claim_result", "root", {}, fixture);
    writerRecord = await dispatch(writerRecord, "request_review", "root", {
      candidate_id: writerRecord.candidate.candidate_id,
    }, fixture);
    const reviewOptions = options(fixture.repository, "review");
    reviewOptions.candidateId = writerRecord.candidate.candidate_id;
    const reviewResponse = await invokeDurableExecutor({
      briefing: "Review the candidate.",
      options: reviewOptions,
      environment: fixture.environment,
      coordinationOptions: fixture.coordinationOptions,
      invokeLegacy: async (input) => {
        const revision = (await runGit(["rev-parse", "HEAD"], { cwd: input.options.cwd })).stdoutText.trim();
        assert.equal(revision, writerRecord.candidate.candidate_revision);
        return execution("review", [], "APPROVE exact candidate");
      },
    });
    assert.equal(reviewResponse.result.status, "completed", reviewResponse.result.summary);
    reviewerRecord = await readAssignment(
      fixture.repository,
      reviewResponse.result.assignment_id,
      fixture.coordinationOptions,
    );
    writerRecord = await readAssignment(fixture.repository, writerRecord.assignment_id, fixture.coordinationOptions);
    assert.equal(writerRecord.state, "approval_pending");
    assert.equal(writerRecord.review.reviewed_candidate_id, writerRecord.candidate.candidate_id);
  } finally {
    if (reviewerRecord?.workspace?.path) {
      await cleanupAssignmentWorktree(reviewerRecord, fixture.coordinationOptions).catch(() => {});
    }
    if (writerRecord?.workspace?.path) {
      await cleanupAssignmentWorktree(writerRecord, fixture.coordinationOptions).catch(() => {});
    }
    await runGit(["worktree", "prune"], { cwd: fixture.repository, allowFailure: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("REQUEST_CHANGES is published to the parent and finalizes the reviewer assignment", async () => {
  const fixture = await createFixture();
  let writerRecord;
  let reviewerRecord;
  try {
    const writerOptions = options(fixture.repository);
    writerOptions.reviewPolicy = "independent";
    const writerResponse = await invokeDurableExecutor({
      briefing: "Create candidate for negative review.",
      options: writerOptions,
      environment: fixture.environment,
      coordinationOptions: fixture.coordinationOptions,
      invokeLegacy: async (input) => {
        await writeFile(join(input.options.cwd, "src", "value.txt"), "candidate\n", "utf8");
        return execution("implement", ["src/value.txt"]);
      },
    });
    writerRecord = await readAssignment(
      fixture.repository,
      writerResponse.result.assignment_id,
      fixture.coordinationOptions,
    );
    writerRecord = await dispatch(writerRecord, "claim_result", "root", {}, fixture);
    writerRecord = await dispatch(writerRecord, "request_review", "root", {
      candidate_id: writerRecord.candidate.candidate_id,
    }, fixture);
    const reviewOptions = options(fixture.repository, "review");
    reviewOptions.candidateId = writerRecord.candidate.candidate_id;
    const reviewResponse = await invokeDurableExecutor({
      briefing: "Reject the exact candidate.",
      options: reviewOptions,
      environment: fixture.environment,
      coordinationOptions: fixture.coordinationOptions,
      invokeLegacy: async () => {
        const rejected = execution("review", [], "REQUEST_CHANGES unsafe behavior");
        rejected.result.status = "blocked";
        rejected.result.blockers = ["unsafe behavior"];
        rejected.exitCode = 1;
        return rejected;
      },
    });
    assert.equal(reviewResponse.result.status, "blocked");
    reviewerRecord = await readAssignment(
      fixture.repository,
      reviewResponse.result.assignment_id,
      fixture.coordinationOptions,
    );
    writerRecord = await readAssignment(fixture.repository, writerRecord.assignment_id, fixture.coordinationOptions);
    assert.equal(writerRecord.state, "blocked");
    assert.equal(writerRecord.review.verdict, "REQUEST_CHANGES");
    assert.equal(reviewerRecord.state, "abandoned");
  } finally {
    if (reviewerRecord?.workspace?.path) {
      await cleanupAssignmentWorktree(reviewerRecord, fixture.coordinationOptions).catch(() => {});
    }
    if (writerRecord?.workspace?.path) {
      await cleanupAssignmentWorktree(writerRecord, fixture.coordinationOptions).catch(() => {});
    }
    await runGit(["worktree", "prune"], { cwd: fixture.repository, allowFailure: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an Ultra-owned assignment cannot resume without its exact epoch environment", async () => {
  const fixture = await createFixture();
  try {
    const lock = await acquireUltraLock({
      cwd: fixture.repository,
      reason: "Durable epoch ownership test",
      sandboxMode: "read-only",
      ...fixture.coordinationOptions,
    });
    const lockedEnvironment = {
      ...fixture.environment,
      [ORCHESTRATION_LOCK_ENV]: lock.lock_id,
      [ORCHESTRATION_GENERATION_ENV]: String(lock.generation),
      [ORCHESTRATION_ROLE_ENV]: "ultra-orchestrator",
    };
    const enqueueOptions = options(fixture.repository, "explore");
    enqueueOptions.enqueueOnly = true;
    const queued = await invokeDurableExecutor({
      briefing: "Queue Ultra-owned exploration.",
      options: enqueueOptions,
      environment: lockedEnvironment,
      coordinationOptions: fixture.coordinationOptions,
      invokeLegacy: async () => execution("explore", []),
    });
    const resumeOptions = options(fixture.repository, "explore");
    resumeOptions.assignmentId = queued.result.assignment_id;
    await assert.rejects(
      invokeDurableExecutor({
        briefing: "",
        options: resumeOptions,
        environment: fixture.environment,
        coordinationOptions: fixture.coordinationOptions,
        invokeLegacy: async () => execution("explore", []),
      }),
      (error) => error.code === "stale-epoch",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
