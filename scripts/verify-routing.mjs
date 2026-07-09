import { execFile } from "node:child_process";
import { realpath, readFile, stat } from "node:fs/promises";
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
} from "../.agents/skills/sol-terra-orchestration/scripts/invoke-terra-executor.mjs";

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
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function verifySkillDiscovery(repositoryRoot) {
  const repositorySkill = join(
    repositoryRoot,
    ".agents",
    "skills",
    "sol-terra-orchestration",
  );
  const globalSkill = join(
    process.env.HOME ?? process.env.USERPROFILE,
    ".agents",
    "skills",
    "sol-terra-orchestration",
  );
  const repositoryMetadata = await stat(join(repositorySkill, "SKILL.md"));
  if (!repositoryMetadata.isFile()) {
    throw new Error("The repository skill is not discoverable.");
  }
  const skillContent = await readFile(join(repositorySkill, "SKILL.md"), "utf8");
  if (!skillContent.includes("name: sol-terra-orchestration")) {
    throw new Error("The repository skill identity is invalid.");
  }

  const canonicalTarget = await realpath(repositorySkill);
  const globalTarget = await realpath(globalSkill);
  if (pathKey(canonicalTarget) !== pathKey(globalTarget)) {
    throw new Error("The global skill link does not target the repository skill.");
  }

  return {
    repository: repositorySkill,
    global: globalSkill,
    same_target: true,
  };
}

function verifyExecutorResultSchema(result) {
  const expectedProperties = [
    "status",
    "thread_id",
    "model",
    "reasoning_effort",
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
  for (const property of ["changed_files", "checks", "blockers", "warnings"]) {
    if (!Array.isArray(result[property])) {
      throw new Error(`Executor result property ${property} must be an array.`);
    }
  }
}

export async function verifyRouting(repositoryRoot = REPOSITORY_ROOT) {
  const beforeStatus = await gitStatus(repositoryRoot);
  const skill = await verifySkillDiscovery(repositoryRoot);
  const sessionRoots = getSessionRoots();
  const rootDeveloperInstructions = [
    "SOL_TERRA_ROUTING_PROBE=orchestrator",
    "This session exists only to record root routing metadata.",
    "Do not invoke skills, delegate, inspect files, modify files, or run tools.",
    "Answer the prompt directly and stop.",
  ].join("\n");
  const rootArguments = [
    "-m",
    ORCHESTRATOR_MODEL,
    "-c",
    `model_reasoning_effort=${JSON.stringify(ORCHESTRATOR_REASONING_EFFORT)}`,
    "-c",
    "features.multi_agent=false",
    "-c",
    "agents.max_depth=1",
    "-c",
    "agents.max_threads=1",
    "-c",
    `developer_instructions=${JSON.stringify(rootDeveloperInstructions)}`,
    "-C",
    repositoryRoot,
    "-s",
    "read-only",
    "exec",
    "--json",
    "-",
  ];
  const rootProcess = await runProcess("codex", rootArguments, {
    input: "Reply only with: Sol routing probe completed.\n",
    timeoutMs: 300_000,
    cwd: repositoryRoot,
  });
  if (rootProcess.timedOut || rootProcess.aborted) {
    throw new Error("The Sol routing probe timed out or was interrupted.");
  }
  if (rootProcess.exitCode !== 0) {
    throw new Error(rootProcess.stderr || `Sol routing probe exited with ${rootProcess.exitCode}.`);
  }
  if (rootProcess.threadId === null) {
    throw new Error("The Sol routing probe did not emit a thread_id.");
  }
  const rootRouting = await verifySessionRouting(
    rootProcess.threadId,
    ORCHESTRATOR_MODEL,
    ORCHESTRATOR_REASONING_EFFORT,
    { sessionRoots },
  );

  const executor = await invokeExecutor({
    briefing: [
      "Perform a routing probe without using tools or changing files.",
      "Return status completed, summary Terra routing probe completed, no changed files, one check confirming that no filesystem change was requested, and no blockers or warnings.",
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
    throw new Error(`The Terra routing probe failed: ${executor.result.summary}`);
  }
  if (
    executor.result.model !== EXECUTOR_MODEL ||
    executor.result.reasoning_effort !== EXECUTOR_REASONING_EFFORT
  ) {
    throw new Error("The Terra routing probe returned unexpected routing metadata.");
  }

  const afterStatus = await gitStatus(repositoryRoot);
  if (afterStatus !== beforeStatus) {
    throw new Error("Git status changed during the read-only routing verification.");
  }

  return {
    status: "completed",
    root: {
      thread_id: rootProcess.threadId,
      model: rootRouting.model,
      reasoning_effort: rootRouting.reasoningEffort,
    },
    executor: executor.result,
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
