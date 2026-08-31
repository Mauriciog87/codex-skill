import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  getSessionRoots,
  invokeExecutor,
  runProcess,
  validateExecutorPayload,
  verifySessionRouting,
} from "../.agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs";
import {
  loadExecutorResultContract,
  validateExecutorResultContract,
} from "../.agents/skills/sol-luna-orchestration/scripts/executor-result-contract.mjs";
import {
  invokeDurableExecutor,
} from "../.agents/skills/sol-luna-orchestration/scripts/durable-executor.mjs";
import {
  createAction,
  dispatchAssignmentAction,
} from "../.agents/skills/sol-luna-orchestration/scripts/control-plane.mjs";
import {
  cleanupAssignmentWorktree,
  integrateCandidate,
} from "../.agents/skills/sol-luna-orchestration/scripts/git-workspace.mjs";
import {
  MINIMUM_CODEX_VERSION,
  runAppServerTurn,
} from "../.agents/skills/sol-luna-orchestration/scripts/codex-app-server-client.mjs";
import { EXECUTOR_PROFILES } from "../.agents/skills/sol-luna-orchestration/scripts/executor-profiles.mjs";
import {
  invokeUltra,
} from "../.agents/skills/sol-luna-orchestration/scripts/invoke-sol-ultra.mjs";
import {
  acquireUltraLock,
  beginExecutorRun,
  EXECUTOR_CAPACITY_LIMITS,
  finishExecutorRun,
  getOrchestrationStatus,
  releaseUltraLock,
} from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-state.mjs";
import {
  readDeliveryConfiguration,
} from "../.agents/skills/sol-luna-orchestration/scripts/delivery-configuration.mjs";
import {
  LEGACY_SKILL_NAME,
  SKILL_NAME,
  TERRA_LEGACY_SKILL_NAME,
  updateGlobalConfig,
  updateGlobalInstructions,
} from "./install-global-orchestration.mjs";
import {
  getPlatformName,
  isPathInside,
  readCodexVersion,
  runCommand,
  writeJsonOutput,
} from "./platform-runtime.mjs";

export const ORCHESTRATOR_MODEL = "gpt-5.6-sol";
export const ORCHESTRATOR_REASONING_EFFORT = "xhigh";
export const ORCHESTRATOR_SERVICE_TIER = "standard";

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
    throw new Error("The repository Codex configuration does not enforce Sol xhigh with low verbosity.");
  }
  const globalConfigPath = join(codexHome, "config.toml");
  const globalConfig = await readFile(globalConfigPath, "utf8");
  const globalHookScript = join(globalSkill, "scripts", "orchestration-gate.mjs");
  if (updateGlobalConfig(globalConfig, { hookScriptPath: globalHookScript }).changed) {
    throw new Error(
      "The global Codex configuration does not enforce Sol xhigh, low verbosity, and hooks.",
    );
  }
  const deliveryConfiguration = await readDeliveryConfiguration({ codexHome });
  if (!deliveryConfiguration.exists) {
    throw new Error("The global automatic-delivery configuration is not installed.");
  }
  const globalInstructions = await activeGlobalInstructions(codexHome);
  if (updateGlobalInstructions(globalInstructions.content).changed) {
    throw new Error("The active global instructions do not contain the managed Sol-Luna block.");
  }

  const legacyPaths = [
    join(homeDirectory, ".agents", "skills", LEGACY_SKILL_NAME),
    join(homeDirectory, ".agents", "skills", TERRA_LEGACY_SKILL_NAME),
    join(codexHome, "skills", LEGACY_SKILL_NAME),
    join(codexHome, "skills", TERRA_LEGACY_SKILL_NAME),
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
    delivery_config: deliveryConfiguration.path,
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
    "service_tier",
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

function verifyDurableExecutorResultSchema(result) {
  const expectedProperties = [
    "schema_version",
    "assignment_id",
    "attempt",
    "status",
    "profile",
    "thread_id",
    "model",
    "reasoning_effort",
    "service_tier",
    "routing_verified",
    "sandbox_mode",
    "base_revision",
    "candidate",
    "summary",
    "changed_files",
    "artifacts",
    "operator_requests",
    "checks",
    "blockers",
    "warnings",
  ];
  if (JSON.stringify(Object.keys(result)) !== JSON.stringify(expectedProperties)) {
    throw new Error("The durable executor result does not match the version 2 output contract.");
  }
  if (
    result.schema_version !== 2 ||
    typeof result.assignment_id !== "string" ||
    !Number.isInteger(result.attempt) ||
    result.attempt < 1 ||
    typeof result.routing_verified !== "boolean"
  ) {
    throw new Error("The durable executor result contains invalid fixed properties.");
  }
  for (const property of ["changed_files", "artifacts", "operator_requests", "checks", "blockers", "warnings"]) {
    if (!Array.isArray(result[property])) {
      throw new Error(`Durable executor result property ${property} must be an array.`);
    }
  }
  for (const property of ["changed_files", "blockers", "warnings"]) {
    if (result[property].some((entry) => typeof entry !== "string")) {
      throw new Error(`Durable executor result property ${property} must contain strings.`);
    }
  }
  if (result.checks.some((entry) => typeof entry !== "string" && (entry === null || typeof entry !== "object"))) {
    throw new Error("Durable executor result property checks contains an invalid entry.");
  }
}

function verifyUltraResultSchema(result) {
  const expectedProperties = [
    "status",
    "mode",
    "lock_id",
    "generation",
    "thread_id",
    "model",
    "reasoning_effort",
    "service_tier",
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
    !(result.generation === null || (Number.isInteger(result.generation) && result.generation >= 1)) ||
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
    result.service_tier !== "standard" ||
    result.routing_verified !== true ||
    !Number.isInteger(result.generation) ||
    result.sandbox_mode !== sandboxMode
  ) {
    throw new Error("The Ultra probe returned unexpected routing metadata.");
  }
}

function verifyProfileRouting(result, profileName) {
  const profile = EXECUTOR_PROFILES[profileName];
  if (
    result.profile !== profileName ||
    result.model !== profile.model ||
    result.reasoning_effort !== profile.reasoningEffort ||
    result.service_tier !== profile.serviceTier ||
    result.routing_verified !== true ||
    result.sandbox_mode !== profile.sandboxMode
  ) {
    throw new Error(`The ${profileName} probe returned unexpected profile or routing metadata.`);
  }
}

function validateRootProbePayload(value) {
  const payload = validateExecutorPayload(value);
  if (
    payload.status !== "completed"
    || payload.changed_files.length !== 0
    || payload.checks.length !== 0
    || payload.blockers.length !== 0
    || payload.warnings.length !== 0
    || payload.operator_requests.length !== 0
  ) {
    throw new Error("The Sol routing probe returned an unexpected structured result.");
  }
  return payload;
}

async function runGlobalRootProbe(sessionRoots, outputContract) {
  const temporaryRepository = await mkdtemp(join(tmpdir(), "sol-luna-global-probe-"));
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
    const rootProcess = await runAppServerTurn({
      command: "codex",
      cwd: temporaryRepository,
      model: ORCHESTRATOR_MODEL,
      reasoningEffort: ORCHESTRATOR_REASONING_EFFORT,
      serviceTier: ORCHESTRATOR_SERVICE_TIER,
      configuredServiceTier: "default",
      fastMode: false,
      sandboxMode: "read-only",
      developerInstructions,
      briefing: "Return status completed, summary Sol routing probe completed, and empty changed_files, checks, blockers, warnings, and operator_requests arrays.",
      outputSchema: outputContract.schema,
      timeoutMs: 300_000,
    });
    if (rootProcess.threadId === null) {
      throw new Error("The Sol routing probe did not return a thread id.");
    }
    if (rootProcess.turnStatus !== "completed" || rootProcess.blockedReason !== null) {
      throw new Error("The Sol routing probe did not complete through App Server.");
    }
    const payload = validateRootProbePayload(JSON.parse(rootProcess.finalResponse));
    const routing = await verifySessionRouting(
      rootProcess.threadId,
      ORCHESTRATOR_MODEL,
      ORCHESTRATOR_REASONING_EFFORT,
      { sessionRoots },
    );
    return {
      threadId: rootProcess.threadId,
      routing: { ...routing, serviceTier: rootProcess.serviceTier },
      payload,
    };
  } finally {
    await rm(temporaryRepository, { recursive: true, force: true });
  }
}

async function collectGeneratedSchemaFiles(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectGeneratedSchemaFiles(path, files);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(path);
    }
  }
  return files;
}

export async function verifyAppServerSchema({
  environment = process.env,
  commandRunner = runCommand,
} = {}) {
  const outputDirectory = await mkdtemp(join(tmpdir(), "codex-app-server-schema-"));
  try {
    await commandRunner(
      "codex",
      ["app-server", "generate-json-schema", "--experimental", "--out", outputDirectory],
      { environment, maxBuffer: 16 * 1024 * 1024 },
    );
    const files = await collectGeneratedSchemaFiles(outputDirectory);
    if (files.length === 0) {
      throw new Error("App Server schema generation produced no JSON files.");
    }
    const schemaDocuments = await Promise.all(
      files.map(async (path) => JSON.parse(await readFile(path, "utf8"))),
    );
    const schemaText = schemaDocuments.map((document) => JSON.stringify(document)).join("\n");
    for (const requiredShape of [
      "model/list",
      "thread/start",
      "thread/settings/update",
      "thread/settings/updated",
      "turn/start",
      "turn/interrupt",
      "item/commandExecution/requestApproval",
      "mcpServer/elicitation/request",
      "experimentalApi",
      "serviceTier",
      "outputSchema",
      "developerInstructions",
    ]) {
      if (!schemaText.includes(requiredShape)) {
        throw new Error(`Generated App Server schemas do not expose ${requiredShape}.`);
      }
    }
    for (const [definitionName, properties] of Object.entries({
      ThreadStartParams: ["model", "cwd", "sandbox", "developerInstructions", "serviceTier"],
      ThreadSettingsUpdateParams: ["threadId", "model", "effort", "serviceTier"],
      ThreadSettingsUpdatedNotification: ["threadId", "threadSettings"],
      TurnStartParams: ["threadId", "input", "outputSchema"],
    })) {
      const definition = schemaDocuments
        .map((document) =>
          document.title === definitionName
            ? document
            : document.definitions?.[definitionName])
        .find(Boolean);
      if (definition === undefined) {
        throw new Error(`Generated App Server schemas do not define ${definitionName}.`);
      }
      for (const property of properties) {
        if (!Object.hasOwn(definition.properties ?? {}, property)) {
          throw new Error(
            `Generated App Server ${definitionName} does not expose ${property}.`,
          );
        }
      }
    }
    return { cli_minimum: MINIMUM_CODEX_VERSION, generated_files: files.length };
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
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
      "Return status completed, summary Luna explore workspace probe completed, no changed files, exactly one check formatted as workspace_read_sha256:<lowercase hex digest>, and no blockers or warnings.",
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
    throw new Error(`The Luna explore probe failed: ${executor.result.summary}`);
  }
  verifyProfileRouting(executor.result, "explore");
  if (
    executor.result.changed_files.length !== 0 ||
    executor.result.checks.length !== 1 ||
    executor.result.checks[0] !== expectedCheck
  ) {
    throw new Error("The Luna explore probe did not prove read-only workspace access.");
  }
  return executor.result;
}

async function createWriteProbeRepository() {
  const repository = await mkdtemp(join(tmpdir(), "sol-luna-write-probe-"));
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
        "user.email=sol-luna-probe@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "chore: initialize probe",
    ],
    { cwd: repository, windowsHide: true },
  );
  return repository;
}

async function completeDurableWriteProbe(record, repository) {
  let current = (
    await dispatchAssignmentAction(
      repository,
      createAction({ op: "claim_result", authority: "root", record }),
    )
  ).record;
  current = (
    await dispatchAssignmentAction(
      repository,
      createAction({
        op: "approve_candidate",
        authority: "root",
        record: current,
        payload: { candidate_id: current.candidate.candidate_id, kind: "root" },
      }),
    )
  ).record;
  current = (
    await dispatchAssignmentAction(
      repository,
      createAction({
        op: "integrate_candidate",
        authority: "root",
        record: current,
        payload: { candidate_id: current.candidate.candidate_id },
      }),
      { beforeTransition: async (pending) => integrateCandidate(pending, repository) },
    )
  ).record;
  current = (
    await dispatchAssignmentAction(
      repository,
      createAction({ op: "acknowledge_assignment", authority: "root", record: current }),
    )
  ).record;
  const cleanup = await cleanupAssignmentWorktree(current);
  if (!cleanup.cleaned) {
    throw new Error("The durable write probe did not clean its isolated worktree.");
  }
  return (
    await dispatchAssignmentAction(
      repository,
      createAction({
        op: "cleanup_workspace",
        authority: "root",
        record: current,
        payload: { cleaned_path: cleanup.path },
      }),
    )
  ).record;
}

async function abandonDurableWriteProbe(record, repository) {
  if (record?.workspace?.path === undefined || record.workspace.cleaned === true) {
    return;
  }
  let current = record;
  if (!new Set(["acknowledged", "abandoned"]).has(current.state)) {
    current = (
      await dispatchAssignmentAction(
        repository,
        createAction({
          op: "abandon_assignment",
          authority: "root",
          record: current,
          payload: { reason: "Live routing probe cleanup after failure." },
        }),
      )
    ).record;
  }
  const cleanup = await cleanupAssignmentWorktree(current);
  if (cleanup.cleaned) {
    await dispatchAssignmentAction(
      repository,
      createAction({
        op: "cleanup_workspace",
        authority: "root",
        record: current,
        payload: { cleaned_path: cleanup.path },
      }),
    );
  }
}

async function runWriteProfileProbe(repository, sessionRoots, profileName) {
  const expectedContent = `verified ${profileName} profile\n`;
  let record = null;
  try {
    const executor = await invokeDurableExecutor({
      briefing: [
        "Own only executor-probe.txt in this temporary repository.",
        `Replace its complete contents with exactly: verified ${profileName} profile`,
        "Keep one trailing newline, run git diff --check, and do not modify any other file.",
        `Return status completed, summary ${profileName} workspace probe completed, changed_files containing exactly executor-probe.txt, checks containing exactly git_diff_check:passed, and no blockers or warnings.`,
      ].join("\n"),
      options: {
        profile: profileName,
        cwd: repository,
        sandboxMode: "workspace-write",
        timeoutSeconds: 300,
        assignmentId: null,
        enqueueOnly: false,
        priority: "normal",
        writeRoots: ["executor-probe.txt"],
        forbiddenRoots: [],
        requiredChecks: [
          {
            id: "controller-git-diff-check",
            argv: ["git", "diff", "--check"],
            cwd: ".",
            timeout_seconds: 60,
          },
        ],
        artifacts: [],
        reviewPolicy: "root",
        operatorApprovalRequired: false,
        allowSymlinks: false,
        allowSubmodules: false,
        candidateId: null,
        resultFormat: "v2",
      },
      invokeLegacy: invokeExecutor,
      sessionRoots,
    });
    record = executor.record;
    verifyDurableExecutorResultSchema(executor.result);
    if (executor.exitCode !== 0) {
      throw new Error(`The ${profileName} probe failed: ${executor.result.summary}`);
    }
    verifyProfileRouting(executor.result, profileName);
    if (
      executor.result.candidate === null ||
      JSON.stringify(executor.result.changed_files) !== JSON.stringify(["executor-probe.txt"]) ||
      executor.result.checks[0] !== "git_diff_check:passed" ||
      executor.result.checks[1]?.id !== "controller-git-diff-check" ||
      executor.result.checks[1]?.exit_code !== 0
    ) {
      throw new Error(`The ${profileName} probe did not publish a verified candidate.`);
    }
    record = await completeDurableWriteProbe(record, repository);
    const probeContent = (await readFile(join(repository, "executor-probe.txt"), "utf8")).replace(
      /\r\n/g,
      "\n",
    );
    if (probeContent !== expectedContent || record.workspace.cleaned !== true) {
      throw new Error(`The ${profileName} probe did not prove durable worktree integration.`);
    }
    return executor.result;
  } finally {
    await abandonDurableWriteProbe(record, repository).catch(() => {});
  }
}

async function runImplementLiteProbe(repository, sessionRoots) {
  return runWriteProfileProbe(repository, sessionRoots, "implement-lite");
}

async function runImplementProbe(repository, sessionRoots) {
  return runWriteProfileProbe(repository, sessionRoots, "implement");
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

async function runPlaywrightProbe(repositoryRoot, sessionRoots) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><html><body><h1>Sol-Luna Playwright probe</h1><button id=action onclick=\"document.querySelector('#status').textContent='verified'\">Run check</button><p id=status>pending</p></body></html>",
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  const beforeStatus = await gitStatus(repositoryRoot);
  try {
    const executor = await invokeExecutor({
      briefing: [
        `Use the Playwright MCP to open ${url}`,
        "Verify the h1 text is Sol-Luna Playwright probe, click #action, verify #status becomes verified, and take one screenshot.",
        "Do not modify repository files. Return completed, no changed files, at least two concise evidence checks, and no blockers or warnings.",
      ].join("\n"),
      options: {
        profile: "playwright",
        cwd: repositoryRoot,
        sandboxMode: "read-only",
        timeoutSeconds: 300,
      },
      sessionRoots,
    });
    verifyExecutorResultSchema(executor.result);
    if (executor.exitCode !== 0) {
      throw new Error(`The Playwright probe failed: ${executor.result.summary}`);
    }
    verifyProfileRouting(executor.result, "playwright");
    if (
      executor.result.changed_files.length !== 0 ||
      !executor.result.checks.includes("playwright_mcp:verified") ||
      executor.result.checks.length < 3 ||
      (await gitStatus(repositoryRoot)) !== beforeStatus
    ) {
      throw new Error("The Playwright probe did not prove isolated MCP browser access.");
    }
    return executor.result;
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function runExecutorProbes(repositoryRoot, sessionRoots) {
  const liteRepository = await createWriteProbeRepository();
  const writeRepository = await createWriteProbeRepository();
  try {
    const explore = await runExploreProbe(repositoryRoot, sessionRoots);
    const implementLite = await runImplementLiteProbe(liteRepository, sessionRoots);
    const playwright = await runPlaywrightProbe(repositoryRoot, sessionRoots);
    const implement = await runImplementProbe(writeRepository, sessionRoots);
    const review = await runReviewProbe(writeRepository, sessionRoots);
    return { explore, implement_lite: implementLite, playwright, implement, review };
  } finally {
    await rm(liteRepository, { recursive: true, force: true });
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
    await releaseUltraLock({
      cwd: repository,
      lockId: lock.lock_id,
      generation: lock.generation,
    });
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
    await writeFile(join(repository, "baseline.txt"), "baseline\n", "utf8");
    await execFileAsync("git", ["add", "baseline.txt"], { cwd: repository, windowsHide: true });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Sol-Ultra Probe",
        "-c",
        "user.email=sol-ultra-probe@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "chore: initialize Ultra probe",
      ],
      { cwd: repository, windowsHide: true },
    );
    const execution = await invokeUltra({
      briefing: [
        "Delegate exactly one task through the verified implement profile and do not edit files yourself.",
        "Launch it through the durable version 2 control plane with workspace-write and --write-root ultra-probe.txt.",
        "Assign only ultra-probe.txt in this temporary repository. The implement executor must create it with exactly verified Ultra implement profile followed by one newline and run git diff --check.",
        "After it publishes a candidate, refresh the exact assignment revision before each control action, then claim, approve as root, integrate, acknowledge, and clean its isolated worktree.",
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
    if (
      launcherResult.lock_id !== status.lock.lock_id ||
      launcherResult.generation !== status.lock.generation
    ) {
      throw new Error("The Sol Ultra timeout result did not preserve its fenced lock generation.");
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
    await releaseUltraLock({
      cwd: firstRepository,
      lockId: first.lock_id,
      generation: first.generation,
    });
    await releaseUltraLock({
      cwd: secondRepository,
      lockId: second.lock_id,
      generation: second.generation,
    });
    return { independent: true };
  } finally {
    await rm(firstRepository, { recursive: true, force: true });
    await rm(secondRepository, { recursive: true, force: true });
  }
}

function capacityExecution(lease) {
  const profile = EXECUTOR_PROFILES[lease.profile];
  return {
    exitCode: 0,
    result: {
      status: "completed",
      profile: profile.name,
      thread_id: `capacity-${lease.run_id}`,
      model: profile.model,
      reasoning_effort: profile.reasoningEffort,
      service_tier: profile.serviceTier,
      routing_verified: true,
    },
  };
}

async function runCapacityProbe() {
  const repository = await mkdtemp(join(tmpdir(), "sol-luna-capacity-probe-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: repository, windowsHide: true });
  const leases = [];
  try {
    const initial = await getOrchestrationStatus(repository);
    if (initial.capacity.machine.total !== 0) {
      throw new Error("The machine executor pool is already in use; capacity verification requires an idle pool.");
    }

    for (let index = 0; index < EXECUTOR_CAPACITY_LIMITS.playwright; index += 1) {
      leases.push(
        await beginExecutorRun({
          cwd: repository,
          profile: "playwright",
          model: EXECUTOR_PROFILES.playwright.model,
        }),
      );
    }
    let thirdPlaywrightRejected = false;
    try {
      await beginExecutorRun({
        cwd: repository,
        profile: "playwright",
        model: EXECUTOR_PROFILES.playwright.model,
      });
    } catch (error) {
      thirdPlaywrightRejected = /Playwright executor capacity is full/.test(error.message);
    }
    if (!thirdPlaywrightRejected) {
      throw new Error("The third concurrent Playwright lease was not rejected.");
    }
    while (leases.length > 0) {
      const lease = leases.pop();
      await finishExecutorRun(lease, capacityExecution(lease));
    }

    for (let index = 0; index < EXECUTOR_CAPACITY_LIMITS.luna; index += 1) {
      leases.push(
        await beginExecutorRun({
          cwd: repository,
          profile: "explore",
          model: EXECUTOR_PROFILES.explore.model,
        }),
      );
    }
    for (let index = 0; index < EXECUTOR_CAPACITY_LIMITS.sol; index += 1) {
      leases.push(
        await beginExecutorRun({
          cwd: repository,
          profile: "review",
          model: EXECUTOR_PROFILES.review.model,
        }),
      );
    }
    const saturated = await getOrchestrationStatus(repository);
    if (
      saturated.capacity.repository.luna !== EXECUTOR_CAPACITY_LIMITS.luna ||
      saturated.capacity.repository.sol !== EXECUTOR_CAPACITY_LIMITS.sol ||
      saturated.capacity.machine.total !== EXECUTOR_CAPACITY_LIMITS.total
    ) {
      throw new Error("Executor capacity did not reach the configured Luna, Sol, and total limits.");
    }
    return {
      luna_limit: EXECUTOR_CAPACITY_LIMITS.luna,
      sol_limit: EXECUTOR_CAPACITY_LIMITS.sol,
      total_limit: EXECUTOR_CAPACITY_LIMITS.total,
      playwright_limit: EXECUTOR_CAPACITY_LIMITS.playwright,
      third_playwright_rejected: true,
    };
  } finally {
    while (leases.length > 0) {
      const lease = leases.pop();
      await finishExecutorRun(lease, capacityExecution(lease));
    }
    await rm(repository, { recursive: true, force: true });
  }
}

export async function verifyRouting(repositoryRoot = REPOSITORY_ROOT) {
  const beforeStatus = await gitStatus(repositoryRoot);
  const platform = getPlatformName();
  if (platform === null) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }
  const codexVersion = await readCodexVersion({ cwd: repositoryRoot });
  const codexHome = process.env.CODEX_HOME
    ? resolve(process.env.CODEX_HOME)
    : resolve(homedir(), ".codex");
  const hooksPath = join(codexHome, "hooks.json");
  const hooksBefore = await readOptional(hooksPath);
  const skill = await verifySkillDiscovery(repositoryRoot);
  const appServer = await verifyAppServerSchema();
  const sessionRoots = getSessionRoots();
  const outputContract = validateExecutorResultContract(await loadExecutorResultContract());
  const rootProbe = await runGlobalRootProbe(sessionRoots, outputContract);
  const executors = await runExecutorProbes(repositoryRoot, sessionRoots);
  const blockedExecutor = await runLockedExecutorProbe(sessionRoots);
  const ultraReadOnly = await runUltraReadOnlyProbe(repositoryRoot, sessionRoots);
  const ultraWorkspaceWrite = await runUltraWriteProbe(sessionRoots);
  const timeoutRecovery = await runTimeoutRecoveryProbe();
  const repositoryIsolation = await runRepositoryIsolationProbe();
  const capacity = await runCapacityProbe();

  const afterStatus = await gitStatus(repositoryRoot);
  if (afterStatus !== beforeStatus) {
    throw new Error("Git status changed during the read-only routing verification.");
  }
  if ((await readOptional(hooksPath)) !== hooksBefore) {
    throw new Error("The existing global hooks.json changed during routing verification.");
  }

  return {
    status: "completed",
    platform,
    architecture: process.arch,
    node_version: process.version,
    codex_version: codexVersion,
    root: {
      thread_id: rootProbe.threadId,
      model: rootProbe.routing.model,
      reasoning_effort: rootProbe.routing.reasoningEffort,
      service_tier: rootProbe.routing.serviceTier,
    },
    executors,
    blocked_executor: blockedExecutor,
    ultra: {
      read_only: ultraReadOnly,
      workspace_write: ultraWorkspaceWrite,
      timeout_recovery: timeoutRecovery,
      repository_isolation: repositoryIsolation,
    },
    capacity,
    skill,
    app_server: appServer,
    git_unchanged: true,
    hooks_json_unchanged: true,
  };
}

export async function verifyOutputSchemaLive(repositoryRoot = REPOSITORY_ROOT, dependencies = {}) {
  const platformCode = dependencies.platform ?? process.platform;
  const platform = getPlatformName(platformCode);
  if (platform === null) {
    throw new Error(`Unsupported platform: ${platformCode}`);
  }
  const statusReader = dependencies.gitStatusReader ?? gitStatus;
  const codexVersionReader = dependencies.codexVersionReader
    ?? ((cwd) => readCodexVersion({ cwd }));
  const outputContractLoader = dependencies.outputContractLoader ?? loadExecutorResultContract;
  const rootProbeRunner = dependencies.rootProbeRunner ?? runGlobalRootProbe;
  const beforeStatus = await statusReader(repositoryRoot);
  const outputContract = validateExecutorResultContract(await outputContractLoader());
  const rootProbe = await rootProbeRunner(
    dependencies.sessionRoots ?? getSessionRoots(),
    outputContract,
  );
  const rootPayload = validateRootProbePayload(rootProbe.payload);
  const afterStatus = await statusReader(repositoryRoot);
  if (afterStatus !== beforeStatus) {
    throw new Error("Git status changed during schema-only live verification.");
  }
  return {
    status: "completed",
    mode: "schema-only",
    platform,
    architecture: process.arch,
    node_version: process.version,
    codex_version: await codexVersionReader(repositoryRoot),
    executor_output_schema_sha256: outputContract.sha256,
    root: {
      thread_id: rootProbe.threadId,
      model: rootProbe.routing.model,
      reasoning_effort: rootProbe.routing.reasoningEffort,
      service_tier: rootProbe.routing.serviceTier,
      result: rootPayload,
    },
    git_unchanged: true,
  };
}

export function parseVerifyRoutingArguments(argv) {
  let outputPath = null;
  let schemaOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--schema-only") {
      if (schemaOnly) {
        throw new Error("--schema-only may be provided only once.");
      }
      schemaOnly = true;
      continue;
    }
    if (argument !== "--output") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (outputPath !== null) {
      throw new Error("--output may be provided only once.");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("--output requires a path.");
    }
    outputPath = resolve(value);
    index += 1;
  }
  return { outputPath, schemaOnly };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const verify = dependencies.verifyRouting ?? verifyRouting;
  const verifySchemaOnly = dependencies.verifyOutputSchemaLive ?? verifyOutputSchemaLive;
  const outputWriter = dependencies.writeJsonOutput ?? writeJsonOutput;
  const writeStdout = dependencies.writeStdout ?? ((value) => process.stdout.write(value));
  const writeStderr = dependencies.writeStderr ?? ((value) => process.stderr.write(value));
  let options;

  try {
    options = parseVerifyRoutingArguments(argv);
    if (options.outputPath !== null && isPathInside(REPOSITORY_ROOT, options.outputPath)) {
      throw new Error("--output must be outside the repository so live verification leaves Git unchanged.");
    }
    const result = options.schemaOnly ? await verifySchemaOnly() : await verify();
    await outputWriter(options.outputPath, result);
    writeStdout(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const result = {
      status: "failed",
      platform: getPlatformName(),
      architecture: process.arch,
      node_version: process.version,
      codex_version: null,
      summary: error.message,
    };
    if (options?.outputPath && !isPathInside(REPOSITORY_ROOT, options.outputPath)) {
      try {
        await outputWriter(options.outputPath, result);
      } catch (outputError) {
        result.summary = `${result.summary} Output failed: ${outputError.message}`;
      }
    }
    writeStderr(`${JSON.stringify(result)}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
