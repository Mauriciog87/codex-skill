import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  EXECUTOR_PROFILE_NAMES,
  EXECUTOR_PROFILES,
  getExecutorProfile,
} from "../.agents/skills/sol-sol-orchestration/scripts/executor-profiles.mjs";
import {
  DEFAULT_SANDBOX_MODE,
  DEFAULT_TIMEOUT_SECONDS,
  EXECUTOR_MODEL,
  ExecutorConfigurationError,
  ExecutorInvocationError,
  RoutingVerificationError,
  buildCodexArguments,
  createExecutorDeveloperInstructions,
  createStableResult,
  determineExitCode,
  invokeExecutor,
  parseArguments,
  runProcess,
  validateExecutorPayload,
  verifySessionRouting,
} from "../.agents/skills/sol-sol-orchestration/scripts/invoke-sol-executor.mjs";
import {
  acquireUltraLock,
  releaseUltraLock,
} from "../.agents/skills/sol-sol-orchestration/scripts/orchestration-state.mjs";

async function writeRoutingMetadata(
  sessionsRoot,
  threadId,
  effort,
  model = EXECUTOR_MODEL,
) {
  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(
    join(sessionsRoot, `rollout-${threadId}.jsonl`),
    `${JSON.stringify({
      type: "turn_context",
      payload: { model, effort },
    })}\n`,
  );
}

function createProcessRunner(threadId, payload) {
  return async (_command, args) => {
    const outputPath = args[args.indexOf("-o") + 1];
    await writeFile(outputPath, JSON.stringify(payload));
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
}

function profileOptions(cwd, profile) {
  return {
    profile,
    cwd,
    sandboxMode: EXECUTOR_PROFILES[profile].sandboxMode,
    timeoutSeconds: 10,
  };
}

test("executor profiles define the fixed effort and sandbox matrix", () => {
  assert.deepEqual(EXECUTOR_PROFILE_NAMES, ["explore", "implement", "review"]);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(EXECUTOR_PROFILES).map(([name, profile]) => [
        name,
        {
          reasoningEffort: profile.reasoningEffort,
          sandboxMode: profile.sandboxMode,
        },
      ]),
    ),
    {
      explore: { reasoningEffort: "medium", sandboxMode: "read-only" },
      implement: { reasoningEffort: "high", sandboxMode: "workspace-write" },
      review: { reasoningEffort: "high", sandboxMode: "read-only" },
    },
  );
  assert.equal(getExecutorProfile("__proto__"), null);
  assert.equal(getExecutorProfile(null), null);
});

test("parseArguments requires a profile and applies safe defaults", () => {
  const baseDirectory = resolve("fixtures", "repository");
  assert.deepEqual(parseArguments(["--profile", "explore"], baseDirectory), {
    profile: "explore",
    cwd: baseDirectory,
    sandboxMode: DEFAULT_SANDBOX_MODE,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  });
  assert.throws(() => parseArguments([], baseDirectory), ExecutorInvocationError);
});

test("parseArguments accepts supported profile-specific options", () => {
  const baseDirectory = resolve("fixtures");
  assert.deepEqual(
    parseArguments(
      [
        "--profile",
        "implement",
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
      profile: "implement",
      cwd: resolve(baseDirectory, "repository"),
      sandboxMode: "workspace-write",
      timeoutSeconds: 42,
    },
  );
});

test("parseArguments rejects unsafe, ambiguous, and mismatched invocations", () => {
  for (const args of [
    ["--profile", "unknown"],
    ["--profile", "explore", "--profile", "review"],
    ["--profile", "explore", "--sandbox", "danger-full-access"],
    ["--profile", "explore", "--sandbox", "unsupported"],
    ["--profile", "explore", "--sandbox", "workspace-write"],
    ["--profile", "review", "--sandbox", "workspace-write"],
    ["--profile", "implement"],
    ["--profile", "explore", "--timeout-seconds", "0"],
    ["--profile", "explore", "--unknown", "value"],
  ]) {
    assert.throws(() => parseArguments(args), ExecutorInvocationError);
  }
});

test("developer instructions identify the selected bounded profile", () => {
  for (const profileName of EXECUTOR_PROFILE_NAMES) {
    const instructions = createExecutorDeveloperInstructions(profileName);
    const profile = EXECUTOR_PROFILES[profileName];
    assert.match(instructions, /^CODEX_ORCHESTRATION_ROLE=executor$/m);
    assert.match(instructions, new RegExp(`^CODEX_EXECUTOR_PROFILE=${profileName}$`, "m"));
    assert.match(instructions, new RegExp(`${profileName} executor at ${profile.reasoningEffort}`));
    assert.match(instructions, /Do not invoke the sol-sol-orchestration skill/);
  }
  assert.match(createExecutorDeveloperInstructions("explore"), /path:line evidence/);
  assert.match(createExecutorDeveloperInstructions("implement"), /Do not self-approve/);
  assert.match(createExecutorDeveloperInstructions("review"), /REQUEST_CHANGES/);
});

test("buildCodexArguments pins the selected Sol profile without bypass flags", () => {
  for (const profileName of EXECUTOR_PROFILE_NAMES) {
    const profile = EXECUTOR_PROFILES[profileName];
    const args = buildCodexArguments({
      profile: profileName,
      cwd: resolve("repository"),
      sandboxMode: profile.sandboxMode,
      schemaPath: resolve("schema.json"),
      outputPath: resolve("result.json"),
    });
    assert.deepEqual(args.slice(0, 11), [
      "-m",
      EXECUTOR_MODEL,
      "-c",
      `model_reasoning_effort=${JSON.stringify(profile.reasoningEffort)}`,
      "-c",
      "features.multi_agent=false",
      "-c",
      "agents.max_depth=1",
      "-c",
      "agents.max_threads=1",
      "-c",
    ]);
    assert.ok(args.some((entry) => entry.includes(`CODEX_EXECUTOR_PROFILE=${profileName}`)));
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
  }
});

test("validateExecutorPayload enforces the untrusted structured payload", () => {
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
    () => validateExecutorPayload({ ...payload, profile: "explore" }),
    ExecutorConfigurationError,
  );
  assert.throws(
    () => validateExecutorPayload({ ...payload, warnings: "none" }),
    ExecutorConfigurationError,
  );
});

test("createStableResult preserves the public property order and nullable profile", () => {
  const result = createStableResult({
    status: "completed",
    profile: "explore",
    threadId: "thread-id",
    sandboxMode: "read-only",
    summary: "Done.",
  });
  assert.deepEqual(Object.keys(result), [
    "status",
    "profile",
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
  assert.equal(result.profile, "explore");
  assert.equal(result.model, null);
  assert.equal(result.reasoning_effort, null);
  assert.equal(result.routing_verified, false);
  assert.equal(
    createStableResult({ status: "failed", summary: "Invalid invocation." }).profile,
    null,
  );
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

test("verifySessionRouting accepts profile efforts and reports mismatches", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-sol-routing-test-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionsRoot = join(temporaryRoot, "sessions");

  for (const [profileName, profile] of Object.entries(EXECUTOR_PROFILES)) {
    const threadId = `valid-${profileName}`;
    await writeRoutingMetadata(sessionsRoot, threadId, profile.reasoningEffort);
    const routing = await verifySessionRouting(
      threadId,
      EXECUTOR_MODEL,
      profile.reasoningEffort,
      { sessionRoots: [sessionsRoot], attempts: 1 },
    );
    assert.equal(routing.model, EXECUTOR_MODEL);
    assert.equal(routing.reasoningEffort, profile.reasoningEffort);
  }

  await writeRoutingMetadata(sessionsRoot, "invalid-model", "medium", "gpt-5.5");
  await assert.rejects(
    verifySessionRouting("invalid-model", EXECUTOR_MODEL, "medium", {
      sessionRoots: [sessionsRoot],
      attempts: 1,
    }),
    RoutingVerificationError,
  );
  await writeRoutingMetadata(sessionsRoot, "invalid-effort", "xhigh");
  await assert.rejects(
    verifySessionRouting("invalid-effort", EXECUTOR_MODEL, "medium", {
      sessionRoots: [sessionsRoot],
      attempts: 1,
    }),
    RoutingVerificationError,
  );
  await assert.rejects(
    verifySessionRouting("missing", EXECUTOR_MODEL, "medium", {
      sessionRoots: [sessionsRoot],
      attempts: 1,
    }),
    RoutingVerificationError,
  );
});

test("invokeExecutor returns verified profile metadata and status exit codes", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-sol-invoke-test-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionsRoot = join(temporaryRoot, "sessions");

  for (const profileName of ["explore", "implement"]) {
    const profile = EXECUTOR_PROFILES[profileName];
    const threadId = `${profileName}-completed`;
    await writeRoutingMetadata(sessionsRoot, threadId, profile.reasoningEffort);
    const changedFiles = profileName === "implement" ? ["assigned.mjs"] : [];
    const execution = await invokeExecutor({
      briefing: "Complete the bounded test task.",
      options: profileOptions(temporaryRoot, profileName),
      coordinationOptions: { homeDirectory: temporaryRoot },
      sessionRoots: [sessionsRoot],
      processRunner: createProcessRunner(threadId, {
        status: "completed",
        summary: `${profileName} completed.`,
        changed_files: changedFiles,
        checks: [],
        blockers: [],
        warnings: [],
      }),
    });
    assert.equal(execution.exitCode, 0);
    assert.equal(execution.result.profile, profileName);
    assert.equal(execution.result.model, EXECUTOR_MODEL);
    assert.equal(execution.result.reasoning_effort, profile.reasoningEffort);
    assert.equal(execution.result.routing_verified, true);
    assert.deepEqual(execution.result.changed_files, changedFiles);
  }
});

test("review verdicts enforce status, blockers, and exit codes", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-sol-review-test-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionsRoot = join(temporaryRoot, "sessions");
  let sequence = 0;

  async function runReview(payload) {
    sequence += 1;
    const threadId = `review-${sequence}`;
    await writeRoutingMetadata(sessionsRoot, threadId, "high");
    return await invokeExecutor({
      briefing: "Review the explicitly assigned test target.",
      options: profileOptions(temporaryRoot, "review"),
      coordinationOptions: { homeDirectory: temporaryRoot },
      sessionRoots: [sessionsRoot],
      processRunner: createProcessRunner(threadId, payload),
    });
  }

  const approved = await runReview({
    status: "completed",
    summary: "APPROVE: No correction is required.",
    changed_files: [],
    checks: ["git diff inspected"],
    blockers: [],
    warnings: [],
  });
  assert.equal(approved.exitCode, 0);

  const changesRequested = await runReview({
    status: "blocked",
    summary: "REQUEST_CHANGES: A correction is required.",
    changed_files: [],
    checks: ["git diff inspected"],
    blockers: ["Correct the regression."],
    warnings: [],
  });
  assert.equal(changesRequested.exitCode, 1);
  assert.equal(changesRequested.result.status, "blocked");

  const approvedWithDash = await runReview({
    status: "completed",
    summary: "APPROVE — No findings.",
    changed_files: [],
    checks: ["git diff inspected"],
    blockers: [],
    warnings: [],
  });
  assert.equal(approvedWithDash.exitCode, 0);

  const invalid = await runReview({
    status: "completed",
    summary: "Review completed.",
    changed_files: [],
    checks: [],
    blockers: [],
    warnings: [],
  });
  assert.equal(invalid.exitCode, 2);
  assert.match(invalid.result.summary, /Review summary must begin/);

  const failedWithoutVerdict = await runReview({
    status: "failed",
    summary: "The review could not run.",
    changed_files: [],
    checks: [],
    blockers: ["Review failed."],
    warnings: [],
  });
  assert.equal(failedWithoutVerdict.exitCode, 2);
  assert.match(failedWithoutVerdict.result.summary, /Review summary must begin/);
});

test("read-only profiles reject reported file changes", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-sol-read-only-test-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionsRoot = join(temporaryRoot, "sessions");
  const threadId = "explore-reported-change";
  await writeRoutingMetadata(sessionsRoot, threadId, "medium");
  const execution = await invokeExecutor({
    briefing: "Explore the bounded test target.",
    options: profileOptions(temporaryRoot, "explore"),
    coordinationOptions: { homeDirectory: temporaryRoot },
    sessionRoots: [sessionsRoot],
    processRunner: createProcessRunner(threadId, {
      status: "completed",
      summary: "Exploration completed.",
      changed_files: ["unexpected.mjs"],
      checks: [],
      blockers: [],
      warnings: [],
    }),
  });
  assert.equal(execution.exitCode, 2);
  assert.match(execution.result.summary, /empty changed_files/);
});

test("invokeExecutor preserves profile without claiming routing after process failure", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-sol-process-failure-test-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const execution = await invokeExecutor({
    briefing: "Complete the bounded test task.",
    options: profileOptions(temporaryRoot, "explore"),
    coordinationOptions: { homeDirectory: temporaryRoot },
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
  assert.equal(execution.result.profile, "explore");
  assert.equal(execution.result.model, null);
  assert.equal(execution.result.reasoning_effort, null);
  assert.equal(execution.result.routing_verified, false);
});

test("invokeExecutor returns actual metadata and exit code 2 for routing mismatch", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-sol-mismatch-test-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionsRoot = join(temporaryRoot, "sessions");
  const threadId = "mismatched-thread";
  await writeRoutingMetadata(sessionsRoot, threadId, "high", "gpt-5.5");
  const execution = await invokeExecutor({
    briefing: "Complete the bounded test task.",
    options: profileOptions(temporaryRoot, "explore"),
    coordinationOptions: { homeDirectory: temporaryRoot },
    sessionRoots: [sessionsRoot],
    processRunner: createProcessRunner(threadId, {
      status: "completed",
      summary: "Done.",
      changed_files: [],
      checks: [],
      blockers: [],
      warnings: [],
    }),
  });
  assert.equal(execution.exitCode, 2);
  assert.equal(execution.result.profile, "explore");
  assert.equal(execution.result.model, "gpt-5.5");
  assert.equal(execution.result.reasoning_effort, "high");
  assert.equal(execution.result.routing_verified, false);
});

test("invokeExecutor returns stable exit code 2 while Ultra owns the repository", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-sol-locked-executor-test-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const lock = await acquireUltraLock({
    cwd: temporaryRoot,
    reason: "Unit test takeover",
    sandboxMode: "read-only",
    homeDirectory: temporaryRoot,
  });
  try {
    const execution = await invokeExecutor({
      briefing: "This task must not start Codex.",
      options: profileOptions(temporaryRoot, "explore"),
      coordinationOptions: { homeDirectory: temporaryRoot },
      processRunner: async () => {
        throw new Error("Process runner must not execute while the lock is active.");
      },
    });
    assert.equal(execution.exitCode, 2);
    assert.equal(execution.result.status, "failed");
    assert.equal(execution.result.routing_verified, false);
    assert.match(execution.result.summary, /exclusive Sol Ultra takeover/);
  } finally {
    await releaseUltraLock({
      cwd: temporaryRoot,
      lockId: lock.lock_id,
      homeDirectory: temporaryRoot,
    });
  }
});
