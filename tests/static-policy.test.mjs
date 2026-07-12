import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { EXECUTOR_PROFILES } from "../.agents/skills/sol-sol-orchestration/scripts/executor-profiles.mjs";

const execFileAsync = promisify(execFile);
const migrationFiles = new Set([
  "scripts/install-global-orchestration.mjs",
  "tests/install-global-orchestration.test.mjs",
  "tests/static-policy.test.mjs",
]);

test("tracked operational files contain only the Sol-Sol architecture", async () => {
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
      /gpt-5\.6-terra|invoke-terra|SOL_TERRA|sol-terra-orchestration/,
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
      "node .agents/skills/sol-sol-orchestration/scripts/invoke-sol-executor.mjs",
    ultra: "node .agents/skills/sol-sol-orchestration/scripts/invoke-sol-ultra.mjs",
    "ultra:gate":
      "node .agents/skills/sol-sol-orchestration/scripts/orchestration-gate.mjs",
    test: "node --test",
    "verify:live": "node scripts/verify-routing.mjs",
  });

  const metadata = await readFile(
    ".agents/skills/sol-sol-orchestration/agents/openai.yaml",
    "utf8",
  );
  assert.match(metadata, /^\s*allow_implicit_invocation: false$/m);
  const config = await readFile(".codex/config.toml", "utf8");
  assert.match(config, /^model = "gpt-5\.6-sol"$/m);
  assert.match(config, /^model_reasoning_effort = "xhigh"$/m);
  assert.match(config, /^plan_mode_reasoning_effort = "xhigh"$/m);
});

test("profile registry and operational guidance stay aligned", async () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(EXECUTOR_PROFILES).map(([name, profile]) => [
        name,
        [profile.reasoningEffort, profile.sandboxMode],
      ]),
    ),
    {
      explore: ["medium", "read-only"],
      implement: ["high", "workspace-write"],
      review: ["high", "read-only"],
    },
  );

  const launcher = await readFile(
    ".agents/skills/sol-sol-orchestration/scripts/invoke-sol-executor.mjs",
    "utf8",
  );
  assert.match(launcher, /--profile/);
  assert.match(launcher, /CODEX_EXECUTOR_PROFILE/);
  assert.doesNotMatch(launcher, /EXECUTOR_REASONING_EFFORT/);
  const registry = await readFile(
    ".agents/skills/sol-sol-orchestration/scripts/executor-profiles.mjs",
    "utf8",
  );
  assert.doesNotMatch(registry, /ultra/);

  const ultraLauncher = await readFile(
    ".agents/skills/sol-sol-orchestration/scripts/invoke-sol-ultra.mjs",
    "utf8",
  );
  assert.match(ultraLauncher, /ULTRA_REASONING_EFFORT/);
  assert.match(ultraLauncher, /--confirm-exclusive-takeover/);
  assert.match(ultraLauncher, /features\.multi_agent=false/);
  assert.match(ultraLauncher, /CODEX_ORCHESTRATION_LOCK_ID/);

  for (const path of [
    "AGENTS.md",
    "README.md",
    ".agents/skills/sol-sol-orchestration/SKILL.md",
  ]) {
    const content = await readFile(path, "utf8");
    assert.match(content, /explore/);
    assert.match(content, /implement/);
    assert.match(content, /review/);
    assert.match(content, /medium/);
    assert.match(content, /high/);
    assert.match(content, /xhigh/);
    assert.match(content, /ultra/i);
    assert.match(content, /recovery-required/);
  }
});
