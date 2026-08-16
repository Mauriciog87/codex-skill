import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { EXECUTOR_PROFILES } from "../.agents/skills/sol-luna-orchestration/scripts/executor-profiles.mjs";
import { SOL_MODEL_VERBOSITY } from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-state.mjs";

const execFileAsync = promisify(execFile);
const migrationFiles = new Set([
  ".agents/skills/sol-luna-orchestration/scripts/orchestration-state.mjs",
  "README.md",
  "scripts/install-global-orchestration.mjs",
  "tests/install-global-orchestration.test.mjs",
  "tests/static-policy.test.mjs",
]);

test("tracked operational files contain only the Sol-Luna architecture", async () => {
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
    ultra: "node .agents/skills/sol-luna-orchestration/scripts/invoke-sol-ultra.mjs",
    "ultra:gate":
      "node .agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs",
    test: "node --test",
    "verify:live": "node scripts/verify-routing.mjs",
  });

  const metadata = await readFile(
    ".agents/skills/sol-luna-orchestration/agents/openai.yaml",
    "utf8",
  );
  assert.match(metadata, /^\s*allow_implicit_invocation: false$/m);
  const config = await readFile(".codex/config.toml", "utf8");
  assert.match(config, /^model = "gpt-5\.6-sol"$/m);
  assert.match(config, /^model_reasoning_effort = "xhigh"$/m);
  assert.match(config, new RegExp(`^model_verbosity = "${SOL_MODEL_VERBOSITY}"$`, "m"));
  assert.match(config, /^service_tier = "default"$/m);
  assert.match(config, /^plan_mode_reasoning_effort = "xhigh"$/m);
  assert.match(config, /^max_threads = 4$/m);
});

test("profile registry and operational guidance stay aligned", async () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(EXECUTOR_PROFILES).map(([name, profile]) => [
        name,
        [profile.model, profile.reasoningEffort, profile.serviceTier, profile.sandboxMode],
      ]),
    ),
    {
      explore: ["gpt-5.6-luna", "max", "fast", "read-only"],
      "implement-lite": ["gpt-5.6-luna", "max", "fast", "workspace-write"],
      playwright: ["gpt-5.6-luna", "max", "standard", "read-only"],
      implement: ["gpt-5.6-sol", "high", "standard", "workspace-write"],
      review: ["gpt-5.6-sol", "high", "standard", "read-only"],
    },
  );

  const launcher = await readFile(
    ".agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs",
    "utf8",
  );
  assert.match(launcher, /--profile/);
  assert.match(launcher, /CODEX_EXECUTOR_PROFILE/);
  assert.match(launcher, /service_tier/);
  assert.match(launcher, /PLAYWRIGHT_MCP_ISOLATED/);
  assert.match(launcher, /playwright_mcp:verified/);
  assert.doesNotMatch(launcher, /"exec"|output-last-message/);
  assert.doesNotMatch(launcher, /EXECUTOR_MODEL|EXECUTOR_REASONING_EFFORT/);

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
  assert.doesNotMatch(appServerClient, /"exec"|--json|output-last-message/);

  const ultraLauncher = await readFile(
    ".agents/skills/sol-luna-orchestration/scripts/invoke-sol-ultra.mjs",
    "utf8",
  );
  assert.match(ultraLauncher, /ULTRA_REASONING_EFFORT/);
  assert.match(ultraLauncher, /ULTRA_SERVICE_TIER/);
  assert.match(ultraLauncher, /--confirm-exclusive-takeover/);
  assert.match(ultraLauncher, /CODEX_ORCHESTRATION_LOCK_ID/);
  assert.doesNotMatch(ultraLauncher, /"exec"|--json|output-last-message/);

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
    assert.match(content, /experimental Codex App Server/);
    assert.match(content, /0\.147\.0/);
    assert.match(content, /thread\/settings\/updated/);
    assert.match(content, /priority/);
    assert.match(content, /default/);
  }
});
