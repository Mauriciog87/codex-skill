import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  DEFAULT_SANDBOX_MODE,
  DEFAULT_TIMEOUT_SECONDS,
  EXECUTOR_MODEL,
  EXECUTOR_REASONING_EFFORT,
  ExecutorConfigurationError,
  ExecutorInvocationError,
  RoutingVerificationError,
  buildCodexArguments,
  createStableResult,
  determineExitCode,
  invokeExecutor,
  parseArguments,
  runProcess,
  validateExecutorPayload,
  verifySessionRouting,
} from "../.agents/skills/sol-sol-orchestration/scripts/invoke-sol-executor.mjs";

test("parseArguments applies safe defaults", () => {
  const baseDirectory = resolve("fixtures", "repository");
  assert.deepEqual(parseArguments([], baseDirectory), {
    cwd: baseDirectory,
    sandboxMode: DEFAULT_SANDBOX_MODE,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  });
});

test("parseArguments accepts the supported options", () => {
  const baseDirectory = resolve("fixtures");
  assert.deepEqual(
    parseArguments(
      [
        "--cwd",
        "repository",
        "--sandbox",
        "workspace-write",
        "--timeout-seconds",
        "42",
      ],
      baseDirectory,
    ),
    {
      cwd: resolve(baseDirectory, "repository"),
      sandboxMode: "workspace-write",
      timeoutSeconds: 42,
    },
  );
});

test("parseArguments rejects unsafe and invalid invocations", () => {
  assert.throws(
    () => parseArguments(["--sandbox", "danger-full-access"]),
    ExecutorInvocationError,
  );
  assert.throws(
    () => parseArguments(["--sandbox", "unsupported"]),
    ExecutorInvocationError,
  );
  assert.throws(
    () => parseArguments(["--timeout-seconds", "0"]),
    ExecutorInvocationError,
  );
  assert.throws(() => parseArguments(["--unknown", "value"]), ExecutorInvocationError);
});

test("buildCodexArguments pins Sol high without approval or bypass flags", () => {
  const args = buildCodexArguments({
    cwd: resolve("repository"),
    sandboxMode: "read-only",
    schemaPath: resolve("schema.json"),
    outputPath: resolve("result.json"),
    developerInstructions: "CODEX_ORCHESTRATION_ROLE=executor",
  });

  assert.deepEqual(args.slice(0, 11), [
    "-m",
    EXECUTOR_MODEL,
    "-c",
    'model_reasoning_effort="high"',
    "-c",
    "features.multi_agent=false",
    "-c",
    "agents.max_depth=1",
    "-c",
    "agents.max_threads=1",
    "-c",
  ]);
  assert.ok(args.includes('developer_instructions="CODEX_ORCHESTRATION_ROLE=executor"'));
  assert.ok(args.includes("exec"));
  assert.ok(args.includes("--json"));
  assert.ok(args.includes("--output-schema"));
  assert.equal(args.at(-1), "-");
  for (const prohibitedFlag of [
    "--dangerously-bypass-approvals-and-sandbox",
    "--full-auto",
    "--ask-for-approval",
    "-a",
  ]) {
    assert.equal(args.includes(prohibitedFlag), false);
  }
});

test("validateExecutorPayload enforces the structured result", () => {
  const payload = {
    status: "completed",
    summary: "Completed the bounded task.",
    changed_files: [],
    checks: ["node --test passed"],
    blockers: [],
    warnings: [],
  };
  assert.deepEqual(validateExecutorPayload(payload), payload);
  assert.throws(
    () => validateExecutorPayload({ ...payload, unexpected: true }),
    ExecutorConfigurationError,
  );
  assert.throws(
    () => validateExecutorPayload({ ...payload, warnings: "none" }),
    ExecutorConfigurationError,
  );
});

test("createStableResult preserves the public property order", () => {
  const result = createStableResult({
    status: "completed",
    threadId: "thread-id",
    sandboxMode: "read-only",
    summary: "Done.",
  });
  assert.deepEqual(Object.keys(result), [
    "status",
    "thread_id",
    "model",
    "reasoning_effort",
    "routing_verified",
    "sandbox_mode",
    "summary",
    "changed_files",
    "checks",
    "blockers",
    "warnings",
  ]);
  assert.equal(result.model, null);
  assert.equal(result.reasoning_effort, null);
  assert.equal(result.routing_verified, false);
});

test("determineExitCode maps completion, task failures, and configuration failures", () => {
  assert.equal(determineExitCode({ status: "completed" }), 0);
  assert.equal(determineExitCode({ status: "blocked" }), 1);
  assert.equal(determineExitCode({ status: "failed" }), 1);
  assert.equal(determineExitCode({ status: "completed", codexExitCode: 1 }), 1);
  assert.equal(determineExitCode({ status: "completed", routingVerified: false }), 2);
  assert.equal(determineExitCode({ status: "completed", timedOut: true }), 2);
  assert.equal(determineExitCode({ status: "completed", configurationValid: false }), 2);
});

test("runProcess terminates a timed-out child", async () => {
  const result = await runProcess(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { timeoutMs: 100 },
  );
  assert.equal(result.timedOut, true);
});

test("verifySessionRouting accepts Sol high and rejects model or effort mismatches", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-sol-routing-test-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionsRoot = join(temporaryRoot, "sessions", "2026", "07", "09");
  await mkdir(sessionsRoot, { recursive: true });

  const validThreadId = "valid-sol-thread";
  await writeFile(
    join(sessionsRoot, `rollout-${validThreadId}.jsonl`),
    `${JSON.stringify({
      type: "turn_context",
      payload: { model: EXECUTOR_MODEL, effort: EXECUTOR_REASONING_EFFORT },
    })}\n`,
  );
  const routing = await verifySessionRouting(
    validThreadId,
    EXECUTOR_MODEL,
    EXECUTOR_REASONING_EFFORT,
    { sessionRoots: [join(temporaryRoot, "sessions")], attempts: 1 },
  );
  assert.equal(routing.model, EXECUTOR_MODEL);
  assert.equal(routing.reasoningEffort, EXECUTOR_REASONING_EFFORT);

  const invalidModelThreadId = "invalid-model-thread";
  await writeFile(
    join(sessionsRoot, `rollout-${invalidModelThreadId}.jsonl`),
    `${JSON.stringify({
      type: "turn_context",
      payload: { model: "gpt-5.5", effort: EXECUTOR_REASONING_EFFORT },
    })}\n`,
  );
  await assert.rejects(
    verifySessionRouting(
      invalidModelThreadId,
      EXECUTOR_MODEL,
      EXECUTOR_REASONING_EFFORT,
      { sessionRoots: [join(temporaryRoot, "sessions")], attempts: 1 },
    ),
    RoutingVerificationError,
  );

  const invalidEffortThreadId = "invalid-effort-thread";
  await writeFile(
    join(sessionsRoot, `rollout-${invalidEffortThreadId}.jsonl`),
    `${JSON.stringify({
      type: "turn_context",
      payload: { model: EXECUTOR_MODEL, effort: "xhigh" },
    })}\n`,
  );
  await assert.rejects(
    verifySessionRouting(
      invalidEffortThreadId,
      EXECUTOR_MODEL,
      EXECUTOR_REASONING_EFFORT,
      { sessionRoots: [join(temporaryRoot, "sessions")], attempts: 1 },
    ),
    RoutingVerificationError,
  );
});

test("invokeExecutor returns verified stable JSON and status exit codes", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-sol-invoke-test-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionsRoot = join(temporaryRoot, "sessions");
  await mkdir(sessionsRoot, { recursive: true });

  async function runWithStatus(status) {
    const threadId = `thread-${status}`;
    await writeFile(
      join(sessionsRoot, `rollout-${threadId}.jsonl`),
      `${JSON.stringify({
        type: "turn_context",
        payload: { model: EXECUTOR_MODEL, effort: EXECUTOR_REASONING_EFFORT },
      })}\n`,
    );
    const processRunner = async (_command, args) => {
      const outputPath = args[args.indexOf("-o") + 1];
      await writeFile(
        outputPath,
        JSON.stringify({
          status,
          summary: `Executor ${status}.`,
          changed_files: [],
          checks: [],
          blockers: status === "completed" ? [] : ["Task did not complete."],
          warnings: [],
        }),
      );
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        threadId,
        warnings: [],
        stderr: "",
      };
    };
    return await invokeExecutor({
      briefing: "Complete the bounded test task.",
      options: {
        cwd: temporaryRoot,
        sandboxMode: "read-only",
        timeoutSeconds: 10,
      },
      sessionRoots: [sessionsRoot],
      processRunner,
    });
  }

  const completed = await runWithStatus("completed");
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.result.model, EXECUTOR_MODEL);
  assert.equal(completed.result.reasoning_effort, EXECUTOR_REASONING_EFFORT);
  assert.equal(completed.result.routing_verified, true);

  const blocked = await runWithStatus("blocked");
  assert.equal(blocked.exitCode, 1);
  assert.equal(blocked.result.status, "blocked");
  assert.equal(blocked.result.routing_verified, true);
});

test("invokeExecutor does not claim routing metadata after a Codex process failure", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-sol-process-failure-test-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const execution = await invokeExecutor({
    briefing: "Complete the bounded test task.",
    options: {
      cwd: temporaryRoot,
      sandboxMode: "read-only",
      timeoutSeconds: 10,
    },
    processRunner: async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      aborted: false,
      threadId: null,
      warnings: [],
      stderr: "Codex failed.",
    }),
  });
  assert.equal(execution.exitCode, 1);
  assert.equal(execution.result.model, null);
  assert.equal(execution.result.reasoning_effort, null);
  assert.equal(execution.result.routing_verified, false);
});

test("invokeExecutor returns exit code 2 for a routing mismatch", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-sol-mismatch-test-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionsRoot = join(temporaryRoot, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  const threadId = "mismatched-thread";
  await writeFile(
    join(sessionsRoot, `rollout-${threadId}.jsonl`),
    `${JSON.stringify({
      type: "turn_context",
      payload: { model: "gpt-5.5", effort: EXECUTOR_REASONING_EFFORT },
    })}\n`,
  );
  const execution = await invokeExecutor({
    briefing: "Complete the bounded test task.",
    options: {
      cwd: temporaryRoot,
      sandboxMode: "read-only",
      timeoutSeconds: 10,
    },
    sessionRoots: [sessionsRoot],
    processRunner: async (_command, args) => {
      const outputPath = args[args.indexOf("-o") + 1];
      await writeFile(
        outputPath,
        JSON.stringify({
          status: "completed",
          summary: "Done.",
          changed_files: [],
          checks: [],
          blockers: [],
          warnings: [],
        }),
      );
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        threadId,
        warnings: [],
        stderr: "",
      };
    },
  });
  assert.equal(execution.exitCode, 2);
  assert.equal(execution.result.model, "gpt-5.5");
  assert.equal(execution.result.reasoning_effort, EXECUTOR_REASONING_EFFORT);
  assert.equal(execution.result.routing_verified, false);
});
