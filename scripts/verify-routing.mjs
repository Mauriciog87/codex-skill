import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  EXECUTOR_MODEL,
  EXECUTOR_REASONING_EFFORT,
  getSessionRoots,
  invokeExecutor,
  runProcess,
  verifySessionRouting,
} from "../.agents/skills/sol-sol-orchestration/scripts/invoke-sol-executor.mjs";
import {
  LEGACY_SKILL_NAME,
  SKILL_NAME,
  updateGlobalConfig,
  updateGlobalInstructions,
} from "./install-global-orchestration.mjs";

export const ORCHESTRATOR_MODEL = "gpt-5.6-sol";
export const ORCHESTRATOR_REASONING_EFFORT = "xhigh";

const execFileAsync = promisify(execFile);
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");

async function gitStatus(repositoryRoot) {
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: repositoryRoot,
      windowsHide: true,
      maxBuffer: 1_048_576,
    },
  );
  return stdout;
}

function pathKey(value) {
  const normalized = resolve(value).replace(/^\\\\\?\\/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
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

async function activeGlobalInstructions(codexHome) {
  const overridePath = join(codexHome, "AGENTS.override.md");
  const overrideContent = await readOptional(overridePath);
  if (overrideContent?.trim()) {
    return { path: overridePath, content: overrideContent };
  }
  const agentsPath = join(codexHome, "AGENTS.md");
  return { path: agentsPath, content: await readFile(agentsPath, "utf8") };
}

async function verifySkillDiscovery(repositoryRoot) {
  const homeDirectory = homedir();
  const codexHome = process.env.CODEX_HOME
    ? resolve(process.env.CODEX_HOME)
    : resolve(homeDirectory, ".codex");
  const repositorySkill = join(repositoryRoot, ".agents", "skills", SKILL_NAME);
  const globalSkill = join(homeDirectory, ".agents", "skills", SKILL_NAME);
  const repositoryMetadata = await stat(join(repositorySkill, "SKILL.md"));
  if (!repositoryMetadata.isFile()) {
    throw new Error("The repository skill is not discoverable.");
  }
  const skillContent = await readFile(join(repositorySkill, "SKILL.md"), "utf8");
  if (!skillContent.includes(`name: ${SKILL_NAME}`)) {
    throw new Error("The repository skill identity is invalid.");
  }

  const canonicalTarget = await realpath(repositorySkill);
  const globalTarget = await realpath(globalSkill);
  if (pathKey(canonicalTarget) !== pathKey(globalTarget)) {
    throw new Error("The global skill link does not target the repository skill.");
  }

  const projectConfig = await readFile(join(repositoryRoot, ".codex", "config.toml"), "utf8");
  if (updateGlobalConfig(projectConfig).changed) {
    throw new Error("The repository Codex configuration does not enforce Sol xhigh.");
  }
  const globalConfigPath = join(codexHome, "config.toml");
  const globalConfig = await readFile(globalConfigPath, "utf8");
  if (updateGlobalConfig(globalConfig).changed) {
    throw new Error("The global Codex configuration does not enforce Sol xhigh.");
  }
  const globalInstructions = await activeGlobalInstructions(codexHome);
  if (updateGlobalInstructions(globalInstructions.content).changed) {
    throw new Error("The active global instructions do not contain the managed Sol-Sol block.");
  }

  const legacyPaths = [
    join(homeDirectory, ".agents", "skills", LEGACY_SKILL_NAME),
    join(codexHome, "skills", LEGACY_SKILL_NAME),
    join(codexHome, "skills", SKILL_NAME),
  ];
  for (const legacyPath of legacyPaths) {
    if (await pathExists(legacyPath)) {
      throw new Error(`A legacy skill location remains after installation: ${legacyPath}`);
    }
  }

  return {
    repository: repositorySkill,
    global: globalSkill,
    global_config: globalConfigPath,
    global_instructions: globalInstructions.path,
    same_target: true,
  };
}

function verifyExecutorResultSchema(result) {
  const expectedProperties = [
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
  ];
  const properties = Object.keys(result);
  if (
    properties.length !== expectedProperties.length ||
    expectedProperties.some((property) => !properties.includes(property))
  ) {
    throw new Error("The executor result does not match the stable output contract.");
  }
  if (typeof result.routing_verified !== "boolean") {
    throw new Error("Executor result property routing_verified must be a boolean.");
  }
  for (const property of ["changed_files", "checks", "blockers", "warnings"]) {
    if (
      !Array.isArray(result[property]) ||
      result[property].some((entry) => typeof entry !== "string")
    ) {
      throw new Error(`Executor result property ${property} must be an array of strings.`);
    }
  }
}

async function runGlobalRootProbe(sessionRoots) {
  const temporaryRepository = await mkdtemp(join(tmpdir(), "sol-sol-global-probe-"));
  try {
    await execFileAsync("git", ["init", "--quiet"], {
      cwd: temporaryRepository,
      windowsHide: true,
    });
    const developerInstructions = [
      "CODEX_ORCHESTRATION_PROBE=orchestrator",
      "This session exists only to record global default routing metadata.",
      "Do not invoke skills, delegate, inspect files, modify files, or run tools.",
      "Answer the prompt directly and stop.",
    ].join("\n");
    const rootArguments = [
      "--strict-config",
      "-c",
      "features.multi_agent=false",
      "-c",
      "agents.max_depth=1",
      "-c",
      "agents.max_threads=1",
      "-c",
      `developer_instructions=${JSON.stringify(developerInstructions)}`,
      "-C",
      temporaryRepository,
      "-s",
      "read-only",
      "exec",
      "--json",
      "-",
    ];
    const rootProcess = await runProcess("codex", rootArguments, {
      input: "Reply only with: Sol routing probe completed.\n",
      timeoutMs: 300_000,
      cwd: temporaryRepository,
    });
    if (rootProcess.timedOut || rootProcess.aborted) {
      throw new Error("The Sol routing probe timed out or was interrupted.");
    }
    if (rootProcess.exitCode !== 0) {
      throw new Error(
        rootProcess.stderr || `Sol routing probe exited with ${rootProcess.exitCode}.`,
      );
    }
    if (rootProcess.threadId === null) {
      throw new Error("The Sol routing probe did not emit a thread_id.");
    }
    const routing = await verifySessionRouting(
      rootProcess.threadId,
      ORCHESTRATOR_MODEL,
      ORCHESTRATOR_REASONING_EFFORT,
      { sessionRoots },
    );
    return { threadId: rootProcess.threadId, routing };
  } finally {
    await rm(temporaryRepository, { recursive: true, force: true });
  }
}

async function runExecutorProbe(repositoryRoot, sessionRoots) {
  const packageContent = await readFile(join(repositoryRoot, "package.json"));
  const expectedCheck = `workspace_read_sha256:${createHash("sha256")
    .update(packageContent)
    .digest("hex")}`;
  const executor = await invokeExecutor({
    briefing: [
      "Use a workspace tool to read package.json and compute its SHA-256 without modifying files.",
      "Return status completed, summary Sol executor workspace probe completed, no changed files, exactly one check formatted as workspace_read_sha256:<lowercase hex digest>, and no blockers or warnings.",
    ].join("\n"),
    options: {
      cwd: repositoryRoot,
      sandboxMode: "read-only",
      timeoutSeconds: 300,
    },
    sessionRoots,
  });
  verifyExecutorResultSchema(executor.result);
  if (executor.exitCode !== 0) {
    throw new Error(`The Sol executor probe failed: ${executor.result.summary}`);
  }
  if (
    executor.result.model !== EXECUTOR_MODEL ||
    executor.result.reasoning_effort !== EXECUTOR_REASONING_EFFORT ||
    executor.result.routing_verified !== true
  ) {
    throw new Error("The Sol executor probe returned unexpected routing metadata.");
  }
  if (
    executor.result.changed_files.length !== 0 ||
    executor.result.checks.length !== 1 ||
    executor.result.checks[0] !== expectedCheck
  ) {
    throw new Error("The Sol executor probe did not prove read-only workspace access.");
  }
  return executor.result;
}

export async function verifyRouting(repositoryRoot = REPOSITORY_ROOT) {
  const beforeStatus = await gitStatus(repositoryRoot);
  const skill = await verifySkillDiscovery(repositoryRoot);
  const sessionRoots = getSessionRoots();
  const rootProbe = await runGlobalRootProbe(sessionRoots);
  const executor = await runExecutorProbe(repositoryRoot, sessionRoots);

  const afterStatus = await gitStatus(repositoryRoot);
  if (afterStatus !== beforeStatus) {
    throw new Error("Git status changed during the read-only routing verification.");
  }

  return {
    status: "completed",
    root: {
      thread_id: rootProbe.threadId,
      model: rootProbe.routing.model,
      reasoning_effort: rootProbe.routing.reasoningEffort,
    },
    executor,
    skill,
    git_unchanged: true,
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length > 0) {
    process.stderr.write("verify-routing does not accept arguments.\n");
    return 2;
  }

  try {
    const result = await verifyRouting();
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
