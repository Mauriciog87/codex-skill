import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_NAME = "sol-sol-orchestration";
export const LEGACY_SKILL_NAME = "sol-terra-orchestration";
export const MANAGED_BLOCK_START = "<!-- sol-sol-orchestration:start -->";
export const MANAGED_BLOCK_END = "<!-- sol-sol-orchestration:end -->";

const SKILL_DISPLAY_NAME = "Sol-Sol Orchestration";
const LEGACY_SKILL_DISPLAY_NAME = "Sol-Terra Orchestration";
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");

function pathKey(value, platform) {
  const normalized = resolve(value).replace(/^\\\\\?\\/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left, right, platform) {
  return pathKey(left, platform) === pathKey(right, platform);
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

function isTableHeader(line) {
  return /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line);
}

function keyMatcher(key) {
  return new RegExp(`^\\s*${key}\\s*=`);
}

function setTopLevelValues(lines, values) {
  const firstTable = lines.findIndex(isTableHeader);
  const topLevelEnd = firstTable === -1 ? lines.length : firstTable;
  const missing = [];

  for (const [key, value] of Object.entries(values)) {
    const matcher = keyMatcher(key);
    const matches = [];
    for (let index = 0; index < topLevelEnd; index += 1) {
      if (matcher.test(lines[index])) {
        matches.push(index);
      }
    }
    if (matches.length > 1) {
      throw new Error(`Global config contains duplicate top-level ${key} entries.`);
    }
    const replacement = `${key} = ${JSON.stringify(value)}`;
    if (matches.length === 1) {
      lines[matches[0]] = replacement;
    } else {
      missing.push(replacement);
    }
  }

  if (missing.length > 0) {
    let insertion = firstTable === -1 ? lines.length : firstTable;
    while (insertion > 0 && lines[insertion - 1].trim() === "") {
      insertion -= 1;
    }
    lines.splice(insertion, 0, ...missing);
    if (firstTable !== -1) {
      lines.splice(insertion + missing.length, 0, "");
    }
  }
}

function setAgentsValues(lines, values) {
  const sectionHeaders = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*\[agents\]\s*(?:#.*)?$/.test(line));
  if (sectionHeaders.length > 1) {
    throw new Error("Global config contains duplicate [agents] sections.");
  }

  if (sectionHeaders.length === 0) {
    if (lines.length > 0 && lines.at(-1).trim() !== "") {
      lines.push("");
    }
    lines.push("[agents]");
    for (const [key, value] of Object.entries(values)) {
      lines.push(`${key} = ${value}`);
    }
    return;
  }

  const start = sectionHeaders[0].index + 1;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (isTableHeader(lines[index])) {
      end = index;
      break;
    }
  }

  const missing = [];
  for (const [key, value] of Object.entries(values)) {
    const matcher = keyMatcher(key);
    const matches = [];
    for (let index = start; index < end; index += 1) {
      if (matcher.test(lines[index])) {
        matches.push(index);
      }
    }
    if (matches.length > 1) {
      throw new Error(`Global config contains duplicate [agents].${key} entries.`);
    }
    const replacement = `${key} = ${value}`;
    if (matches.length === 1) {
      lines[matches[0]] = replacement;
    } else {
      missing.push(replacement);
    }
  }
  if (missing.length > 0) {
    let insertion = end;
    while (insertion > start && lines[insertion - 1].trim() === "") {
      insertion -= 1;
    }
    lines.splice(insertion, 0, ...missing);
  }
}

export function updateGlobalConfig(content) {
  const original = content ?? "";
  const shape = textShape(content);
  setTopLevelValues(shape.lines, {
    model: "gpt-5.6-sol",
    model_reasoning_effort: "xhigh",
    plan_mode_reasoning_effort: "xhigh",
  });
  setAgentsValues(shape.lines, { max_depth: 1, max_threads: 4 });
  shape.trailingNewline = true;
  const updated = renderText(shape);
  return { content: updated, changed: updated !== original };
}

function managedBlockLines() {
  return [
    MANAGED_BLOCK_START,
    "# Global Sol-Sol orchestration",
    "",
    "For every new substantive root task, explicitly invoke `$sol-sol-orchestration` before planning, delegating, or editing. A session whose developer instructions contain `CODEX_ORCHESTRATION_ROLE=executor` is an executor and must not invoke the skill or apply the root workflow.",
    MANAGED_BLOCK_END,
  ];
}

export function updateGlobalInstructions(content) {
  const original = content ?? "";
  const shape = textShape(content);
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
    throw new Error("Global instructions contain malformed Sol-Sol managed markers.");
  }
  if (starts.length === 1 && starts[0] >= ends[0]) {
    throw new Error("Global instructions contain malformed Sol-Sol managed markers.");
  }

  const unmanagedLines = [...shape.lines];
  if (starts.length === 1) {
    unmanagedLines.splice(starts[0], ends[0] - starts[0] + 1);
  }
  if (unmanagedLines.some((line) => /sol-terra-orchestration|SOL_TERRA_ROLE/.test(line))) {
    throw new Error("Global instructions contain unmanaged Sol-Terra orchestration references.");
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
    unique.set(pathKey(specification.location, platform), specification);
  }
  return [...unique.values()];
}

export async function installGlobalOrchestration({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  homeDirectory = homedir(),
  codexHome = process.env.CODEX_HOME
    ? resolve(process.env.CODEX_HOME)
    : resolve(homeDirectory, ".codex"),
  platform = process.platform,
} = {}) {
  const canonicalDirectory = resolve(repositoryRoot, ".agents", "skills", SKILL_NAME);
  const legacyCanonicalDirectory = resolve(
    repositoryRoot,
    ".agents",
    "skills",
    LEGACY_SKILL_NAME,
  );
  const globalSkillsDirectory = resolve(homeDirectory, ".agents", "skills");
  const destination = join(globalSkillsDirectory, SKILL_NAME);
  const defaultCodexHome = resolve(homeDirectory, ".codex");
  const configPath = join(codexHome, "config.toml");

  await validateSkillIdentity(canonicalDirectory);
  if (samePath(canonicalDirectory, destination, platform)) {
    throw new Error("The canonical and global skill directories must be different paths.");
  }

  const destinationState = await inspectDestination(destination, canonicalDirectory, platform);
  const legacySpecifications = uniqueLegacySpecifications(
    [
      {
        location: join(globalSkillsDirectory, LEGACY_SKILL_NAME),
        expectedTarget: legacyCanonicalDirectory,
        expectedName: LEGACY_SKILL_NAME,
        expectedDisplayName: LEGACY_SKILL_DISPLAY_NAME,
        platform,
      },
      ...[codexHome, defaultCodexHome].flatMap((skillsHome) => [
        {
          location: join(skillsHome, "skills", LEGACY_SKILL_NAME),
          expectedTarget: legacyCanonicalDirectory,
          expectedName: LEGACY_SKILL_NAME,
          expectedDisplayName: LEGACY_SKILL_DISPLAY_NAME,
          platform,
        },
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
  const configUpdate = updateGlobalConfig(originalConfig);
  const globalInstructions = await selectGlobalInstructions(codexHome);
  const instructionsUpdate = updateGlobalInstructions(globalInstructions.content);

  let linkCreated = false;
  let configWritten = false;
  let instructionsWritten = false;
  try {
    await mkdir(globalSkillsDirectory, { recursive: true });
    if (!destinationState.linked) {
      await symlink(
        canonicalDirectory,
        destination,
        platform === "win32" ? "junction" : "dir",
      );
      linkCreated = true;
    }
    if (configUpdate.changed) {
      await atomicWrite(configPath, configUpdate.content);
      configWritten = true;
    }
    if (instructionsUpdate.changed) {
      await atomicWrite(globalInstructions.path, instructionsUpdate.content);
      instructionsWritten = true;
    }
  } catch (error) {
    if (instructionsWritten) {
      await restoreFile(globalInstructions.path, globalInstructions.content);
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
    link_type: platform === "win32" ? "junction" : "symlink",
    already_linked: destinationState.linked,
    global_config: configPath,
    global_instructions: globalInstructions.path,
    configuration_changed: configUpdate.changed,
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
