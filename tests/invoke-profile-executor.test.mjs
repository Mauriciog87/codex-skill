import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  EXECUTOR_PROFILE_NAMES,
  EXECUTOR_PROFILES,
  MODEL_VERBOSITY,
  getExecutorProfile,
} from "../.agents/skills/sol-luna-orchestration/scripts/executor-profiles.mjs";
import {
  DEFAULT_CONTROL_PLANE,
  DEFAULT_RESULT_FORMAT,
  DEFAULT_SANDBOX_MODE,
  DEFAULT_TIMEOUT_SECONDS,
  ExecutorConfigurationError,
  ExecutorInvocationError,
  RoutingVerificationError,
  buildProfileAppServerArguments,
  createExecutorDeveloperInstructions,
  createStableResult,
  determineExitCode,
  invokeExecutor,
  parseArguments,
  runProcess,
  validateExecutorPayload,
  verifyPlaywrightMcp,
  verifySessionRouting,
} from "../.agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs";
import { acquireUltraLock, releaseUltraLock } from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-state.mjs";
import {
  AppServerIdleTimeoutError,
  AppServerProtocolError,
} from "../.agents/skills/sol-luna-orchestration/scripts/codex-app-server-client.mjs";
import { loadExecutorResultContract } from "../.agents/skills/sol-luna-orchestration/scripts/executor-result-contract.mjs";

const OUTPUT_CONTRACT = await loadExecutorResultContract();

function assertPlaywrightRuntimeOverrides(overrides) {
  assert.equal(overrides.length, 4);
  assert.equal(
    overrides[0],
    'mcp_servers.playwright.default_tools_approval_mode="approve"',
  );
  assert.equal(
    overrides[1],
    'mcp_servers.playwright.disabled_tools=["browser_run_code_unsafe"]',
  );
  const outputDirectory = JSON.parse(
    overrides[2].slice("mcp_servers.playwright.cwd=".length),
  );
  assert.equal(
    overrides[2],
    `mcp_servers.playwright.cwd=${JSON.stringify(outputDirectory)}`,
  );
  const prefix = "mcp_servers.playwright.args=";
  assert.ok(overrides[3].startsWith(prefix));
  const runtimeArguments = JSON.parse(overrides[3].slice(prefix.length));
  assert.deepEqual(runtimeArguments.slice(0, 4), [
    "--yes",
    "@playwright/mcp@0.0.80",
    "--isolated",
    "--output-dir",
  ]);
  assert.equal(runtimeArguments[4], outputDirectory);
  assert.ok(resolve(outputDirectory) === outputDirectory);
  return outputDirectory;
}

async function writeRoutingMetadata(
  sessionsRoot,
  threadId,
  effort,
  model = "gpt-5.6-sol",
) {
  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(
    join(sessionsRoot, `rollout-${threadId}.jsonl`),
    `${JSON.stringify({ type: "turn_context", payload: { model, effort } })}\n`,
  );
}

function createAppServerRunner(threadId, payload, overrides = {}) {
  return async (options) => {
    assert.deepEqual(options.outputSchema, OUTPUT_CONTRACT.schema);
    assert.equal(
      createHash("sha256").update(JSON.stringify(options.outputSchema)).digest("hex"),
      OUTPUT_CONTRACT.sha256,
    );
    return {
      threadId,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      serviceTier: options.serviceTier,
      turnStatus: "completed",
      finalResponse: JSON.stringify({ operator_requests: [], ...payload }),
      blockedReason: null,
      warnings: [],
      stderr: "",
      playwrightMcpUsed: true,
      unsafePlaywrightToolUsed: false,
      ...overrides,
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

test("executor profiles define the fixed model, effort, tier, and sandbox matrix", () => {
  assert.deepEqual(EXECUTOR_PROFILE_NAMES, [
    "explore",
    "implement-lite",
    "playwright",
    "implement",
    "review",
  ]);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(EXECUTOR_PROFILES).map(([name, profile]) => [
        name,
        {
          reasoningEffort: profile.reasoningEffort,
          model: profile.model,
          serviceTier: profile.serviceTier,
          sandboxMode: profile.sandboxMode,
          fastMode: profile.fastMode,
        },
      ]),
    ),
    {
      explore: { reasoningEffort: "max", model: "gpt-5.6-luna", serviceTier: "fast", sandboxMode: "read-only", fastMode: true },
      "implement-lite": { reasoningEffort: "max", model: "gpt-5.6-luna", serviceTier: "fast", sandboxMode: "workspace-write", fastMode: true },
      playwright: { reasoningEffort: "max", model: "gpt-5.6-luna", serviceTier: "standard", sandboxMode: "read-only", fastMode: false },
      implement: { reasoningEffort: "high", model: "gpt-5.6-sol", serviceTier: "standard", sandboxMode: "workspace-write", fastMode: false },
      review: { reasoningEffort: "high", model: "gpt-5.6-sol", serviceTier: "standard", sandboxMode: "read-only", fastMode: false },
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
    controlPlane: DEFAULT_CONTROL_PLANE,
    resultFormat: DEFAULT_RESULT_FORMAT,
    assignmentId: null,
    enqueueOnly: false,
    priority: "normal",
    writeRoots: [],
    forbiddenRoots: [],
    requiredChecks: [],
    artifacts: [],
    reviewPolicy: "root",
    operatorApprovalRequired: false,
    allowSymlinks: false,
    allowSubmodules: false,
    candidateId: null,
    deliveryMode: "manual",
    commitMessage: null,
    pushRemote: null,
    pushBranch: null,
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
        "--write-root",
        "src",
      ],
      baseDirectory,
    ),
    {
      profile: "implement",
      cwd: resolve(baseDirectory, "repository"),
      sandboxMode: "workspace-write",
      timeoutSeconds: 42,
      controlPlane: DEFAULT_CONTROL_PLANE,
      resultFormat: DEFAULT_RESULT_FORMAT,
      assignmentId: null,
      enqueueOnly: false,
      priority: "normal",
      writeRoots: ["src"],
      forbiddenRoots: [],
      requiredChecks: [],
      artifacts: [],
      reviewPolicy: "root",
      operatorApprovalRequired: false,
      allowSymlinks: false,
      allowSubmodules: false,
      candidateId: null,
      deliveryMode: "manual",
      commitMessage: null,
      pushRemote: null,
      pushBranch: null,
    },
  );
});

test("parseArguments accepts explicit automatic push delivery", () => {
  const parsed = parseArguments([
    "--profile",
    "implement",
    "--sandbox",
    "workspace-write",
    "--write-root",
    "src",
    "--delivery",
    "push",
    "--commit-message",
    "feat: publish validated candidate",
    "--push-remote",
    "origin",
    "--push-branch",
    "master",
  ]);
  assert.equal(parsed.deliveryMode, "push");
  assert.equal(parsed.commitMessage, "feat: publish validated candidate");
  assert.equal(parsed.pushRemote, "origin");
  assert.equal(parsed.pushBranch, "master");
});

test("parseArguments rejects unsafe, ambiguous, and mismatched invocations", () => {
  for (const args of [
    ["--profile", "unknown"],
    ["--profile", "explore", "--profile", "review"],
    ["--profile", "explore", "--sandbox", "danger-full-access"],
    ["--profile", "explore", "--sandbox", "unsupported"],
    ["--profile", "explore", "--sandbox", "workspace-write"],
    ["--profile", "review", "--sandbox", "workspace-write"],
    ["--profile", "playwright", "--sandbox", "workspace-write"],
    ["--profile", "implement-lite"],
    ["--profile", "implement"],
    ["--profile", "implement", "--sandbox", "workspace-write", "--write-root", "src", "--delivery", "push"],
    ["--profile", "explore", "--delivery", "commit", "--commit-message", "feat: invalid"],
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
    assert.match(instructions, /Do not invoke the sol-luna-orchestration skill/);
  }
  assert.match(createExecutorDeveloperInstructions("explore"), /path:line evidence/);
  assert.match(createExecutorDeveloperInstructions("implement-lite"), /recommend the Sol implement profile/);
  assert.match(createExecutorDeveloperInstructions("playwright"), /browser_run_code_unsafe/);
  assert.match(createExecutorDeveloperInstructions("implement"), /Do not self-approve/);
  assert.match(createExecutorDeveloperInstructions("review"), /REQUEST_CHANGES/);
});

test("buildProfileAppServerArguments pins each selected route without bypass flags", () => {
  const playwrightOutputDirectory = resolve("test-playwright-output");
  for (const profileName of EXECUTOR_PROFILE_NAMES) {
    const profile = EXECUTOR_PROFILES[profileName];
    const args = buildProfileAppServerArguments({
      profile: profileName,
      sandboxMode: profile.sandboxMode,
      playwrightOutputDirectory,
    });
    assert.ok(args.includes(`model_verbosity=${JSON.stringify(MODEL_VERBOSITY)}`));
    assert.ok(args.includes(`service_tier=${JSON.stringify(profile.configuredServiceTier)}`));
    assert.ok(args.includes(`features.fast_mode=${profile.fastMode}`));
    assert.ok(args.includes("features.multi_agent=false"));
    assert.ok(args.includes("agents.max_depth=1"));
    assert.ok(args.includes("agents.max_threads=1"));
    assert.equal(
      args.includes('mcp_servers.playwright.default_tools_approval_mode="approve"'),
      profileName === "playwright",
    );
    assert.equal(
      args.includes('mcp_servers.playwright.disabled_tools=["browser_run_code_unsafe"]'),
      profileName === "playwright",
    );
    assert.equal(
      args.includes(`mcp_servers.playwright.cwd=${JSON.stringify(playwrightOutputDirectory)}`),
      profileName === "playwright",
    );
    assert.equal(
      args.includes(
        `mcp_servers.playwright.args=${JSON.stringify([
          "--yes",
          "@playwright/mcp@0.0.80",
          "--isolated",
          "--output-dir",
          playwrightOutputDirectory,
        ])}`,
      ),
      profileName === "playwright",
    );
    assert.deepEqual(args.slice(-3), ["app-server", "--listen", "stdio://"]);
    assert.equal(args.includes("exec"), false);
    assert.equal(args.includes("--json"), false);
    for (const prohibitedFlag of [
      "--dangerously-bypass-approvals-and-sandbox",
      "--full-auto",
      "--ask-for-approval",
      "-a",
    ]) {
      assert.equal(args.includes(prohibitedFlag), false);
    }
  }
  assert.throws(
    () => buildProfileAppServerArguments({
      profile: "playwright",
      sandboxMode: "read-only",
    }),
    /output directory must be an absolute path/,
  );
});

test("validateExecutorPayload enforces the untrusted structured payload", () => {
  const payload = {
    status: "completed",
    summary: "Completed the bounded task.",
    changed_files: [],
    checks: ["node --test passed"],
    blockers: [],
    warnings: [],
    operator_requests: [],
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
  const missingOperatorRequests = { ...payload };
  delete missingOperatorRequests.operator_requests;
  assert.throws(
    () => validateExecutorPayload(missingOperatorRequests),
    /operator_requests is required/,
  );
});

test("operator requests require a blocked executor result", () => {
  const payload = {
    status: "completed",
    summary: "Done.",
    changed_files: [],
    checks: [],
    blockers: [],
    warnings: [],
    operator_requests: [{ question: "Continue?", choices: ["yes", "no"] }],
  };
  assert.throws(() => validateExecutorPayload(payload), /require status blocked/);
  assert.deepEqual(
    validateExecutorPayload({ ...payload, status: "blocked", blockers: ["operator input"] }).operator_requests,
    payload.operator_requests,
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
    "service_tier",
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
  assert.equal(result.service_tier, null);
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
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-luna-routing-test-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionsRoot = join(temporaryRoot, "sessions");

  for (const [profileName, profile] of Object.entries(EXECUTOR_PROFILES)) {
    const threadId = `valid-${profileName}`;
    await writeRoutingMetadata(
      sessionsRoot,
      threadId,
      profile.reasoningEffort,
      profile.model,
      profile.configuredServiceTier,
    );
    const routing = await verifySessionRouting(
      threadId,
      profile.model,
      profile.reasoningEffort,
      { sessionRoots: [sessionsRoot], attempts: 1 },
    );
    assert.equal(routing.model, profile.model);
    assert.equal(routing.reasoningEffort, profile.reasoningEffort);
  }

  await writeRoutingMetadata(sessionsRoot, "invalid-model", "medium", "gpt-5.5");
  await assert.rejects(
    verifySessionRouting("invalid-model", "gpt-5.6-sol", "medium", {
      sessionRoots: [sessionsRoot],
      attempts: 1,
    }),
    RoutingVerificationError,
  );
  await writeRoutingMetadata(sessionsRoot, "invalid-effort", "xhigh");
  await assert.rejects(
    verifySessionRouting("invalid-effort", "gpt-5.6-sol", "medium", {
      sessionRoots: [sessionsRoot],
      attempts: 1,
    }),
    RoutingVerificationError,
  );
  await assert.rejects(
    verifySessionRouting("missing", "gpt-5.6-sol", "medium", {
      sessionRoots: [sessionsRoot],
      attempts: 1,
    }),
    RoutingVerificationError,
  );
});

test("invokeExecutor rejects an invalid output contract before acquiring a lease", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-luna-contract-preflight-test-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const repository = join(temporaryRoot, "repository");
  const homeDirectory = join(temporaryRoot, "home");
  await mkdir(repository, { recursive: true });
  let appServerStarted = false;
  const execution = await invokeExecutor({
    briefing: "Do not start with an invalid contract.",
    options: profileOptions(repository, "explore"),
    outputContract: {
      ...OUTPUT_CONTRACT,
      sha256: "a".repeat(64),
    },
    coordinationOptions: { homeDirectory },
    appServerRunner: async () => {
      appServerStarted = true;
    },
  });
  assert.equal(execution.exitCode, 2);
  assert.equal(execution.result.routing_verified, false);
  assert.match(execution.result.summary, /schema preflight failed/);
  assert.equal(appServerStarted, false);
  await assert.rejects(access(homeDirectory), { code: "ENOENT" });
});

test("invokeExecutor returns verified profile metadata and status exit codes", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-luna-invoke-test-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionsRoot = join(temporaryRoot, "sessions");

  for (const profileName of EXECUTOR_PROFILE_NAMES) {
    const profile = EXECUTOR_PROFILES[profileName];
    const threadId = `${profileName}-completed`;
    await writeRoutingMetadata(
      sessionsRoot,
      threadId,
      profile.reasoningEffort,
      profile.model,
      profile.configuredServiceTier,
    );
    const changedFiles = ["implement-lite", "implement"].includes(profileName)
      ? ["assigned.mjs"]
      : [];
    const appServerDelegate = createAppServerRunner(threadId, {
      status: "completed",
      summary: profileName === "review"
        ? "APPROVE: Review completed."
        : `${profileName} completed.`,
      changed_files: changedFiles,
      checks: [],
      blockers: [],
      warnings: [],
    });
    const execution = await invokeExecutor({
      briefing: "Complete the bounded test task.",
      options: profileOptions(temporaryRoot, profileName),
      coordinationOptions: { homeDirectory: temporaryRoot },
      sessionRoots: [sessionsRoot],
      playwrightMcpVerifier: async () => ({ enabled: true }),
      appServerRunner: async (appServerOptions) => {
        assert.equal(appServerOptions.idleTimeoutMs, profile.idleTimeoutMs);
        if (profileName === "playwright") {
          assertPlaywrightRuntimeOverrides(appServerOptions.configurationOverrides);
        } else {
          assert.deepEqual(appServerOptions.configurationOverrides, []);
        }
        return appServerDelegate(appServerOptions);
      },
    });
    assert.equal(execution.exitCode, 0);
    assert.equal(execution.result.profile, profileName);
    assert.equal(execution.result.model, profile.model);
    assert.equal(execution.result.reasoning_effort, profile.reasoningEffort);
    assert.equal(execution.result.service_tier, profile.serviceTier);
    assert.equal(execution.result.routing_verified, true);
    assert.deepEqual(execution.result.changed_files, changedFiles);
  }
});

test("review verdicts enforce status, blockers, and exit codes", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-luna-review-test-"));
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
      appServerRunner: createAppServerRunner(threadId, payload),
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
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-luna-read-only-test-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionsRoot = join(temporaryRoot, "sessions");
  const threadId = "explore-reported-change";
  await writeRoutingMetadata(
    sessionsRoot,
    threadId,
    "max",
    "gpt-5.6-luna",
    "fast",
  );
  const execution = await invokeExecutor({
    briefing: "Explore the bounded test target.",
    options: profileOptions(temporaryRoot, "explore"),
    coordinationOptions: { homeDirectory: temporaryRoot },
    sessionRoots: [sessionsRoot],
    appServerRunner: createAppServerRunner(threadId, {
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

test("invokeExecutor preserves profile without claiming routing after App Server failure", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-luna-process-failure-test-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const execution = await invokeExecutor({
    briefing: "Complete the bounded test task.",
    options: profileOptions(temporaryRoot, "explore"),
    coordinationOptions: { homeDirectory: temporaryRoot },
    appServerRunner: async () => {
      throw new AppServerProtocolError("App Server failed.");
    },
  });
  assert.equal(execution.exitCode, 2);
  assert.equal(execution.result.profile, "explore");
  assert.equal(execution.result.model, null);
  assert.equal(execution.result.reasoning_effort, null);
  assert.equal(execution.result.service_tier, null);
  assert.equal(execution.result.routing_verified, false);
});

test("idle timeout reports verified routing only when settings and rollout agree", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-luna-idle-routing-test-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionsRoot = join(temporaryRoot, "sessions");
  const threadId = "idle-timeout-verified";
  await writeRoutingMetadata(sessionsRoot, threadId, "max", "gpt-5.6-luna");

  function idleError(id) {
    return new AppServerIdleTimeoutError(
      "The executor went 120 seconds without reporting progress for the active thread.",
      {
        threadId: id,
        actualModel: "gpt-5.6-luna",
        actualReasoningEffort: "max",
        actualServiceTier: "fast",
        settingsRoutingVerified: true,
      },
    );
  }

  const verified = await invokeExecutor({
    briefing: "Explore the bounded test task.",
    options: profileOptions(temporaryRoot, "explore"),
    coordinationOptions: { homeDirectory: temporaryRoot },
    sessionRoots: [sessionsRoot],
    appServerRunner: async () => {
      throw idleError(threadId);
    },
  });
  assert.equal(verified.exitCode, 2);
  assert.equal(verified.result.status, "failed");
  assert.equal(verified.result.routing_verified, true);
  assert.equal(verified.result.model, "gpt-5.6-luna");
  assert.equal(verified.result.reasoning_effort, "max");
  assert.equal(verified.result.service_tier, "fast");
  assert.match(verified.result.summary, /without reporting progress for the active thread/);

  const mismatchedThreadId = "idle-timeout-mismatched";
  await writeRoutingMetadata(sessionsRoot, mismatchedThreadId, "high", "gpt-5.5");
  const unverified = await invokeExecutor({
    briefing: "Explore the bounded test task.",
    options: profileOptions(temporaryRoot, "explore"),
    coordinationOptions: { homeDirectory: temporaryRoot },
    sessionRoots: [sessionsRoot],
    appServerRunner: async () => {
      throw idleError(mismatchedThreadId);
    },
  });
  assert.equal(unverified.exitCode, 2);
  assert.equal(unverified.result.routing_verified, false);
  assert.equal(unverified.result.model, "gpt-5.5");
  assert.equal(unverified.result.reasoning_effort, "high");
  assert.ok(unverified.result.warnings.some((warning) =>
    warning.startsWith("Could not verify routing from the rollout after the timeout:")));
});

test("declined App Server interaction returns blocked with verified routing", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-luna-blocked-interaction-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionsRoot = join(temporaryRoot, "sessions");
  const threadId = "blocked-interaction";
  await writeRoutingMetadata(sessionsRoot, threadId, "max", "gpt-5.6-luna");
  const execution = await invokeExecutor({
    briefing: "Complete the bounded test task.",
    options: profileOptions(temporaryRoot, "explore"),
    coordinationOptions: { homeDirectory: temporaryRoot },
    sessionRoots: [sessionsRoot],
    appServerRunner: createAppServerRunner(
      threadId,
      null,
      {
        finalResponse: null,
        blockedReason: "Declined App Server approval request.",
        operatorRequests: [
          {
            question: "Continue with the authorized test action?",
            choices: ["Yes"],
            source: "app_server_user_input",
            sensitive: false,
          },
        ],
      },
    ),
  });
  assert.equal(execution.exitCode, 1);
  assert.equal(execution.result.status, "blocked");
  assert.equal(execution.result.routing_verified, true);
  assert.deepEqual(execution.result.blockers, ["Declined App Server approval request."]);
  assert.deepEqual(execution.operatorRequests, [
    {
      question: "Continue with the authorized test action?",
      choices: ["Yes"],
      source: "app_server_user_input",
      sensitive: false,
    },
  ]);
});

test("invokeExecutor returns actual metadata and exit code 2 for routing mismatch", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-luna-mismatch-test-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionsRoot = join(temporaryRoot, "sessions");
  const threadId = "mismatched-thread";
  await writeRoutingMetadata(sessionsRoot, threadId, "high", "gpt-5.5", "default");
  const execution = await invokeExecutor({
    briefing: "Complete the bounded test task.",
    options: profileOptions(temporaryRoot, "explore"),
    coordinationOptions: { homeDirectory: temporaryRoot },
    sessionRoots: [sessionsRoot],
    appServerRunner: createAppServerRunner(threadId, {
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
  assert.equal(execution.result.service_tier, "fast");
  assert.equal(execution.result.routing_verified, false);
});

test("verifyPlaywrightMcp requires an enabled stdio server", async () => {
  const valid = await verifyPlaywrightMcp({
    processRunner: async () => ({
      exitCode: 0,
      timedOut: false,
      aborted: false,
      stdout: JSON.stringify({
        name: "playwright",
        enabled: true,
        transport: {
          type: "stdio",
          command: "npx",
          args: ["--yes", "@playwright/mcp@0.0.80"],
        },
      }),
      stderr: "",
    }),
  });
  assert.equal(valid.enabled, true);
  await assert.rejects(
    verifyPlaywrightMcp({
      processRunner: async () => ({
        exitCode: 0,
        timedOut: false,
        aborted: false,
        stdout: JSON.stringify({ name: "playwright", enabled: false }),
        stderr: "",
      }),
    }),
    ExecutorConfigurationError,
  );
  await assert.rejects(
    verifyPlaywrightMcp({
      processRunner: async () => ({
        exitCode: 0,
        timedOut: false,
        aborted: false,
        stdout: JSON.stringify({
          name: "playwright",
          enabled: true,
          transport: {
            type: "stdio",
            command: "npx",
            args: ["@playwright/mcp@latest"],
          },
        }),
        stderr: "",
      }),
    }),
    /@playwright\/mcp@0\.0\.80/,
  );
});

test("playwright profile verifies MCP use and removes its temporary output", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-luna-playwright-test-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionsRoot = join(temporaryRoot, "sessions");
  const threadId = "playwright-completed";
  await writeRoutingMetadata(
    sessionsRoot,
    threadId,
    "max",
    "gpt-5.6-luna",
    "default",
  );
  let outputDirectory;
  const delegate = createAppServerRunner(threadId, {
    status: "completed",
    summary: "Browser check completed.",
    changed_files: [],
    checks: ["page inspected"],
    blockers: [],
    warnings: [],
  });
  const execution = await invokeExecutor({
    briefing: "Inspect the local test page.",
    options: profileOptions(temporaryRoot, "playwright"),
    coordinationOptions: { homeDirectory: temporaryRoot },
    sessionRoots: [sessionsRoot],
    playwrightMcpVerifier: async () => ({ enabled: true }),
    appServerRunner: async (options) => {
      outputDirectory = assertPlaywrightRuntimeOverrides(options.configurationOverrides);
      assert.equal(Object.hasOwn(options.environment, "PLAYWRIGHT_MCP_OUTPUT_DIR"), false);
      assert.equal(Object.hasOwn(options.environment, "PLAYWRIGHT_MCP_ISOLATED"), false);
      await writeFile(join(outputDirectory, "explicit-screenshot.png"), "artifact");
      return delegate(options);
    },
  });
  assert.equal(execution.exitCode, 0);
  assert.ok(execution.result.checks.includes("playwright_mcp:verified"));
  await assert.rejects(access(outputDirectory), { code: "ENOENT" });
});

test("playwright profile rejects missing or unsafe MCP evidence", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-luna-playwright-evidence-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionsRoot = join(temporaryRoot, "sessions");
  for (const [threadId, processFields, expected] of [
    ["playwright-missing", { playwrightMcpUsed: false }, /did not emit/],
    ["playwright-unsafe", { unsafePlaywrightToolUsed: true }, /browser_run_code_unsafe/],
  ]) {
    await writeRoutingMetadata(
      sessionsRoot,
      threadId,
      "max",
      "gpt-5.6-luna",
      "default",
    );
    const baseRunner = createAppServerRunner(threadId, {
      status: "completed",
      summary: "Browser check completed.",
      changed_files: [],
      checks: [],
      blockers: [],
      warnings: [],
    });
    const execution = await invokeExecutor({
      briefing: "Inspect the local test page.",
      options: profileOptions(temporaryRoot, "playwright"),
      coordinationOptions: { homeDirectory: temporaryRoot },
      sessionRoots: [sessionsRoot],
      playwrightMcpVerifier: async () => ({ enabled: true }),
      appServerRunner: async (...args) => ({ ...(await baseRunner(...args)), ...processFields }),
    });
    assert.equal(execution.exitCode, 2);
    assert.match(execution.result.summary, expected);
  }
});

test("invokeExecutor returns stable exit code 2 while Ultra owns the repository", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sol-luna-locked-executor-test-"));
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
      appServerRunner: async () => {
        throw new Error("App Server runner must not execute while the lock is active.");
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
      generation: lock.generation,
      homeDirectory: temporaryRoot,
    });
  }
});
