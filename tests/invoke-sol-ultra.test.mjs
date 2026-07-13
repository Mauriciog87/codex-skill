import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  DEFAULT_ULTRA_SANDBOX_MODE,
  DEFAULT_ULTRA_TIMEOUT_SECONDS,
  UltraInvocationError,
  buildUltraCodexArguments,
  createStableUltraResult,
  createUltraDeveloperInstructions,
  invokeUltra,
  parseUltraArguments,
} from "../.agents/skills/sol-sol-orchestration/scripts/invoke-sol-ultra.mjs";
import {
  ORCHESTRATION_LOCK_ENV,
  SOL_MODEL_VERBOSITY,
  beginExecutorRun,
  finishExecutorRun,
  readUltraLock,
} from "../.agents/skills/sol-sol-orchestration/scripts/orchestration-state.mjs";

async function createFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "sol-ultra-launcher-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  const sessionsRoot = join(root, "sessions");
  const homeDirectory = join(root, "home");
  await mkdir(join(repository, ".git"), { recursive: true });
  return { root, repository, sessionsRoot, homeDirectory };
}

async function writeRoutingMetadata(sessionsRoot, threadId, effort, model = "gpt-5.6-sol") {
  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(
    join(sessionsRoot, `rollout-${threadId}.jsonl`),
    `${JSON.stringify({ type: "turn_context", payload: { model, effort } })}\n`,
  );
}

function completedPayload(overrides = {}) {
  return {
    status: "completed",
    summary: "Ultra task completed.",
    changed_files: [],
    checks: ["verified"],
    blockers: [],
    warnings: [],
    ...overrides,
  };
}

function processResult(threadId, overrides = {}) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    threadId,
    warnings: [],
    stderr: "",
    ...overrides,
  };
}

function createRunner(threadId, payload, action = async () => {}) {
  return async (_command, args, options) => {
    await action(options);
    const outputPath = args[args.indexOf("-o") + 1];
    await writeFile(outputPath, JSON.stringify(payload));
    return processResult(threadId);
  };
}

function ultraOptions(cwd, overrides = {}) {
  return {
    cwd,
    reason: "Architecture decision requires Ultra reasoning",
    confirmed: true,
    sandboxMode: DEFAULT_ULTRA_SANDBOX_MODE,
    timeoutSeconds: 10,
    ...overrides,
  };
}

test("Ultra arguments require a reason and explicit human confirmation", () => {
  const baseDirectory = resolve("fixture");
  assert.deepEqual(
    parseUltraArguments(
      ["--reason", "Critical decision", "--confirm-exclusive-takeover"],
      baseDirectory,
    ),
    {
      cwd: baseDirectory,
      reason: "Critical decision",
      confirmed: true,
      sandboxMode: DEFAULT_ULTRA_SANDBOX_MODE,
      timeoutSeconds: DEFAULT_ULTRA_TIMEOUT_SECONDS,
    },
  );
  for (const args of [
    ["--confirm-exclusive-takeover"],
    ["--reason", "Missing confirmation"],
    ["--reason", "x", "--reason", "y", "--confirm-exclusive-takeover"],
    ["--reason", "x", "--confirm-exclusive-takeover", "--sandbox", "danger-full-access"],
    ["--reason", "x", "--confirm-exclusive-takeover", "--timeout-seconds", "0"],
  ]) {
    assert.throws(() => parseUltraArguments(args), UltraInvocationError);
  }
});

test("Ultra arguments allow only explicit workspace write", () => {
  const parsed = parseUltraArguments([
    "--cwd",
    "repository",
    "--reason",
    "Critical migration",
    "--confirm-exclusive-takeover",
    "--sandbox",
    "workspace-write",
    "--timeout-seconds",
    "42",
  ]);
  assert.equal(parsed.sandboxMode, "workspace-write");
  assert.equal(parsed.timeoutSeconds, 42);
  assert.match(parsed.cwd, /repository$/);
});

test("Ultra command and instructions pin the exclusive Sol runtime", () => {
  const instructions = createUltraDeveloperInstructions("lock-123");
  assert.match(instructions, /^CODEX_ORCHESTRATION_ROLE=ultra-orchestrator$/m);
  assert.match(instructions, /^CODEX_ORCHESTRATION_LOCK_ID=lock-123$/m);
  assert.match(instructions, /Do not use native spawn_agent/);
  assert.match(instructions, /invoke-sol-executor\.mjs/);
  const args = buildUltraCodexArguments({
    cwd: resolve("repository"),
    sandboxMode: "read-only",
    lockId: "lock-123",
    outputPath: resolve("result.json"),
  });
  assert.deepEqual(args.slice(0, 13), [
    "-m",
    "gpt-5.6-sol",
    "-c",
    'model_reasoning_effort="ultra"',
    "-c",
    `model_verbosity=${JSON.stringify(SOL_MODEL_VERBOSITY)}`,
    "-c",
    "features.multi_agent=false",
    "-c",
    "agents.max_depth=1",
    "-c",
    "agents.max_threads=1",
    "-c",
  ]);
  assert.equal(args.includes("danger-full-access"), false);
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.equal(args.includes("--ask-for-approval"), false);
});

test("Ultra result preserves the public key order", () => {
  const result = createStableUltraResult({ status: "completed", summary: "done" });
  assert.deepEqual(Object.keys(result), [
    "status",
    "mode",
    "lock_id",
    "thread_id",
    "model",
    "reasoning_effort",
    "routing_verified",
    "sandbox_mode",
    "summary",
    "changed_files",
    "executors",
    "checks",
    "blockers",
    "warnings",
  ]);
});

test("verified Ultra completion releases its repository lock", async (context) => {
  const fixture = await createFixture(context);
  const threadId = "ultra-completed";
  await writeRoutingMetadata(fixture.sessionsRoot, threadId, "ultra");
  const execution = await invokeUltra({
    briefing: "Resolve the bounded architecture problem.",
    options: ultraOptions(fixture.repository),
    sessionRoots: [fixture.sessionsRoot],
    processRunner: createRunner(threadId, completedPayload()),
    coordinationOptions: { homeDirectory: fixture.homeDirectory },
  });
  assert.equal(execution.exitCode, 0);
  assert.equal(execution.result.status, "completed");
  assert.equal(execution.result.model, "gpt-5.6-sol");
  assert.equal(execution.result.reasoning_effort, "ultra");
  assert.equal(execution.result.routing_verified, true);
  assert.equal(
    await readUltraLock(fixture.repository, { homeDirectory: fixture.homeDirectory }),
    null,
  );
});

test("structured blocked Ultra result exits one and releases the lock", async (context) => {
  const fixture = await createFixture(context);
  const threadId = "ultra-blocked";
  await writeRoutingMetadata(fixture.sessionsRoot, threadId, "ultra");
  const execution = await invokeUltra({
    briefing: "Evaluate the bounded blocker.",
    options: ultraOptions(fixture.repository),
    sessionRoots: [fixture.sessionsRoot],
    processRunner: createRunner(
      threadId,
      completedPayload({ status: "blocked", blockers: ["Human input required"] }),
    ),
    coordinationOptions: { homeDirectory: fixture.homeDirectory },
  });
  assert.equal(execution.exitCode, 1);
  assert.equal(execution.result.status, "blocked");
  assert.equal(
    await readUltraLock(fixture.repository, { homeDirectory: fixture.homeDirectory }),
    null,
  );
});

test("Ultra reconstructs verified executors from registered leases", async (context) => {
  const fixture = await createFixture(context);
  const threadId = "ultra-with-executor";
  await writeRoutingMetadata(fixture.sessionsRoot, threadId, "ultra");
  const execution = await invokeUltra({
    briefing: "Implement the bounded temporary change.",
    options: ultraOptions(fixture.repository, { sandboxMode: "workspace-write" }),
    sessionRoots: [fixture.sessionsRoot],
    processRunner: createRunner(threadId, completedPayload(), async (runnerOptions) => {
      const lease = await beginExecutorRun({
        cwd: fixture.repository,
        profile: "implement",
        environment: runnerOptions.environment,
        homeDirectory: fixture.homeDirectory,
      });
      assert.equal(
        runnerOptions.environment[ORCHESTRATION_LOCK_ENV],
        lease.lock_id,
      );
      await finishExecutorRun(lease, {
        exitCode: 0,
        result: {
          status: "completed",
          profile: "implement",
          thread_id: "implement-thread",
          model: "gpt-5.6-sol",
          reasoning_effort: "high",
          routing_verified: true,
        },
      });
    }),
    coordinationOptions: { homeDirectory: fixture.homeDirectory },
  });
  assert.equal(execution.exitCode, 0);
  assert.deepEqual(execution.result.executors, [
    {
      profile: "implement",
      status: "completed",
      thread_id: "implement-thread",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      routing_verified: true,
    },
  ]);
});

test("timeout and routing mismatch require manual recovery", async (context) => {
  const timeoutFixture = await createFixture(context);
  const timeoutExecution = await invokeUltra({
    briefing: "Wait for the bounded result.",
    options: ultraOptions(timeoutFixture.repository),
    processRunner: async () => processResult("timed-out", { timedOut: true }),
    coordinationOptions: { homeDirectory: timeoutFixture.homeDirectory },
  });
  assert.equal(timeoutExecution.exitCode, 2);
  assert.match(timeoutExecution.result.summary, /timed out/);
  assert.equal(
    (await readUltraLock(timeoutFixture.repository, {
      homeDirectory: timeoutFixture.homeDirectory,
    })).state,
    "recovery-required",
  );

  const mismatchFixture = await createFixture(context);
  const threadId = "ultra-mismatch";
  await writeRoutingMetadata(mismatchFixture.sessionsRoot, threadId, "xhigh", "gpt-5.5");
  const mismatchExecution = await invokeUltra({
    briefing: "Verify routing.",
    options: ultraOptions(mismatchFixture.repository),
    sessionRoots: [mismatchFixture.sessionsRoot],
    processRunner: createRunner(threadId, completedPayload()),
    coordinationOptions: { homeDirectory: mismatchFixture.homeDirectory },
  });
  assert.equal(mismatchExecution.exitCode, 2);
  assert.equal(mismatchExecution.result.model, "gpt-5.5");
  assert.equal(mismatchExecution.result.reasoning_effort, "xhigh");
  assert.equal(mismatchExecution.result.routing_verified, false);
  assert.equal(
    (await readUltraLock(mismatchFixture.repository, {
      homeDirectory: mismatchFixture.homeDirectory,
    })).state,
    "recovery-required",
  );
});
