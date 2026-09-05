import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { MODEL_VERBOSITY } from "../.agents/skills/sol-luna-orchestration/scripts/model-policy.mjs";
import { runGit } from "../.agents/skills/sol-luna-orchestration/scripts/git-workspace.mjs";
import {
  DEFAULT_ULTRA_SANDBOX_MODE,
  DEFAULT_ULTRA_TIMEOUT_SECONDS,
  UltraInvocationError,
  buildUltraAppServerArguments,
  createStableUltraResult,
  createUltraDeveloperInstructions,
  invokeUltra,
  parseUltraArguments,
} from "../.agents/skills/sol-luna-orchestration/scripts/invoke-sol-ultra.mjs";
import {
  ORCHESTRATION_GENERATION_ENV,
  ORCHESTRATION_LOCK_ENV,
  beginExecutorRun,
  finishExecutorRun,
  readOrchestrationHistory,
  readUltraLock,
} from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-state.mjs";
import { AppServerTimeoutError } from "../.agents/skills/sol-luna-orchestration/scripts/codex-app-server-client.mjs";

async function createFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "sol-ultra-launcher-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  const sessionsRoot = join(root, "sessions");
  const homeDirectory = join(root, "home");
  await mkdir(repository, { recursive: true });
  await runGit(["init"], { cwd: repository });
  return { root, repository, sessionsRoot, homeDirectory };
}

async function writeRoutingMetadata(sessionsRoot, threadId, effort, model = "gpt-6-astra") {
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
    operator_requests: [],
    ...overrides,
  };
}

function createRunner(threadId, payload, action = async () => {}) {
  return async (options) => {
    await action(options);
    return {
      threadId,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      serviceTier: options.serviceTier,
      turnStatus: "completed",
      finalResponse: JSON.stringify(payload),
      blockedReason: null,
      warnings: [],
      stderr: "",
      playwrightMcpUsed: false,
      unsafePlaywrightToolUsed: false,
    };
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

function processIdentityProvider() {
  let sequence = 0;
  return async ({ pid }) => ({
    pid,
    instance_id: `test-process-${pid}-${sequence += 1}`,
    start_fingerprint: `start-${pid}`,
    hostname: "test-host",
    platform: process.platform,
    architecture: process.arch,
  });
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

test("Ultra command and instructions pin the exclusive Astra runtime", () => {
  const instructions = createUltraDeveloperInstructions("lock-123", 7);
  assert.match(instructions, /^CODEX_ORCHESTRATION_ROLE=ultra-orchestrator$/m);
  assert.match(instructions, /^CODEX_ORCHESTRATION_LOCK_ID=lock-123$/m);
  assert.match(instructions, /^CODEX_ORCHESTRATION_GENERATION=7$/m);
  assert.match(instructions, /Do not use native spawn_agent/);
  assert.match(instructions, /invoke-profile-executor\.mjs/);
  assert.match(instructions, /implement-lite\|playwright/);
  assert.match(instructions, /Always include operator_requests/);
  const args = buildUltraAppServerArguments();
  assert.ok(args.includes(`model_verbosity=${JSON.stringify(MODEL_VERBOSITY)}`));
  assert.ok(args.includes('service_tier="default"'));
  assert.ok(args.includes("features.fast_mode=false"));
  assert.ok(args.includes("features.multi_agent=false"));
  assert.ok(args.includes("agents.max_depth=1"));
  assert.ok(args.includes("agents.max_threads=1"));
  assert.deepEqual(args.slice(-3), ["app-server", "--listen", "stdio://"]);
  assert.equal(args.includes("exec"), false);
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
    "generation",
    "thread_id",
    "model",
    "reasoning_effort",
    "service_tier",
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

test("Ultra rejects an invalid output contract before acquiring its lock", async (context) => {
  const fixture = await createFixture(context);
  let appServerStarted = false;
  await assert.rejects(
    invokeUltra({
      briefing: "Do not start with an invalid contract.",
      options: ultraOptions(fixture.repository),
      outputContractLoader: async () => {
        throw new Error("invalid executor output schema");
      },
      appServerRunner: async () => {
        appServerStarted = true;
      },
      coordinationOptions: { homeDirectory: fixture.homeDirectory },
    }),
    /invalid executor output schema/,
  );
  assert.equal(appServerStarted, false);
  assert.equal(
    await readUltraLock(fixture.repository, { homeDirectory: fixture.homeDirectory }),
    null,
  );
});

test("verified Ultra completion releases its repository lock", async (context) => {
  const fixture = await createFixture(context);
  const threadId = "ultra-completed";
  await writeRoutingMetadata(fixture.sessionsRoot, threadId, "ultra");
  const execution = await invokeUltra({
    briefing: "Resolve the bounded architecture problem.",
    options: ultraOptions(fixture.repository),
    sessionRoots: [fixture.sessionsRoot],
    appServerRunner: createRunner(threadId, completedPayload()),
    coordinationOptions: { homeDirectory: fixture.homeDirectory },
  });
  assert.equal(execution.exitCode, 0);
  assert.equal(execution.result.status, "completed");
  assert.equal(execution.result.model, "gpt-6-astra");
  assert.equal(execution.result.reasoning_effort, "ultra");
  assert.equal(execution.result.service_tier, "standard");
  assert.equal(execution.result.routing_verified, true);
  assert.equal(execution.result.generation, 1);
  assert.equal(
    await readUltraLock(fixture.repository, { homeDirectory: fixture.homeDirectory }),
    null,
  );
});

test("Ultra registers its App Server before accepting protocol results", async (context) => {
  const fixture = await createFixture(context);
  const threadId = "ultra-process-registered";
  await writeRoutingMetadata(fixture.sessionsRoot, threadId, "ultra");
  const execution = await invokeUltra({
    briefing: "Verify process registration.",
    options: ultraOptions(fixture.repository),
    sessionRoots: [fixture.sessionsRoot],
    appServerRunner: createRunner(threadId, completedPayload(), async (runnerOptions) => {
      assert.equal(typeof runnerOptions.onProcessStarted, "function");
      await runnerOptions.onProcessStarted({ pid: 9_876 });
    }),
    coordinationOptions: {
      homeDirectory: fixture.homeDirectory,
      processIdentityProvider: processIdentityProvider(),
      processInspector: async () => ({ status: "dead" }),
    },
  });
  assert.equal(execution.exitCode, 0);
  const history = await readOrchestrationHistory(fixture.repository, {
    homeDirectory: fixture.homeDirectory,
    limit: 200,
  });
  assert.equal(
    history.events.some((event) => event.reason_code === "ultra-app-server-registered"),
    true,
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
    appServerRunner: createRunner(
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
    appServerRunner: createRunner(threadId, completedPayload(), async (runnerOptions) => {
      const lease = await beginExecutorRun({
        cwd: fixture.repository,
        profile: "implement",
        model: "gpt-6-astra",
        environment: runnerOptions.environment,
        homeDirectory: fixture.homeDirectory,
      });
      assert.equal(
        runnerOptions.environment[ORCHESTRATION_LOCK_ENV],
        lease.lock_id,
      );
      assert.equal(
        runnerOptions.environment[ORCHESTRATION_GENERATION_ENV],
        String(lease.generation),
      );
      await finishExecutorRun(lease, {
        exitCode: 0,
        result: {
          status: "completed",
          profile: "implement",
          thread_id: "implement-thread",
          model: "gpt-6-astra",
          reasoning_effort: "medium",
          service_tier: "standard",
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
      model: "gpt-6-astra",
      reasoning_effort: "medium",
      service_tier: "standard",
      routing_verified: true,
    },
  ]);
});

test("timeout and routing mismatch require manual recovery", async (context) => {
  const timeoutFixture = await createFixture(context);
  const timeoutExecution = await invokeUltra({
    briefing: "Wait for the bounded result.",
    options: ultraOptions(timeoutFixture.repository),
    appServerRunner: async () => {
      throw new AppServerTimeoutError("Ultra takeover timed out after 10 seconds.", {
        threadId: "timed-out",
      });
    },
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
    appServerRunner: createRunner(threadId, completedPayload()),
    coordinationOptions: { homeDirectory: mismatchFixture.homeDirectory },
  });
  assert.equal(mismatchExecution.exitCode, 2);
  assert.equal(mismatchExecution.result.model, "gpt-5.5");
  assert.equal(mismatchExecution.result.reasoning_effort, "xhigh");
  assert.equal(mismatchExecution.result.service_tier, "standard");
  assert.equal(mismatchExecution.result.routing_verified, false);
  assert.equal(
    (await readUltraLock(mismatchFixture.repository, {
      homeDirectory: mismatchFixture.homeDirectory,
    })).state,
    "recovery-required",
  );
});
