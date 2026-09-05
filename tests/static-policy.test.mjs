import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { EXECUTOR_PROFILES } from "../.agents/skills/sol-luna-orchestration/scripts/executor-profiles.mjs";
import { ADVANCED_MODEL, ADVANCED_EXECUTOR_POOL, MODEL_VERBOSITY, ROOT_CONFIG_VALUES, ROOT_POLICY, ULTRA_POLICY } from "../.agents/skills/sol-luna-orchestration/scripts/model-policy.mjs";

const execFileAsync = promisify(execFile);
const migrationFiles = new Set([
  ".agents/skills/sol-luna-orchestration/scripts/orchestration-state.mjs",
  "README.md",
  "scripts/install-global-orchestration.mjs",
  "tests/install-global-orchestration.test.mjs",
  "tests/static-policy.test.mjs",
]);

test("the common policy fixes Astra roles without renaming durable capacity", () => {
  assert.equal(ADVANCED_MODEL, "gpt-6-astra");
  assert.equal(ADVANCED_EXECUTOR_POOL, "sol");
  assert.deepEqual(ROOT_POLICY, { model: "gpt-6-astra", reasoningEffort: "high", serviceTier: "standard", configuredServiceTier: "default", fastMode: false });
  assert.deepEqual(ULTRA_POLICY, { ...ROOT_POLICY, reasoningEffort: "ultra" });
  assert.deepEqual(ROOT_CONFIG_VALUES, { model: "gpt-6-astra", model_reasoning_effort: "high", model_verbosity: "low", service_tier: "default", plan_mode_reasoning_effort: "high" });
  assert.equal(Object.isFrozen(ROOT_POLICY), true);
  assert.equal(Object.isFrozen(ULTRA_POLICY), true);
  assert.equal(Object.isFrozen(ROOT_CONFIG_VALUES), true);
});

test("tracked operational files contain only the Astra-Luna architecture", async () => {
  const { stdout } = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard"], {
    windowsHide: true,
  });
  const paths = stdout
    .split(/\r?\n/)
    .filter((path) => /\.(?:json|md|mjs|toml|yaml)$/.test(path));
  assert.equal(paths.some((path) => path.startsWith(".codex/agents/")), false);
  assert.equal(paths.some((path) => path.endsWith("executor.toml")), false);

  for (const path of paths) {
    if (migrationFiles.has(path)) {
      continue;
    }
    const content = await readFile(path, "utf8");
    if (!path.startsWith("tests/") && path !== "scripts/verify-platform.mjs") {
      assert.doesNotMatch(content, /gpt-5\.6-sol|SOL_MODEL_VERBOSITY/, `Operational Sol routing in ${path}`);
    }
    assert.doesNotMatch(
      content,
      /gpt-5\.6-terra|invoke-terra|SOL_TERRA|sol-terra-orchestration|invoke-sol-executor|sol-sol-orchestration/,
      `Stale orchestration reference in ${path}`,
    );
  }
});

test("package scripts and skill policy expose the supported interfaces", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.private, true);
  assert.deepEqual(packageJson.scripts, {
    "install:global": "node scripts/install-global-orchestration.mjs",
    executor:
      "node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs",
    control:
      "node .agents/skills/sol-luna-orchestration/scripts/orchestration-control.mjs",
    dashboard:
      "node .agents/skills/sol-luna-orchestration/scripts/orchestration-control.mjs dashboard",
    simulate:
      "node .agents/skills/sol-luna-orchestration/scripts/orchestration-simulator.mjs",
    ultra: "node .agents/skills/sol-luna-orchestration/scripts/invoke-sol-ultra.mjs",
    "ultra:gate":
      "node .agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs",
    test: "node --test",
    "verify:platform": "node scripts/verify-platform.mjs",
    "verify:live": "node scripts/verify-routing.mjs",
  });

  const metadata = await readFile(
    ".agents/skills/sol-luna-orchestration/agents/openai.yaml",
    "utf8",
  );
  assert.match(metadata, /^\s*allow_implicit_invocation: false$/m);
  const config = await readFile(".codex/config.toml", "utf8");
  assert.match(config, /^model = "gpt-6-astra"$/m);
  assert.match(config, /^model_reasoning_effort = "high"$/m);
  assert.match(config, new RegExp(`^model_verbosity = "${MODEL_VERBOSITY}"$`, "m"));
  assert.match(config, /^service_tier = "default"$/m);
  assert.match(config, /^plan_mode_reasoning_effort = "high"$/m);
  assert.match(config, /^max_threads = 4$/m);
});

test("profile registry and operational guidance stay aligned", async () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(EXECUTOR_PROFILES).map(([name, profile]) => [
        name,
        [
          profile.model,
          profile.reasoningEffort,
          profile.serviceTier,
          profile.sandboxMode,
          profile.workspaceStrategy,
          profile.capabilities,
          profile.idleTimeoutMs,
        ],
      ]),
    ),
    {
      explore: ["gpt-5.6-luna", "max", "fast", "read-only", "shared-read-only", ["workspace-read", "operator-request"], 120_000],
      "implement-lite": ["gpt-5.6-luna", "max", "fast", "workspace-write", "isolated-worktree", ["workspace-read", "workspace-write", "operator-request"], null],
      playwright: ["gpt-5.6-luna", "max", "standard", "read-only", "shared-read-only", ["workspace-read", "browser", "operator-request"], null],
      implement: ["gpt-6-astra", "medium", "standard", "workspace-write", "isolated-worktree", ["workspace-read", "workspace-write", "operator-request"], null],
      review: ["gpt-6-astra", "high", "standard", "read-only", "candidate-worktree", ["workspace-read", "review"], null],
    },
  );
  assert.match(
    EXECUTOR_PROFILES.explore.instructions.join(" "),
    /Do not scan commit history to guess whether a rebase, merge, cherry-pick, or revert will conflict/,
  );

  const launcher = await readFile(
    ".agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs",
    "utf8",
  );
  assert.match(launcher, /--profile/);
  assert.match(launcher, /CODEX_EXECUTOR_PROFILE/);
  assert.match(launcher, /service_tier/);
  assert.match(launcher, /createPlaywrightMcpRuntimeOverrides/);
  assert.match(launcher, /playwright_mcp:verified/);
  assert.doesNotMatch(launcher, /"exec"|output-last-message/);
  assert.doesNotMatch(launcher, /EXECUTOR_MODEL|EXECUTOR_REASONING_EFFORT/);

  const playwrightConfiguration = await readFile(
    ".agents/skills/sol-luna-orchestration/scripts/playwright-mcp-configuration.mjs",
    "utf8",
  );
  assert.match(playwrightConfiguration, /--isolated/);
  assert.match(playwrightConfiguration, /--output-dir/);
  assert.match(playwrightConfiguration, /default_tools_approval_mode=\"approve\"/);
  assert.match(playwrightConfiguration, /browser_run_code_unsafe/);
  assert.match(playwrightConfiguration, /mcp_servers\.playwright\.cwd/);

  const appServerClient = await readFile(
    ".agents/skills/sol-luna-orchestration/scripts/codex-app-server-client.mjs",
    "utf8",
  );
  assert.match(appServerClient, /app-server/);
  assert.match(appServerClient, /thread\/settings\/update/);
  assert.match(appServerClient, /thread\/settings\/updated/);
  assert.match(appServerClient, /experimentalApi: true/);
  assert.match(appServerClient, /features\.multi_agent=false/);
  assert.match(appServerClient, /agents\.max_depth=1/);
  assert.match(appServerClient, /agents\.max_threads=1/);
  assert.match(appServerClient, /onProcessStarted/);
  assert.match(appServerClient, /AppServerIdleTimeoutError/);
  assert.match(appServerClient, /without reporting progress for the active thread/);
  assert.doesNotMatch(appServerClient, /"exec"|--json|output-last-message/);

  const ultraLauncher = await readFile(
    ".agents/skills/sol-luna-orchestration/scripts/invoke-sol-ultra.mjs",
    "utf8",
  );
  assert.match(ultraLauncher, /ULTRA_REASONING_EFFORT/);
  assert.match(ultraLauncher, /ULTRA_SERVICE_TIER/);
  assert.match(ultraLauncher, /--confirm-exclusive-takeover/);
  assert.match(ultraLauncher, /CODEX_ORCHESTRATION_LOCK_ID/);
  assert.match(ultraLauncher, /CODEX_ORCHESTRATION_GENERATION/);
  assert.doesNotMatch(ultraLauncher, /"exec"|--json|output-last-message/);

  const orchestrationState = await readFile(
    ".agents/skills/sol-luna-orchestration/scripts/orchestration-state.mjs",
    "utf8",
  );
  assert.match(orchestrationState, /ORCHESTRATION_STATE_VERSION = 2/);
  assert.match(orchestrationState, /HISTORY_RETENTION_LIMIT = 1_000/);
  assert.match(orchestrationState, /stale-generation-rejected/);

  const processIdentity = await readFile(
    ".agents/skills/sol-luna-orchestration/scripts/process-identity.mjs",
    "utf8",
  );
  assert.match(processIdentity, /\/proc\/sys\/kernel\/random\/boot_id/);
  assert.match(processIdentity, /Win32_Process/);
  assert.match(processIdentity, /lstart=/);
  assert.doesNotMatch(processIdentity, /shell\s*:\s*true/);

  const gate = await readFile(
    ".agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs",
    "utf8",
  );
  assert.match(gate, /history/);
  assert.match(gate, /--confirm-legacy-recovery/);

  const controlPlane = await readFile(
    ".agents/skills/sol-luna-orchestration/scripts/control-plane.mjs",
    "utf8",
  );
  assert.match(controlPlane, /expected_state_revision/);
  assert.match(controlPlane, /action-id-reuse/);
  assert.match(controlPlane, /resource-capacity/);
  assert.match(controlPlane, /operator_requests require a blocked result/);
  assert.match(controlPlane, /delivery_blocked/);
  assert.match(controlPlane, /record_commit/);
  assert.match(controlPlane, /record_push/);

  const gitWorkspace = await readFile(
    ".agents/skills/sol-luna-orchestration/scripts/git-workspace.mjs",
    "utf8",
  );
  assert.match(gitWorkspace, /worktree.*add/);
  assert.match(gitWorkspace, /candidate-ref-exists/);
  assert.match(gitWorkspace, /integration unexpectedly staged/);
  assert.match(gitWorkspace, /commitIntegratedCandidate/);
  assert.match(gitWorkspace, /pushCommittedCandidate/);
  assert.match(gitWorkspace, /push.*--porcelain/s);
  assert.doesNotMatch(gitWorkspace, /push[^\n]*--force/);
  assert.doesNotMatch(gitWorkspace, /shell\s*:\s*true/);

  const dashboard = await readFile(
    ".agents/skills/sol-luna-orchestration/scripts/orchestration-dashboard.mjs",
    "utf8",
  );
  assert.match(dashboard, /timingSafeEqual/);
  assert.match(dashboard, /X-CSRF-Token/);
  assert.match(dashboard, /Content-Security-Policy/);
  assert.match(dashboard, /Dashboard action is not allowed/);
  assert.match(dashboard, /retry_delivery/);

  const simulator = await readFile(
    ".agents/skills/sol-luna-orchestration/scripts/orchestration-simulator.mjs",
    "utf8",
  );
  assert.match(simulator, /stale-state-revision/);
  assert.match(simulator, /stale-candidate/);

  for (const path of [
    ".agents/skills/sol-luna-orchestration/references/assignment-request.schema.json",
    ".agents/skills/sol-luna-orchestration/references/executor-result.schema.json",
    ".agents/skills/sol-luna-orchestration/references/executor-result-v2.schema.json",
  ]) {
    const schema = JSON.parse(await readFile(path, "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  }
  const assignmentSchema = JSON.parse(await readFile(
    ".agents/skills/sol-luna-orchestration/references/assignment-request.schema.json",
    "utf8",
  ));
  assert.deepEqual(assignmentSchema.properties.delivery.properties.mode.enum, ["manual", "commit", "push"]);

  for (const path of [
    "AGENTS.md",
    "README.md",
    ".agents/skills/sol-luna-orchestration/SKILL.md",
  ]) {
    const content = await readFile(path, "utf8");
    assert.match(content, /explore/);
    assert.match(content, /implement-lite/);
    assert.match(content, /playwright/);
    assert.match(content, /implement/);
    assert.match(content, /review/);
    assert.match(content, /Luna/);
    assert.match(content, /Fast/);
    assert.match(content, /Standard/);
    assert.match(content, /model_verbosity.*low/);
    assert.match(content, /10/);
    assert.match(content, /14/);
    assert.match(content, /recovery-required/);
    assert.match(content, /generation/);
    assert.match(content, /history/);
    assert.match(content, /legacy-unfenced/);
    assert.match(content, /experimental Codex App Server/);
    assert.match(content, /0\.147\.0/);
    assert.match(content, /thread\/settings\/updated/);
    assert.match(content, /priority/);
    assert.match(content, /default/);
    assert.match(content, /worktree/i);
    assert.match(content, /candidate/i);
    assert.match(content, /durable/i);
    assert.match(content, /delivery/i);
    assert.match(content, /force-push|force/i);
    assert.match(content, /Fast path for Git operations/);
    assert.match(content, /Rebases, merges, cherry-picks, reverts/);
    assert.match(content, /guess what might conflict/);
    assert.match(content, /120 seconds to report `item\/\*` progress/);
  }

  const installer = await readFile("scripts/install-global-orchestration.mjs", "utf8");
  assert.match(installer, /Rebases, merges, cherry-picks, reverts/);
  assert.match(installer, /Do not ask `explore` to scan commits/);
});

test("cross-platform workflows keep offline and live verification separated", async () => {
  const offlineWorkflow = await readFile(
    ".github/workflows/cross-platform.yml",
    "utf8",
  );
  for (const value of [
    "pull_request:",
    "push:",
    "workflow_dispatch:",
    "schedule:",
    "windows-latest",
    "ubuntu-latest",
    "macos-latest",
    "node-version: 22",
    "@openai/codex@0.147.0",
    "@openai/codex@latest",
    "npm test",
    "npm run verify:platform",
    "--expected-codex-version 0.147.0",
    "fail-fast: false",
    "continue-on-error: true",
    "contents: read",
  ]) {
    assert.match(offlineWorkflow, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const liveWorkflow = await readFile(
    ".github/workflows/live-cross-platform.yml",
    "utf8",
  );
  for (const value of [
    "workflow_dispatch:",
    "github.ref == 'refs/heads/master'",
    "self-hosted",
    "runner_label: windows",
    "runner_label: linux",
    "runner_label: macOS",
    "codex-live",
    "npm run install:global",
    "npm run verify:platform",
    "npm run verify:live",
    "actions/upload-artifact@v4",
    "orchestration-gate.mjs status",
    "contents: read",
  ]) {
    assert.match(liveWorkflow, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(liveWorkflow, /pull_request:|schedule:|OPENAI_API_KEY|secrets\.|orchestration-gate\.mjs recover/);
});

test("platform smoke and documentation expose the same portability contract", async () => {
  const runner = await readFile("scripts/verify-platform.mjs", "utf8");
  assert.match(runner, /--expected-codex-version/);
  assert.match(runner, /--output/);
  assert.match(runner, /--strict-config/);
  assert.match(runner, /verifyAppServerSchema/);
  assert.match(runner, /installGlobalOrchestration/);
  assert.match(runner, /process_identity:verified/);
  assert.match(runner, /temporary_state:removed/);
  assert.doesNotMatch(runner, /invokeExecutor|invokeUltra|runAppServerTurn|turn\/start/);

  const liveRunner = await readFile("scripts/verify-routing.mjs", "utf8");
  assert.match(liveRunner, /parseVerifyRoutingArguments/);
  assert.match(liveRunner, /codex_version/);
  assert.match(liveRunner, /"generation"/);
  assert.match(liveRunner, /writeJsonOutput/);
  assert.match(liveRunner, /invokeDurableExecutor/);
  assert.match(liveRunner, /integrateCandidate/);
  assert.match(liveRunner, /cleanupAssignmentWorktree/);

  for (const path of [
    "README.md",
    ".agents/skills/sol-luna-orchestration/SKILL.md",
  ]) {
    const content = await readFile(path, "utf8");
    assert.match(content, /verify:platform/);
    assert.match(content, /Windows/);
    assert.match(content, /Linux/);
    assert.match(content, /macOS/);
    assert.match(content, /codex-live/);
    assert.match(content, /Pending|pending/);
  }
});
