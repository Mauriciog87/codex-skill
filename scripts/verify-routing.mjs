import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  EXECUTOR_MODEL,
  getSessionRoots,
  invokeExecutor,
  runProcess,
  verifySessionRouting,
} from "../.agents/skills/sol-sol-orchestration/scripts/invoke-sol-executor.mjs";
import { EXECUTOR_PROFILES } from "../.agents/skills/sol-sol-orchestration/scripts/executor-profiles.mjs";
import {
  invokeUltra,
} from "../.agents/skills/sol-sol-orchestration/scripts/invoke-sol-ultra.mjs";
import {
  acquireUltraLock,
  getOrchestrationStatus,
  releaseUltraLock,
} from "../.agents/skills/sol-sol-orchestration/scripts/orchestration-state.mjs";
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
const ULTRA_LAUNCHER_PATH = join(
  REPOSITORY_ROOT,
  ".agents",
  "skills",
  SKILL_NAME,
  "scripts",
  "invoke-sol-ultra.mjs",
);
const ORCHESTRATION_GATE_PATH = join(
  REPOSITORY_ROOT,
  ".agents",
  "skills",
  SKILL_NAME,
  "scripts",
  "orchestration-gate.mjs",
);

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
  const globalHookScript = join(globalSkill, "scripts", "orchestration-gate.mjs");
  if (updateGlobalConfig(globalConfig, { hookScriptPath: globalHookScript }).changed) {
    throw new Error("The global Codex configuration does not enforce Sol xhigh and hooks.");
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
    global_hooks: join(codexHome, "hooks.json"),
    same_target: true,
  };
}

function verifyExecutorResultSchema(result) {
  const expectedProperties = [
    "status",
    "profile",
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
  if (JSON.stringify(properties) !== JSON.stringify(expectedProperties)) {
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

function verifyUltraResultSchema(result) {
  const expectedProperties = [
    "status",
    "mode",
    "lock_id",
    "thread_id",
    "model",
    "reasoning_effort",
    "routing_verified",
    "sandbox_mode",
    "summary",
    "changed_files",
    "executors",
    "checks",
    "blockers",
    "warnings",
  ];
  if (JSON.stringify(Object.keys(result)) !== JSON.stringify(expectedProperties)) {
    throw new Error("The Ultra result does not match the stable output contract.");
  }
  if (
    result.mode !== "ultra" ||
    typeof result.routing_verified !== "boolean" ||
    !Array.isArray(result.executors)
  ) {
    throw new Error("The Ultra result contains invalid fixed properties.");
  }
  for (const property of ["changed_files", "checks", "blockers", "warnings"]) {
    if (
      !Array.isArray(result[property]) ||
      result[property].some((entry) => typeof entry !== "string")
    ) {
      throw new Error(`Ultra result property ${property} must be an array of strings.`);
    }
  }
}

function verifyUltraRouting(result, sandboxMode) {
  if (
    result.model !== ORCHESTRATOR_MODEL ||
    result.reasoning_effort !== "ultra" ||
    result.routing_verified !== true ||
    result.sandbox_mode !== sandboxMode
  ) {
    throw new Error("The Ultra probe returned unexpected routing metadata.");
  }
}

function verifyProfileRouting(result, profileName) {
  const profile = EXECUTOR_PROFILES[profileName];
  if (
    result.profile !== profileName ||
    result.model !== EXECUTOR_MODEL ||
    result.reasoning_effort !== profile.reasoningEffort ||
    result.routing_verified !== true ||
    result.sandbox_mode !== profile.sandboxMode
  ) {
    throw new Error(`The ${profileName} probe returned unexpected profile or routing metadata.`);
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

async function runExploreProbe(repositoryRoot, sessionRoots) {
  const packageContent = await readFile(join(repositoryRoot, "package.json"));
  const expectedCheck = `workspace_read_sha256:${createHash("sha256")
    .update(packageContent)
    .digest("hex")}`;
  const executor = await invokeExecutor({
    briefing: [
      "Use the local shell tool with its working directory set to the assigned repository to read package.json and compute its SHA-256 without modifying files.",
      "Return status completed, summary Sol explore workspace probe completed, no changed files, exactly one check formatted as workspace_read_sha256:<lowercase hex digest>, and no blockers or warnings.",
    ].join("\n"),
    options: {
      profile: "explore",
      cwd: repositoryRoot,
      sandboxMode: "read-only",
      timeoutSeconds: 300,
    },
    sessionRoots,
  });
  verifyExecutorResultSchema(executor.result);
  if (executor.exitCode !== 0) {
    throw new Error(`The Sol explore probe failed: ${executor.result.summary}`);
  }
  verifyProfileRouting(executor.result, "explore");
  if (
    executor.result.changed_files.length !== 0 ||
    executor.result.checks.length !== 1 ||
    executor.result.checks[0] !== expectedCheck
  ) {
    throw new Error("The Sol explore probe did not prove read-only workspace access.");
  }
  return executor.result;
}

async function createWriteProbeRepository() {
  const repository = await mkdtemp(join(tmpdir(), "sol-sol-write-probe-"));
  await execFileAsync("git", ["init", "--quiet"], {
    cwd: repository,
    windowsHide: true,
  });
  await writeFile(join(repository, "executor-probe.txt"), "before\n");
  await execFileAsync("git", ["add", "executor-probe.txt"], {
    cwd: repository,
    windowsHide: true,
  });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Sol-Sol Probe",
      "-c",
      "user.email=sol-sol-probe@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "chore: initialize probe",
    ],
    { cwd: repository, windowsHide: true },
  );
  return repository;
}

async function runImplementProbe(repository, sessionRoots) {
  const executor = await invokeExecutor({
    briefing: [
      "Own only executor-probe.txt in this temporary repository.",
      "Replace its complete contents with exactly: verified implement profile",
      "Keep one trailing newline, run git diff --check, and do not modify any other file.",
      "Return status completed, summary Sol implement workspace probe completed, changed_files containing exactly executor-probe.txt, checks containing exactly git_diff_check:passed, and no blockers or warnings.",
    ].join("\n"),
    options: {
      profile: "implement",
      cwd: repository,
      sandboxMode: "workspace-write",
      timeoutSeconds: 300,
    },
    sessionRoots,
  });
  verifyExecutorResultSchema(executor.result);
  if (executor.exitCode !== 0) {
    throw new Error(`The Sol implement probe failed: ${executor.result.summary}`);
  }
  verifyProfileRouting(executor.result, "implement");
  const probeContent = (await readFile(join(repository, "executor-probe.txt"), "utf8")).replace(
    /\r\n/g,
    "\n",
  );
  if (
    probeContent !== "verified implement profile\n" ||
    JSON.stringify(executor.result.changed_files) !== JSON.stringify(["executor-probe.txt"]) ||
    JSON.stringify(executor.result.checks) !== JSON.stringify(["git_diff_check:passed"])
  ) {
    throw new Error("The Sol implement probe did not prove bounded workspace-write access.");
  }
  return executor.result;
}

async function runReviewProbe(repository, sessionRoots) {
  const beforeStatus = await gitStatus(repository);
  const executor = await invokeExecutor({
    briefing: [
      "Review the current Git diff for executor-probe.txt only.",
      "The expected change replaces the baseline text with verified implement profile and keeps one trailing newline.",
      "Do not modify files. Return completed with a summary beginning APPROVE, no changed files, at least one check describing the inspected diff, and no blockers or warnings.",
    ].join("\n"),
    options: {
      profile: "review",
      cwd: repository,
      sandboxMode: "read-only",
      timeoutSeconds: 300,
    },
    sessionRoots,
  });
  verifyExecutorResultSchema(executor.result);
  if (executor.exitCode !== 0) {
    throw new Error(`The Sol review probe failed: ${executor.result.summary}`);
  }
  verifyProfileRouting(executor.result, "review");
  const afterStatus = await gitStatus(repository);
  if (
    !executor.result.summary.startsWith("APPROVE") ||
    executor.result.changed_files.length !== 0 ||
    executor.result.checks.length === 0 ||
    afterStatus !== beforeStatus
  ) {
    throw new Error("The Sol review probe did not prove bounded read-only review behavior.");
  }
  return executor.result;
}

async function runExecutorProbes(repositoryRoot, sessionRoots) {
  const writeRepository = await createWriteProbeRepository();
  try {
    const explore = await runExploreProbe(repositoryRoot, sessionRoots);
    const implement = await runImplementProbe(writeRepository, sessionRoots);
    const review = await runReviewProbe(writeRepository, sessionRoots);
    return { explore, implement, review };
  } finally {
    await rm(writeRepository, { recursive: true, force: true });
  }
}

async function runLockedExecutorProbe(sessionRoots) {
  const repository = await mkdtemp(join(tmpdir(), "sol-ultra-blocked-executor-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: repository, windowsHide: true });
  const lock = await acquireUltraLock({
    cwd: repository,
    reason: "Live executor lock probe",
    sandboxMode: "read-only",
  });
  try {
    const executor = await invokeExecutor({
      briefing: "This executor must be rejected before Codex starts.",
      options: {
        profile: "explore",
        cwd: repository,
        sandboxMode: "read-only",
        timeoutSeconds: 30,
      },
      sessionRoots,
    });
    verifyExecutorResultSchema(executor.result);
    if (
      executor.exitCode !== 2 ||
      executor.result.routing_verified !== false ||
      !executor.result.summary.includes("exclusive Sol Ultra takeover")
    ) {
      throw new Error("A normal executor was not rejected by the active Ultra lock.");
    }
    return executor.result;
  } finally {
    await releaseUltraLock({ cwd: repository, lockId: lock.lock_id });
    await rm(repository, { recursive: true, force: true });
  }
}

async function runUltraReadOnlyProbe(repositoryRoot, sessionRoots) {
  const execution = await invokeUltra({
    briefing: [
      "Complete this routing probe without delegating or modifying files.",
      "Return status completed, summary Sol Ultra read-only probe completed, no changed files, checks containing exactly ultra_read_only:passed, and no blockers or warnings.",
    ].join("\n"),
    options: {
      cwd: repositoryRoot,
      reason: "Verify exceptional read-only routing",
      confirmed: true,
      sandboxMode: "read-only",
      timeoutSeconds: 300,
    },
    sessionRoots,
  });
  verifyUltraResultSchema(execution.result);
  if (execution.exitCode !== 0) {
    throw new Error(`The Sol Ultra read-only probe failed: ${execution.result.summary}`);
  }
  verifyUltraRouting(execution.result, "read-only");
  if (
    execution.result.changed_files.length !== 0 ||
    JSON.stringify(execution.result.checks) !== JSON.stringify(["ultra_read_only:passed"]) ||
    execution.result.executors.length !== 0
  ) {
    throw new Error("The Sol Ultra read-only probe returned an unexpected result.");
  }
  return execution.result;
}

async function runUltraWriteProbe(sessionRoots) {
  const repository = await mkdtemp(join(tmpdir(), "sol-ultra-write-probe-"));
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: repository, windowsHide: true });
    const execution = await invokeUltra({
      briefing: [
        "Delegate exactly one task through the verified implement profile and do not edit files yourself.",
        "Assign only ultra-probe.txt in this temporary repository. The implement executor must create it with exactly verified Ultra implement profile followed by one newline and run git diff --check.",
        "After the verified executor succeeds, return status completed, summary Sol Ultra implement delegation probe completed, changed_files containing exactly ultra-probe.txt, checks containing exactly ultra_implement_delegation:passed, and no blockers or warnings.",
      ].join("\n"),
      options: {
        cwd: repository,
        reason: "Verify exclusive workspace-write delegation",
        confirmed: true,
        sandboxMode: "workspace-write",
        timeoutSeconds: 600,
      },
      sessionRoots,
    });
    verifyUltraResultSchema(execution.result);
    if (execution.exitCode !== 0) {
      throw new Error(`The Sol Ultra workspace-write probe failed: ${execution.result.summary}`);
    }
    verifyUltraRouting(execution.result, "workspace-write");
    const content = (await readFile(join(repository, "ultra-probe.txt"), "utf8")).replace(
      /\r\n/g,
      "\n",
    );
    if (
      content !== "verified Ultra implement profile\n" ||
      JSON.stringify(execution.result.changed_files) !== JSON.stringify(["ultra-probe.txt"]) ||
      JSON.stringify(execution.result.checks) !==
        JSON.stringify(["ultra_implement_delegation:passed"]) ||
      execution.result.executors.length !== 1 ||
      execution.result.executors[0].profile !== "implement" ||
      execution.result.executors[0].routing_verified !== true
    ) {
      throw new Error("The Sol Ultra workspace-write probe did not verify delegated execution.");
    }
    return execution.result;
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}

async function runTimeoutRecoveryProbe() {
  const repository = await mkdtemp(join(tmpdir(), "sol-ultra-timeout-probe-"));
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: repository, windowsHide: true });
    const processResult = await runProcess(
      process.execPath,
      [
        ULTRA_LAUNCHER_PATH,
        "--cwd",
        repository,
        "--reason",
        "Verify timeout recovery",
        "--confirm-exclusive-takeover",
        "--sandbox",
        "read-only",
        "--timeout-seconds",
        "1",
      ],
      {
        input: "Wait for two minutes before returning a result.\n",
        timeoutMs: 60_000,
        cwd: repository,
      },
    );
    if (processResult.exitCode !== 2) {
      throw new Error("The Sol Ultra timeout probe did not exit with code 2.");
    }
    const launcherResult = JSON.parse(processResult.stdout.split(/\r?\n/).at(-1));
    if (!launcherResult.summary.includes("timed out")) {
      throw new Error(`The Sol Ultra timeout probe failed unexpectedly: ${launcherResult.summary}`);
    }
    const status = await getOrchestrationStatus(repository);
    if (status.lock?.state !== "recovery-required") {
      throw new Error("The Sol Ultra timeout probe did not require recovery.");
    }
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        ORCHESTRATION_GATE_PATH,
        "recover",
        "--cwd",
        repository,
        "--lock-id",
        status.lock.lock_id,
      ],
      { cwd: repository, windowsHide: true },
    );
    const recovery = JSON.parse(stdout);
    if (recovery.status !== "recovered") {
      throw new Error("The Sol Ultra timeout lock was not recovered through the gate.");
    }
    if ((await getOrchestrationStatus(repository)).lock !== null) {
      throw new Error("The recovered Sol Ultra lock still exists.");
    }
    return { status: "recovered", lock_id: status.lock.lock_id };
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}

async function runRepositoryIsolationProbe() {
  const firstRepository = await mkdtemp(join(tmpdir(), "sol-ultra-isolation-a-"));
  const secondRepository = await mkdtemp(join(tmpdir(), "sol-ultra-isolation-b-"));
  try {
    await execFileAsync("git", ["init", "--quiet"], {
      cwd: firstRepository,
      windowsHide: true,
    });
    await execFileAsync("git", ["init", "--quiet"], {
      cwd: secondRepository,
      windowsHide: true,
    });
    const first = await acquireUltraLock({
      cwd: firstRepository,
      reason: "First isolation probe",
      sandboxMode: "read-only",
    });
    const second = await acquireUltraLock({
      cwd: secondRepository,
      reason: "Second isolation probe",
      sandboxMode: "read-only",
    });
    await releaseUltraLock({ cwd: firstRepository, lockId: first.lock_id });
    await releaseUltraLock({ cwd: secondRepository, lockId: second.lock_id });
    return { independent: true };
  } finally {
    await rm(firstRepository, { recursive: true, force: true });
    await rm(secondRepository, { recursive: true, force: true });
  }
}

export async function verifyRouting(repositoryRoot = REPOSITORY_ROOT) {
  const beforeStatus = await gitStatus(repositoryRoot);
  const codexHome = process.env.CODEX_HOME
    ? resolve(process.env.CODEX_HOME)
    : resolve(homedir(), ".codex");
  const hooksPath = join(codexHome, "hooks.json");
  const hooksBefore = await readOptional(hooksPath);
  const skill = await verifySkillDiscovery(repositoryRoot);
  const sessionRoots = getSessionRoots();
  const rootProbe = await runGlobalRootProbe(sessionRoots);
  const executors = await runExecutorProbes(repositoryRoot, sessionRoots);
  const blockedExecutor = await runLockedExecutorProbe(sessionRoots);
  const ultraReadOnly = await runUltraReadOnlyProbe(repositoryRoot, sessionRoots);
  const ultraWorkspaceWrite = await runUltraWriteProbe(sessionRoots);
  const timeoutRecovery = await runTimeoutRecoveryProbe();
  const repositoryIsolation = await runRepositoryIsolationProbe();

  const afterStatus = await gitStatus(repositoryRoot);
  if (afterStatus !== beforeStatus) {
    throw new Error("Git status changed during the read-only routing verification.");
  }
  if ((await readOptional(hooksPath)) !== hooksBefore) {
    throw new Error("The existing global hooks.json changed during routing verification.");
  }

  return {
    status: "completed",
    root: {
      thread_id: rootProbe.threadId,
      model: rootProbe.routing.model,
      reasoning_effort: rootProbe.routing.reasoningEffort,
    },
    executors,
    blocked_executor: blockedExecutor,
    ultra: {
      read_only: ultraReadOnly,
      workspace_write: ultraWorkspaceWrite,
      timeout_recovery: timeoutRecovery,
      repository_isolation: repositoryIsolation,
    },
    skill,
    git_unchanged: true,
    hooks_json_unchanged: true,
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
