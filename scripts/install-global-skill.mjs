import { lstat, mkdir, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_NAME = "sol-terra-orchestration";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");

function pathKey(value, platform) {
  const normalized = resolve(value);
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

function readFrontmatterName(content) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const name = frontmatter?.[1].match(/^name:\s*["']?([^"'\r\n]+)["']?\s*$/m);
  return name?.[1].trim() ?? null;
}

export async function validateSkillIdentity(skillDirectory) {
  const directory = await stat(skillDirectory);
  if (!directory.isDirectory()) {
    throw new Error(`Skill path is not a directory: ${skillDirectory}`);
  }

  const skillContent = await readFile(join(skillDirectory, "SKILL.md"), "utf8");
  const skillName = readFrontmatterName(skillContent);
  if (skillName !== SKILL_NAME) {
    throw new Error(
      `Skill identity mismatch at ${skillDirectory}: expected ${SKILL_NAME}, found ${skillName ?? "none"}.`,
    );
  }

  const metadata = await readFile(join(skillDirectory, "agents", "openai.yaml"), "utf8");
  if (!metadata.includes('display_name: "Sol-Terra Orchestration"')) {
    throw new Error(`Skill metadata identity mismatch at ${skillDirectory}.`);
  }
}

async function inspectDestination(destination, canonicalDirectory, platform) {
  const entry = await getEntry(destination);
  if (entry === null) {
    return { exists: false, linked: false };
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
  return { exists: true, linked: true };
}

export async function installGlobalSkill({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  homeDirectory = homedir(),
  platform = process.platform,
} = {}) {
  const canonicalDirectory = resolve(
    repositoryRoot,
    ".agents",
    "skills",
    SKILL_NAME,
  );
  const globalSkillsDirectory = resolve(homeDirectory, ".agents", "skills");
  const destination = join(globalSkillsDirectory, SKILL_NAME);
  const legacyDirectory = resolve(homeDirectory, ".codex", "skills", SKILL_NAME);

  await validateSkillIdentity(canonicalDirectory);
  if (samePath(canonicalDirectory, destination, platform)) {
    throw new Error("The canonical and global skill directories must be different paths.");
  }
  if (samePath(canonicalDirectory, legacyDirectory, platform)) {
    throw new Error("The canonical skill cannot be the legacy global skill directory.");
  }

  const destinationState = await inspectDestination(
    destination,
    canonicalDirectory,
    platform,
  );
  const legacyEntry = await getEntry(legacyDirectory);
  if (legacyEntry !== null) {
    await validateSkillIdentity(legacyDirectory);
  }

  await mkdir(globalSkillsDirectory, { recursive: true });
  if (!destinationState.linked) {
    await symlink(
      canonicalDirectory,
      destination,
      platform === "win32" ? "junction" : "dir",
    );
  }
  if (legacyEntry !== null) {
    await rm(legacyDirectory, { recursive: true, force: false });
  }

  return {
    status: "completed",
    canonical_skill: canonicalDirectory,
    global_skill: destination,
    link_type: platform === "win32" ? "junction" : "symlink",
    already_linked: destinationState.linked,
    legacy_removed: legacyEntry !== null,
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length > 0) {
    process.stderr.write("install-global-skill does not accept arguments.\n");
    return 2;
  }

  try {
    const result = await installGlobalSkill();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
