import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LEGACY_SKILL_NAME,
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
  MANAGED_HOOKS_END,
  MANAGED_HOOKS_START,
  SKILL_NAME,
  TERRA_LEGACY_SKILL_NAME,
  canonicalPathKey,
  getSkillLinkType,
  installGlobalOrchestration,
  updateGlobalConfig,
  updateGlobalInstructions,
} from "../scripts/install-global-orchestration.mjs";

const NEW_DISPLAY_NAME = "Sol-Luna Orchestration";
const LEGACY_DISPLAY_NAME = "Sol-Sol Orchestration";
const TERRA_LEGACY_DISPLAY_NAME = "Sol-Terra Orchestration";

test("skill link selection is explicit for every supported platform", () => {
  assert.equal(getSkillLinkType("win32"), "junction");
  assert.equal(getSkillLinkType("linux"), "symlink");
  assert.equal(getSkillLinkType("darwin"), "symlink");
  assert.throws(() => getSkillLinkType("freebsd"), /Unsupported platform/);
});

test("canonical path comparison normalizes Windows casing only", () => {
  assert.equal(
    canonicalPathKey("C:\\Users\\MAURI\\Repo", "win32"),
    canonicalPathKey("c:\\users\\mauri\\repo", "win32"),
  );
  assert.notEqual(
    canonicalPathKey("/Users/Mauri/Repo", "darwin"),
    canonicalPathKey("/Users/mauri/repo", "darwin"),
  );
  assert.notEqual(
    canonicalPathKey("/home/Mauri/Repo", "linux"),
    canonicalPathKey("/home/mauri/repo", "linux"),
  );
});

async function createSkill(
  skillDirectory,
  { name = SKILL_NAME, displayName = NEW_DISPLAY_NAME } = {},
) {
  await mkdir(join(skillDirectory, "agents"), { recursive: true });
  await mkdir(join(skillDirectory, "scripts"), { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill.\n---\n\n# Test\n`,
  );
  await writeFile(
    join(skillDirectory, "agents", "openai.yaml"),
    `interface:\n  display_name: ${JSON.stringify(displayName)}\n`,
  );
  await writeFile(join(skillDirectory, "scripts", "orchestration-gate.mjs"), "export {};\n");
}

async function createFixture(context, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, "repository");
  const homeDirectory = join(root, "home");
  const codexHome = join(homeDirectory, ".codex");
  const canonicalSkill = join(repositoryRoot, ".agents", "skills", SKILL_NAME);
  const configPath = join(codexHome, "config.toml");
  const deliveryConfigPath = join(codexHome, "sol-luna-orchestration", "config.json");
  const agentsPath = join(codexHome, "AGENTS.md");
  const hooksPath = join(codexHome, "hooks.json");
  await createSkill(canonicalSkill);
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    configPath,
    [
      'model = "gpt-5.6-terra"',
      'model_reasoning_effort = "ultra"',
      'model_verbosity = "high"',
      'plan_mode_reasoning_effort = "xhigh"',
      "",
      "[features]",
      "hooks = true",
      "codex_hooks = true",
      "",
    ].join("\n"),
  );
  await writeFile(agentsPath, "# Existing global guidance\n\nPreserve this text.\n");
  await writeFile(hooksPath, '{\r\n  "context-mode": true\r\n}\r\n');
  return {
    root,
    repositoryRoot,
    homeDirectory,
    codexHome,
    canonicalSkill,
    configPath,
    deliveryConfigPath,
    agentsPath,
    hooksPath,
  };
}

test("updateGlobalConfig preserves unrelated values and is idempotent", () => {
  const original = [
    'model = "gpt-5.6-terra"',
    'model_reasoning_effort = "ultra"',
    'model_verbosity = "high"',
    "",
    "[features]",
    "hooks = true",
    "codex_hooks = true",
    "",
  ].join("\r\n");
  const first = updateGlobalConfig(original);
  assert.equal(first.changed, true);
  assert.match(first.content, /^model = "gpt-5\.6-sol"\r$/m);
  assert.match(first.content, /^model_reasoning_effort = "xhigh"\r$/m);
  assert.match(first.content, /^model_verbosity = "low"\r$/m);
  assert.match(first.content, /^service_tier = "default"\r$/m);
  assert.match(first.content, /^plan_mode_reasoning_effort = "xhigh"\r$/m);
  assert.match(first.content, /^\[agents\]\r$/m);
  assert.match(first.content, /^max_depth = 1\r$/m);
  assert.match(first.content, /^max_threads = 4\r$/m);
  assert.match(first.content, /^codex_hooks = true\r$/m);
  assert.match(first.content, /^fast_mode = false\r$/m);
  assert.equal(updateGlobalConfig(first.content).changed, false);
  assert.throws(
    () => updateGlobalConfig('model = "one"\nmodel = "two"\n'),
    /duplicate top-level model/,
  );
});

test("updateGlobalConfig manages hooks without replacing unrelated hook sources", () => {
  const hookScriptPath = join("C:\\global-skill", "scripts", "orchestration-gate.mjs");
  const original = [
    "[features]",
    "codex_hooks = true",
    "",
    "[[hooks.PostToolUse]]",
    'matcher = "Bash"',
    "",
  ].join("\n");
  const first = updateGlobalConfig(original, { hookScriptPath });
  assert.match(first.content, /^hooks = true$/m);
  assert.match(first.content, /^fast_mode = false$/m);
  assert.match(first.content, new RegExp(MANAGED_HOOKS_START));
  assert.match(first.content, new RegExp(MANAGED_HOOKS_END));
  assert.match(first.content, /^\[\[hooks\.SessionStart\]\]$/m);
  assert.match(first.content, /^\[\[hooks\.PreToolUse\]\]$/m);
  assert.match(first.content, /^\[\[hooks\.PostToolUse\]\]$/m);
  assert.match(first.content, /orchestration-gate\.mjs/);
  assert.equal(updateGlobalConfig(first.content, { hookScriptPath }).changed, false);
  assert.throws(
    () => updateGlobalConfig(`${MANAGED_HOOKS_START}\n`, { hookScriptPath }),
    /malformed Sol-Luna hook markers/,
  );
});

test("updateGlobalInstructions manages one exact block and rejects conflicts", () => {
  const first = updateGlobalInstructions("# Existing\n");
  assert.equal(first.changed, true);
  assert.match(first.content, new RegExp(MANAGED_BLOCK_START));
  assert.match(first.content, new RegExp(MANAGED_BLOCK_END));
  assert.match(first.content, /\$sol-luna-orchestration/);
  assert.equal(updateGlobalInstructions(first.content).changed, false);
  assert.throws(
    () => updateGlobalInstructions(`${MANAGED_BLOCK_START}\nmissing end\n`),
    /malformed/,
  );
  assert.throws(
    () => updateGlobalInstructions("Use $sol-terra-orchestration globally.\n"),
    /unmanaged legacy orchestration/,
  );
  const migrated = updateGlobalInstructions(
    "<!-- sol-sol-orchestration:start -->\nold block\n<!-- sol-sol-orchestration:end -->\n",
  );
  assert.match(migrated.content, new RegExp(MANAGED_BLOCK_START));
  assert.doesNotMatch(migrated.content, /<!-- sol-sol-orchestration:start -->/);
});

test("installGlobalOrchestration is idempotent and removes a validated legacy copy", async (context) => {
  const fixture = await createFixture(context, "sol-sol-install-success-");
  const legacySkill = join(fixture.codexHome, "skills", LEGACY_SKILL_NAME);
  await createSkill(legacySkill, {
    name: LEGACY_SKILL_NAME,
    displayName: LEGACY_DISPLAY_NAME,
  });
  const terraLegacySkill = join(fixture.codexHome, "skills", TERRA_LEGACY_SKILL_NAME);
  await createSkill(terraLegacySkill, {
    name: TERRA_LEGACY_SKILL_NAME,
    displayName: TERRA_LEGACY_DISPLAY_NAME,
  });

  const first = await installGlobalOrchestration({
    repositoryRoot: fixture.repositoryRoot,
    homeDirectory: fixture.homeDirectory,
    codexHome: fixture.codexHome,
  });
  assert.equal(first.already_linked, false);
  assert.equal(first.configuration_changed, true);
  assert.equal(first.delivery_configuration_changed, true);
  assert.equal(first.instructions_changed, true);
  assert.deepEqual(first.legacy_removed, [legacySkill, terraLegacySkill]);
  assert.equal(await realpath(first.global_skill), await realpath(fixture.canonicalSkill));
  await assert.rejects(lstat(legacySkill), { code: "ENOENT" });
  await assert.rejects(lstat(terraLegacySkill), { code: "ENOENT" });
  assert.match(await readFile(fixture.configPath, "utf8"), /^model = "gpt-5\.6-sol"$/m);
  assert.match(await readFile(fixture.configPath, "utf8"), /^model_verbosity = "low"$/m);
  assert.match(await readFile(fixture.configPath, "utf8"), /^codex_hooks = true$/m);
  assert.match(await readFile(fixture.configPath, "utf8"), /^\[\[hooks\.PreToolUse\]\]$/m);
  assert.equal(
    await readFile(fixture.deliveryConfigPath, "utf8"),
    '{\n  "automatic_delivery": true\n}\n',
  );
  assert.match(await readFile(fixture.agentsPath, "utf8"), /Preserve this text/);
  assert.equal(
    await readFile(fixture.hooksPath, "utf8"),
    '{\r\n  "context-mode": true\r\n}\r\n',
  );

  await writeFile(fixture.deliveryConfigPath, '{"automatic_delivery":false}\n');
  const second = await installGlobalOrchestration({
    repositoryRoot: fixture.repositoryRoot,
    homeDirectory: fixture.homeDirectory,
    codexHome: fixture.codexHome,
  });
  assert.equal(second.already_linked, true);
  assert.equal(second.configuration_changed, false);
  assert.equal(second.delivery_configuration_changed, false);
  assert.equal(second.instructions_changed, false);
  assert.deepEqual(second.legacy_removed, []);
  assert.equal(
    await readFile(fixture.deliveryConfigPath, "utf8"),
    '{"automatic_delivery":false}\n',
  );
});

test("installGlobalOrchestration rejects an invalid delivery configuration before changing files", async (context) => {
  const fixture = await createFixture(context, "sol-luna-install-delivery-config-");
  const originalConfig = await readFile(fixture.configPath, "utf8");
  const originalAgents = await readFile(fixture.agentsPath, "utf8");
  await mkdir(join(fixture.codexHome, "sol-luna-orchestration"), { recursive: true });
  await writeFile(fixture.deliveryConfigPath, '{"automatic_delivery":"yes"}\n');

  await assert.rejects(
    installGlobalOrchestration({
      repositoryRoot: fixture.repositoryRoot,
      homeDirectory: fixture.homeDirectory,
      codexHome: fixture.codexHome,
    }),
    /automatic_delivery must be true or false/,
  );
  await assert.rejects(
    lstat(join(fixture.homeDirectory, ".agents", "skills", SKILL_NAME)),
    { code: "ENOENT" },
  );
  assert.equal(await readFile(fixture.configPath, "utf8"), originalConfig);
  assert.equal(await readFile(fixture.agentsPath, "utf8"), originalAgents);
});

test("installGlobalOrchestration rejects damaged hook markers without partial changes", async (context) => {
  const fixture = await createFixture(context, "sol-sol-install-hook-conflict-");
  const originalAgents = await readFile(fixture.agentsPath, "utf8");
  const originalHooks = await readFile(fixture.hooksPath, "utf8");
  await writeFile(fixture.configPath, `${MANAGED_HOOKS_END}\n`);

  await assert.rejects(
    installGlobalOrchestration({
      repositoryRoot: fixture.repositoryRoot,
      homeDirectory: fixture.homeDirectory,
      codexHome: fixture.codexHome,
    }),
    /malformed Sol-Luna hook markers/,
  );
  await assert.rejects(
    lstat(join(fixture.homeDirectory, ".agents", "skills", SKILL_NAME)),
    { code: "ENOENT" },
  );
  assert.equal(await readFile(fixture.configPath, "utf8"), `${MANAGED_HOOKS_END}\n`);
  assert.equal(await readFile(fixture.agentsPath, "utf8"), originalAgents);
  assert.equal(await readFile(fixture.hooksPath, "utf8"), originalHooks);
});

test("installGlobalOrchestration updates a nonempty AGENTS.override.md", async (context) => {
  const fixture = await createFixture(context, "sol-sol-install-override-");
  const overridePath = join(fixture.codexHome, "AGENTS.override.md");
  const originalAgents = await readFile(fixture.agentsPath, "utf8");
  await writeFile(overridePath, "# Active override\n");

  const result = await installGlobalOrchestration({
    repositoryRoot: fixture.repositoryRoot,
    homeDirectory: fixture.homeDirectory,
    codexHome: fixture.codexHome,
  });
  assert.equal(result.global_instructions, overridePath);
  assert.match(await readFile(overridePath, "utf8"), /\$sol-luna-orchestration/);
  assert.equal(await readFile(fixture.agentsPath, "utf8"), originalAgents);
});

test("installGlobalOrchestration removes a verified dangling legacy link", async (context) => {
  const fixture = await createFixture(context, "sol-sol-install-dangling-");
  const legacyCanonical = join(
    fixture.repositoryRoot,
    ".agents",
    "skills",
    LEGACY_SKILL_NAME,
  );
  const legacyLink = join(
    fixture.homeDirectory,
    ".agents",
    "skills",
    LEGACY_SKILL_NAME,
  );
  await createSkill(legacyCanonical, {
    name: LEGACY_SKILL_NAME,
    displayName: LEGACY_DISPLAY_NAME,
  });
  await mkdir(join(fixture.homeDirectory, ".agents", "skills"), { recursive: true });
  await symlink(
    legacyCanonical,
    legacyLink,
    process.platform === "win32" ? "junction" : "dir",
  );
  await rm(legacyCanonical, { recursive: true, force: true });

  const result = await installGlobalOrchestration({
    repositoryRoot: fixture.repositoryRoot,
    homeDirectory: fixture.homeDirectory,
    codexHome: fixture.codexHome,
  });
  assert.deepEqual(result.legacy_removed, [legacyLink]);
  await assert.rejects(lstat(legacyLink), { code: "ENOENT" });
});

test("installGlobalOrchestration fails before changing unrelated destinations", async (context) => {
  const fixture = await createFixture(context, "sol-sol-install-conflict-");
  const destination = join(fixture.homeDirectory, ".agents", "skills", SKILL_NAME);
  await mkdir(destination, { recursive: true });
  const marker = join(destination, "unrelated.txt");
  await writeFile(marker, "preserve");
  const originalConfig = await readFile(fixture.configPath, "utf8");
  const originalAgents = await readFile(fixture.agentsPath, "utf8");

  await assert.rejects(
    installGlobalOrchestration({
      repositoryRoot: fixture.repositoryRoot,
      homeDirectory: fixture.homeDirectory,
      codexHome: fixture.codexHome,
    }),
    /not a link/,
  );
  assert.equal(await readFile(marker, "utf8"), "preserve");
  assert.equal(await readFile(fixture.configPath, "utf8"), originalConfig);
  assert.equal(await readFile(fixture.agentsPath, "utf8"), originalAgents);
});

test("installGlobalOrchestration preserves an unverified legacy directory", async (context) => {
  const fixture = await createFixture(context, "sol-sol-install-legacy-conflict-");
  const legacySkill = join(
    fixture.homeDirectory,
    ".agents",
    "skills",
    LEGACY_SKILL_NAME,
  );
  await createSkill(legacySkill, {
    name: "unrelated-skill",
    displayName: LEGACY_DISPLAY_NAME,
  });
  const originalConfig = await readFile(fixture.configPath, "utf8");
  const originalAgents = await readFile(fixture.agentsPath, "utf8");

  await assert.rejects(
    installGlobalOrchestration({
      repositoryRoot: fixture.repositoryRoot,
      homeDirectory: fixture.homeDirectory,
      codexHome: fixture.codexHome,
    }),
    /identity mismatch/,
  );
  assert.equal((await lstat(legacySkill)).isDirectory(), true);
  assert.equal(await readFile(fixture.configPath, "utf8"), originalConfig);
  assert.equal(await readFile(fixture.agentsPath, "utf8"), originalAgents);
  await assert.rejects(
    lstat(join(fixture.homeDirectory, ".agents", "skills", SKILL_NAME)),
    { code: "ENOENT" },
  );
});
