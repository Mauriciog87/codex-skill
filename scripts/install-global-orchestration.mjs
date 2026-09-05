import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { setTomlValues, tomlStatements } from "./toml-config.mjs";
import { readCodexConfig } from "../.agents/skills/sol-luna-orchestration/scripts/codex-app-server-client.mjs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getCodexHome,
} from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-state.mjs";
import { ROOT_CONFIG_VALUES } from "../.agents/skills/sol-luna-orchestration/scripts/model-policy.mjs";
import {
  DEFAULT_DELIVERY_CONFIGURATION_CONTENT,
  getDeliveryConfigurationPath,
  parseDeliveryConfiguration,
} from "../.agents/skills/sol-luna-orchestration/scripts/delivery-configuration.mjs";
import {
  PLAYWRIGHT_MCP_ARGUMENTS,
  PLAYWRIGHT_MCP_COMMAND,
} from "../.agents/skills/sol-luna-orchestration/scripts/playwright-mcp-configuration.mjs";

export const SKILL_NAME = "sol-luna-orchestration";
export const LEGACY_SKILL_NAME = "sol-sol-orchestration";
export const TERRA_LEGACY_SKILL_NAME = "sol-terra-orchestration";
export const MANAGED_BLOCK_START = "<!-- sol-luna-orchestration:start -->";
export const MANAGED_BLOCK_END = "<!-- sol-luna-orchestration:end -->";
export const MANAGED_HOOKS_START = "# sol-luna-orchestration:hooks:start";
export const MANAGED_HOOKS_END = "# sol-luna-orchestration:hooks:end";

const SKILL_DISPLAY_NAME = "Astra-Luna Orchestration";
const LEGACY_SKILL_DISPLAY_NAME = "Sol-Sol Orchestration";
const TERRA_LEGACY_SKILL_DISPLAY_NAME = "Sol-Terra Orchestration";
const LEGACY_MANAGED_BLOCK_START = "<!-- sol-sol-orchestration:start -->";
const LEGACY_MANAGED_BLOCK_END = "<!-- sol-sol-orchestration:end -->";
const TERRA_MANAGED_BLOCK_START = "<!-- sol-terra-orchestration:start -->";
const TERRA_MANAGED_BLOCK_END = "<!-- sol-terra-orchestration:end -->";
const LEGACY_MANAGED_HOOKS_START = "# sol-sol-orchestration:hooks:start";
const LEGACY_MANAGED_HOOKS_END = "# sol-sol-orchestration:hooks:end";
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");

export function canonicalPathKey(value, platform = process.platform) {
  const normalized = resolve(value).replace(/^\\\\\?\\/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left, right, platform) {
  return canonicalPathKey(left, platform) === canonicalPathKey(right, platform);
}

export function getSkillLinkType(platform = process.platform) {
  if (platform === "win32") {
    return "junction";
  }
  if (["linux", "darwin"].includes(platform)) {
    return "symlink";
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

async function getEntry(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function readFrontmatterName(content) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const name = frontmatter?.[1].match(/^name:\s*["']?([^"'\r\n]+)["']?\s*$/m);
  return name?.[1].trim() ?? null;
}

export async function validateSkillIdentity(
  skillDirectory,
  { expectedName = SKILL_NAME, expectedDisplayName = SKILL_DISPLAY_NAME } = {},
) {
  const directory = await stat(skillDirectory);
  if (!directory.isDirectory()) {
    throw new Error(`Skill path is not a directory: ${skillDirectory}`);
  }

  const skillContent = await readFile(join(skillDirectory, "SKILL.md"), "utf8");
  const skillName = readFrontmatterName(skillContent);
  if (skillName !== expectedName) {
    throw new Error(
      `Skill identity mismatch at ${skillDirectory}: expected ${expectedName}, found ${skillName ?? "none"}.`,
    );
  }

  const metadata = await readFile(join(skillDirectory, "agents", "openai.yaml"), "utf8");
  if (!metadata.includes(`display_name: ${JSON.stringify(expectedDisplayName)}`)) {
    throw new Error(`Skill metadata identity mismatch at ${skillDirectory}.`);
  }
}

async function inspectDestination(destination, canonicalDirectory, platform) {
  const entry = await getEntry(destination);
  if (entry === null) {
    return { linked: false };
  }
  if (!entry.isSymbolicLink()) {
    throw new Error(`Global skill destination already exists and is not a link: ${destination}`);
  }

  let target;
  try {
    target = await realpath(destination);
  } catch (error) {
    throw new Error(`Global skill link is invalid at ${destination}: ${error.message}`);
  }
  const canonicalTarget = await realpath(canonicalDirectory);
  if (!samePath(target, canonicalTarget, platform)) {
    throw new Error(`Global skill destination points to an unrelated target: ${target}`);
  }
  return { linked: true };
}

async function inspectLegacyLocation({
  location,
  expectedTarget,
  expectedName,
  expectedDisplayName,
  platform,
}) {
  const entry = await getEntry(location);
  if (entry === null) {
    return null;
  }
  if (entry.isSymbolicLink()) {
    const rawTarget = await readlink(location);
    const target = resolve(dirname(location), rawTarget);
    if (!samePath(target, expectedTarget, platform)) {
      throw new Error(`Legacy skill link points to an unrelated target: ${location} -> ${target}`);
    }
    return { location, entry };
  }
  if (!entry.isDirectory()) {
    throw new Error(`Legacy skill location is not a directory or link: ${location}`);
  }
  await validateSkillIdentity(location, { expectedName, expectedDisplayName });
  return { location, entry };
}

function textShape(content) {
  const value = content ?? "";
  const bom = value.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? value.slice(1) : value;
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = content === null || content === "" || /\r?\n$/.test(body);
  const lines = body.length === 0 ? [] : body.split(/\r?\n/);
  if (trailingNewline && lines.at(-1) === "") {
    lines.pop();
  }
  return { bom, lines, newline, trailingNewline };
}

function renderText({ bom, lines, newline, trailingNewline }) {
  const body = lines.join(newline);
  return `${bom}${body}${trailingNewline && body.length > 0 ? newline : ""}`;
}

function setTopLevelValues(lines, values) {
  setTomlValues(lines, "", values);
}

function setAgentsValues(lines, values) {
  setTomlValues(lines, "agents", values);
}

function setFeaturesValues(lines, values) {
  setTomlValues(lines, "features", values);
}

function setPlaywrightMcpValues(lines) {
  setTomlValues(lines, "mcp_servers.playwright", {
    enabled: true,
    command: PLAYWRIGHT_MCP_COMMAND,
    args: PLAYWRIGHT_MCP_ARGUMENTS,
  });
}

function managedHooksLines(hookScriptPath) {
  const command = `node ${JSON.stringify(resolve(hookScriptPath))} hook`;
  const serializedCommand = JSON.stringify(command);
  return [
    MANAGED_HOOKS_START,
    "[[hooks.SessionStart]]",
    'matcher = "startup|resume|clear|compact"',
    "",
    "[[hooks.SessionStart.hooks]]",
    'type = "command"',
    `command = ${serializedCommand}`,
    `command_windows = ${serializedCommand}`,
    "timeout = 10",
    'statusMessage = "Checking exclusive Astra-Luna Ultra state"',
    "",
    "[[hooks.PreToolUse]]",
    'matcher = "^(Bash|Shell|shell|local_shell|shell_command|exec_command|unified_exec|apply_patch|Edit|Write|mcp__.*)$"',
    "",
    "[[hooks.PreToolUse.hooks]]",
    'type = "command"',
    `command = ${serializedCommand}`,
    `command_windows = ${serializedCommand}`,
    "timeout = 10",
    'statusMessage = "Enforcing exclusive Astra-Luna Ultra state"',
    MANAGED_HOOKS_END,
  ];
}

function updateManagedHooks(lines, hookScriptPath) {
  const commentLines = new Set(tomlStatements(lines).filter((entry) => entry.kind === "comment").map((entry) => entry.start));
  for (let index = 0; index < lines.length; index += 1) {
    if (!commentLines.has(index)) continue;
    if (lines[index].trim() === LEGACY_MANAGED_HOOKS_START) {
      lines[index] = MANAGED_HOOKS_START;
    }
    if (lines[index].trim() === LEGACY_MANAGED_HOOKS_END) {
      lines[index] = MANAGED_HOOKS_END;
    }
  }
  const starts = [];
  const ends = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!commentLines.has(index)) continue;
    const line = lines[index].trim();
    if (line === MANAGED_HOOKS_START) {
      starts.push(index);
    }
    if (line === MANAGED_HOOKS_END) {
      ends.push(index);
    }
  }
  if (starts.length !== ends.length || starts.length > 1) {
    throw new Error("Global config contains malformed Astra-Luna hook markers.");
  }
  if (starts.length === 1 && starts[0] >= ends[0]) {
    throw new Error("Global config contains malformed Astra-Luna hook markers.");
  }
  const block = managedHooksLines(hookScriptPath);
  if (starts.length === 1) {
    lines.splice(starts[0], ends[0] - starts[0] + 1, ...block);
    return;
  }
  while (lines.length > 0 && lines.at(-1).trim() === "") {
    lines.pop();
  }
  if (lines.length > 0) {
    lines.push("");
  }
  lines.push(...block);
}

export function updateGlobalConfig(content, { hookScriptPath = null } = {}) {
  const original = content ?? "";
  const shape = textShape(content);
  setTopLevelValues(shape.lines, ROOT_CONFIG_VALUES);
  setAgentsValues(shape.lines, { max_depth: 1, max_threads: 4 });
  setFeaturesValues(shape.lines, { fast_mode: false });
  setPlaywrightMcpValues(shape.lines);
  if (hookScriptPath !== null) {
    setFeaturesValues(shape.lines, { hooks: true });
    updateManagedHooks(shape.lines, hookScriptPath);
  }
  shape.trailingNewline = true;
  const updated = renderText(shape);
  return { content: updated, changed: updated !== original };
}

function managedBlockLines() {
  return [
    MANAGED_BLOCK_START,
    "# Global Astra-Luna orchestration",
    "",
    "For every new substantive root task, explicitly invoke `$sol-luna-orchestration` before planning, delegating, or editing. The root uses Astra/high/Standard. Verified executors use the profile registry; Luna has capacity 10, Astra has capacity 4, and Playwright has a global sublimit of 2. Capacity is not a fan-out target.",
    "",
    "Rebases, merges, cherry-picks, reverts, and conflict resolution stay with the root. Loading the skill does not make delegation mandatory. Check the current checkout, working tree, linked worktrees, upstream, and refs; fetch the latest remote refs; then run the Git operation and work from the conflicts it actually reports. Do not ask `explore` to scan commits and guess what might conflict. After Git stops on a real conflict, `explore` may answer one focused question about those files, once. The root still makes the edit. If that run stalls or fails, do not repeat the same request. Stop and ask the operator when the checkout is dirty, another Git operation is in progress, or the target branch is checked out in another worktree. This does not change who may push or force-push.",
    "",
    "Writer profiles keep `workspace-write` sandboxing and run only in controller-created isolated worktrees with explicit write roots. Results become immutable candidates; root or Ultra owns review, approval, integration, delivery, acknowledgement, and cleanup. New writer assignments use automatic delivery by default: the controller commits only the validated candidate and pushes only to the matching configured upstream branch without force. Set `automatic_delivery` to `false` in the Astra-Luna configuration file to opt out, or use an explicit `--delivery` mode for one assignment. A delivery failure stops in `delivery_blocked` until an explicit retry. Never fall back to a writable shared checkout.",
    "",
    "A human-confirmed Ultra takeover owns its repository exclusively while its lock is active. Other root sessions must pause, and only executors carrying the matching `CODEX_ORCHESTRATION_LOCK_ID` and `CODEX_ORCHESTRATION_GENERATION` may run. Recovery fails closed while a registered process is live or unknown. Never remove lock state manually; inspect history or recover it through the orchestration gate.",
    MANAGED_BLOCK_END,
  ];
}

export function updateGlobalInstructions(content) {
  const original = content ?? "";
  const shape = textShape(content);
  for (let index = 0; index < shape.lines.length; index += 1) {
    if ([LEGACY_MANAGED_BLOCK_START, TERRA_MANAGED_BLOCK_START].includes(shape.lines[index].trim())) {
      shape.lines[index] = MANAGED_BLOCK_START;
    }
    if ([LEGACY_MANAGED_BLOCK_END, TERRA_MANAGED_BLOCK_END].includes(shape.lines[index].trim())) {
      shape.lines[index] = MANAGED_BLOCK_END;
    }
  }
  const starts = [];
  const ends = [];
  for (let index = 0; index < shape.lines.length; index += 1) {
    const line = shape.lines[index].trim();
    if (line === MANAGED_BLOCK_START) {
      starts.push(index);
    }
    if (line === MANAGED_BLOCK_END) {
      ends.push(index);
    }
  }
  if (starts.length !== ends.length || starts.length > 1) {
    throw new Error("Global instructions contain malformed Astra-Luna managed markers.");
  }
  if (starts.length === 1 && starts[0] >= ends[0]) {
    throw new Error("Global instructions contain malformed Astra-Luna managed markers.");
  }

  const unmanagedLines = [...shape.lines];
  if (starts.length === 1) {
    unmanagedLines.splice(starts[0], ends[0] - starts[0] + 1);
  }
  if (unmanagedLines.some((line) => /sol-(?:sol|terra)-orchestration|SOL_TERRA_ROLE/.test(line))) {
    throw new Error("Global instructions contain unmanaged legacy orchestration references.");
  }

  const block = managedBlockLines();
  if (starts.length === 1) {
    shape.lines.splice(starts[0], ends[0] - starts[0] + 1, ...block);
  } else {
    while (shape.lines.length > 0 && shape.lines.at(-1).trim() === "") {
      shape.lines.pop();
    }
    if (shape.lines.length > 0) {
      shape.lines.push("");
    }
    shape.lines.push(...block);
  }
  shape.trailingNewline = true;
  const updated = renderText(shape);
  return { content: updated, changed: updated !== original };
}

async function selectGlobalInstructions(codexHome) {
  const overridePath = join(codexHome, "AGENTS.override.md");
  const overrideContent = await readOptional(overridePath);
  if (overrideContent?.trim()) {
    return { path: overridePath, content: overrideContent };
  }
  const agentsPath = join(codexHome, "AGENTS.md");
  return { path: agentsPath, content: await readOptional(agentsPath) };
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const existing = await getEntry(path);
  const original = existing === null ? null : await readFile(path, "utf8");
  try {
    await writeFile(temporaryPath, content, "utf8");
    if (existing !== null) {
      await chmod(temporaryPath, existing.mode);
    }
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      if (
        process.platform !== "win32" ||
        existing === null ||
        !["EACCES", "EEXIST", "EPERM"].includes(error.code)
      ) {
        throw error;
      }
      try {
        await copyFile(temporaryPath, path);
      } catch (copyError) {
        if (original !== null) {
          await writeFile(path, original, "utf8").catch(() => {});
        }
        throw copyError;
      }
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function restoreFile(path, content) {
  if (content === null) {
    await rm(path, { force: true });
    return;
  }
  await atomicWrite(path, content);
}

function uniqueLegacySpecifications(specifications, platform) {
  const unique = new Map();
  for (const specification of specifications) {
    unique.set(canonicalPathKey(specification.location, platform), specification);
  }
  return [...unique.values()];
}

export async function validateConfigUpdate(original, proposed, configReader = readCodexConfig) {
  const temporary = await mkdtemp(join(tmpdir(), "sol-luna-config-preflight-"));
  const home = join(temporary, "home");
  const codexHome = join(home, ".codex");
  const environment = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome };
  for (const key of Object.keys(environment)) {
    if (/^(OPENAI_API_KEY|CODEX_API_KEY|CODEX_CONFIG.*)$/i.test(key)) delete environment[key];
  }
  try {
    await mkdir(codexHome, { recursive: true });
    for (const [content, verifyManaged] of [[original ?? "", false], [proposed, true]]) {
      await writeFile(join(codexHome, "config.toml"), content, { encoding: "utf8", mode: 0o600 });
      const config = await configReader({ cwd: temporary, environment });
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Codex config/read returned no configuration.");
      if (verifyManaged) {
        const expected = {
          ...ROOT_CONFIG_VALUES,
          "agents.max_depth": 1, "agents.max_threads": 4, "features.fast_mode": false, "features.hooks": true,
          "mcp_servers.playwright.enabled": true, "mcp_servers.playwright.command": PLAYWRIGHT_MCP_COMMAND, "mcp_servers.playwright.args": PLAYWRIGHT_MCP_ARGUMENTS,
        };
        for (const [path, value] of Object.entries(expected)) {
          let actual = path.split(".").reduce((object, key) => object?.[key], config);
          if (path === "agents.max_threads" && actual === undefined) actual = config.agents?.max_concurrent_threads_per_session;
          if (path === "agents.max_threads" && config.agents?.max_concurrent_threads_per_session !== undefined && config.agents.max_concurrent_threads_per_session !== value) {
            throw new Error("Codex config/read returned contradictory agent capacity.");
          }
          if (JSON.stringify(actual) !== JSON.stringify(value)) throw new Error(`Codex config/read did not confirm managed setting ${path}.`);
        }
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function installGlobalOrchestration({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  homeDirectory = homedir(),
  codexHome = getCodexHome(process.env, homeDirectory),
  platform = process.platform,
  configReader = readCodexConfig,
} = {}) {
  const linkType = getSkillLinkType(platform);
  const canonicalDirectory = resolve(repositoryRoot, ".agents", "skills", SKILL_NAME);
  const legacySkills = [
    {
      name: LEGACY_SKILL_NAME,
      displayName: LEGACY_SKILL_DISPLAY_NAME,
      canonicalDirectory: resolve(repositoryRoot, ".agents", "skills", LEGACY_SKILL_NAME),
    },
    {
      name: TERRA_LEGACY_SKILL_NAME,
      displayName: TERRA_LEGACY_SKILL_DISPLAY_NAME,
      canonicalDirectory: resolve(
        repositoryRoot,
        ".agents",
        "skills",
        TERRA_LEGACY_SKILL_NAME,
      ),
    },
  ];
  const globalSkillsDirectory = resolve(homeDirectory, ".agents", "skills");
  const destination = join(globalSkillsDirectory, SKILL_NAME);
  const canonicalHookScript = join(canonicalDirectory, "scripts", "orchestration-gate.mjs");
  const globalHookScript = join(destination, "scripts", "orchestration-gate.mjs");
  const defaultCodexHome = resolve(homeDirectory, ".codex");
  const configPath = join(codexHome, "config.toml");
  const deliveryConfigPath = getDeliveryConfigurationPath({ codexHome });

  await validateSkillIdentity(canonicalDirectory);
  const hookScriptMetadata = await stat(canonicalHookScript);
  if (!hookScriptMetadata.isFile()) {
    throw new Error(`Orchestration hook script is not a file: ${canonicalHookScript}`);
  }
  if (samePath(canonicalDirectory, destination, platform)) {
    throw new Error("The canonical and global skill directories must be different paths.");
  }

  const destinationState = await inspectDestination(destination, canonicalDirectory, platform);
  const legacySpecifications = uniqueLegacySpecifications(
    [
      ...legacySkills.map((legacySkill) => ({
        location: join(globalSkillsDirectory, legacySkill.name),
        expectedTarget: legacySkill.canonicalDirectory,
        expectedName: legacySkill.name,
        expectedDisplayName: legacySkill.displayName,
        platform,
      })),
      ...[codexHome, defaultCodexHome].flatMap((skillsHome) => [
        ...legacySkills.map((legacySkill) => ({
          location: join(skillsHome, "skills", legacySkill.name),
          expectedTarget: legacySkill.canonicalDirectory,
          expectedName: legacySkill.name,
          expectedDisplayName: legacySkill.displayName,
          platform,
        })),
        {
          location: join(skillsHome, "skills", SKILL_NAME),
          expectedTarget: canonicalDirectory,
          expectedName: SKILL_NAME,
          expectedDisplayName: SKILL_DISPLAY_NAME,
          platform,
        },
      ]),
    ],
    platform,
  );
  const legacyEntries = [];
  for (const specification of legacySpecifications) {
    const legacyEntry = await inspectLegacyLocation(specification);
    if (legacyEntry !== null) {
      legacyEntries.push(legacyEntry);
    }
  }

  const originalConfig = await readOptional(configPath);
  const originalDeliveryConfig = await readOptional(deliveryConfigPath);
  if (originalDeliveryConfig !== null) {
    parseDeliveryConfiguration(originalDeliveryConfig, deliveryConfigPath);
  }
  const configUpdate = updateGlobalConfig(originalConfig, { hookScriptPath: globalHookScript });
  const globalInstructions = await selectGlobalInstructions(codexHome);
  const instructionsUpdate = updateGlobalInstructions(globalInstructions.content);
  await validateConfigUpdate(originalConfig, configUpdate.content, configReader);

  let linkCreated = false;
  let configWritten = false;
  let deliveryConfigWritten = false;
  let instructionsWritten = false;
  try {
    await mkdir(globalSkillsDirectory, { recursive: true });
    if (!destinationState.linked) {
      await symlink(
        canonicalDirectory,
        destination,
        linkType === "junction" ? "junction" : "dir",
      );
      linkCreated = true;
    }
    if (configUpdate.changed) {
      await atomicWrite(configPath, configUpdate.content);
      configWritten = true;
    }
    if (originalDeliveryConfig === null) {
      await atomicWrite(deliveryConfigPath, DEFAULT_DELIVERY_CONFIGURATION_CONTENT);
      deliveryConfigWritten = true;
    }
    if (instructionsUpdate.changed) {
      await atomicWrite(globalInstructions.path, instructionsUpdate.content);
      instructionsWritten = true;
    }
  } catch (error) {
    if (instructionsWritten) {
      await restoreFile(globalInstructions.path, globalInstructions.content);
    }
    if (deliveryConfigWritten) {
      await restoreFile(deliveryConfigPath, originalDeliveryConfig);
    }
    if (configWritten) {
      await restoreFile(configPath, originalConfig);
    }
    if (linkCreated) {
      await rm(destination, { recursive: true, force: false });
    }
    throw error;
  }

  const legacyRemoved = [];
  for (const legacyEntry of legacyEntries) {
    await rm(legacyEntry.location, { recursive: true, force: false });
    legacyRemoved.push(legacyEntry.location);
  }

  return {
    status: "completed",
    canonical_skill: canonicalDirectory,
    global_skill: destination,
    link_type: linkType,
    already_linked: destinationState.linked,
    global_config: configPath,
    delivery_config: deliveryConfigPath,
    global_instructions: globalInstructions.path,
    configuration_changed: configUpdate.changed,
    delivery_configuration_changed: deliveryConfigWritten,
    instructions_changed: instructionsUpdate.changed,
    legacy_removed: legacyRemoved,
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length > 0) {
    process.stderr.write("install-global-orchestration does not accept arguments.\n");
    return 2;
  }

  try {
    const result = await installGlobalOrchestration();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "failed", summary: error.message })}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
