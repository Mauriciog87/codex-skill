import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MINIMUM_CODEX_VERSION,
  isCompatibleCodexVersion,
} from "../.agents/skills/sol-luna-orchestration/scripts/codex-app-server-client.mjs";
import {
  createProcessIdentity,
  inspectProcessIdentity,
} from "../.agents/skills/sol-luna-orchestration/scripts/process-identity.mjs";
import {
  parseDeliveryConfiguration,
} from "../.agents/skills/sol-luna-orchestration/scripts/delivery-configuration.mjs";
import {
  canonicalPathKey,
  getSkillLinkType,
  installGlobalOrchestration,
  updateGlobalConfig,
  updateGlobalInstructions,
} from "./install-global-orchestration.mjs";
import {
  getPlatformName,
  isPathInside,
  parseCodexVersion,
  readCodexVersion,
  runCommand,
  writeJsonOutput,
} from "./platform-runtime.mjs";
import { verifyAppServerSchema } from "./verify-routing.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");

export function createPlatformVerificationResult(overrides = {}) {
  return {
    status: "failed",
    platform: null,
    architecture: process.arch,
    node_version: process.version,
    codex_version: null,
    minimum_codex_version: MINIMUM_CODEX_VERSION,
    expected_codex_version: null,
    link_type: null,
    strict_config_verified: false,
    app_server_schema_verified: false,
    schema_file_count: 0,
    process_identity_verified: false,
    installation_idempotent: false,
    git_unchanged: false,
    checks: [],
    warnings: [],
    ...overrides,
  };
}

export function parseVerifyPlatformArguments(argv) {
  let expectedCodexVersion = null;
  let outputPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--expected-codex-version", "--output"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value.`);
    }
    if (argument === "--expected-codex-version") {
      if (expectedCodexVersion !== null) {
        throw new Error("--expected-codex-version may be provided only once.");
      }
      if (parseCodexVersion(value) !== value) {
        throw new Error("--expected-codex-version must use major.minor.patch format.");
      }
      expectedCodexVersion = value;
    } else {
      if (outputPath !== null) {
        throw new Error("--output may be provided only once.");
      }
      outputPath = resolve(value);
    }
    index += 1;
  }
  return { expectedCodexVersion, outputPath };
}

async function readGitStatus(repositoryRoot) {
  const { stdout } = await runCommand(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: repositoryRoot, maxBuffer: 1_048_576 },
  );
  return stdout;
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

function appendFailure(existing, error, prefix = "") {
  const message = `${prefix}${error.message}`;
  return existing === null ? new Error(message) : new Error(`${existing.message} ${message}`);
}

async function validateInstallation({
  first,
  second,
  canonicalSkill,
  codexHome,
  platform,
}) {
  const expectedLinkType = getSkillLinkType(platform);
  if (first.link_type !== expectedLinkType || second.link_type !== expectedLinkType) {
    throw new Error(`Installer did not create the expected ${expectedLinkType}.`);
  }
  const linkMetadata = await lstat(first.global_skill);
  if (!linkMetadata.isSymbolicLink()) {
    throw new Error(`Installed ${expectedLinkType} is not a filesystem link.`);
  }
  const actualTarget = await realpath(first.global_skill);
  const expectedTarget = await realpath(canonicalSkill);
  if (canonicalPathKey(actualTarget, platform) !== canonicalPathKey(expectedTarget, platform)) {
    throw new Error("Installed skill link does not resolve to the canonical repository skill.");
  }
  if (
    first.already_linked ||
    !first.configuration_changed ||
    !first.delivery_configuration_changed ||
    !first.instructions_changed ||
    !second.already_linked ||
    second.configuration_changed ||
    second.delivery_configuration_changed ||
    second.instructions_changed
  ) {
    throw new Error("The global installer is not idempotent in the isolated home.");
  }
  const config = await readFile(join(codexHome, "config.toml"), "utf8");
  const hookScriptPath = join(first.global_skill, "scripts", "orchestration-gate.mjs");
  if (updateGlobalConfig(config, { hookScriptPath }).changed) {
    throw new Error("The temporary global Codex configuration is incomplete.");
  }
  const deliveryConfig = await readFile(first.delivery_config, "utf8");
  if (!parseDeliveryConfiguration(deliveryConfig, first.delivery_config).automatic_delivery) {
    throw new Error("The temporary automatic-delivery configuration is not enabled by default.");
  }
  const instructions = await readFile(first.global_instructions, "utf8");
  if (updateGlobalInstructions(instructions).changed) {
    throw new Error("The temporary global Codex instructions are incomplete.");
  }
  return expectedLinkType;
}

export async function verifyPlatform(options = {}, dependencies = {}) {
  const platformCode = dependencies.platform ?? process.platform;
  const platform = getPlatformName(platformCode);
  const repositoryRoot = resolve(dependencies.repositoryRoot ?? REPOSITORY_ROOT);
  const commandRunner = dependencies.commandRunner ?? runCommand;
  const schemaVerifier = dependencies.schemaVerifier ?? verifyAppServerSchema;
  const processIdentityCreator = dependencies.processIdentityCreator ?? createProcessIdentity;
  const processIdentityInspector = dependencies.processIdentityInspector ?? inspectProcessIdentity;
  const installer = dependencies.installer ?? installGlobalOrchestration;
  const gitStatusReader = dependencies.gitStatusReader ?? readGitStatus;
  const temporaryDirectoryFactory = dependencies.temporaryDirectoryFactory
    ?? (() => mkdtemp(join(tmpdir(), "sol-luna-platform-")));
  const removeDirectory = dependencies.removeDirectory
    ?? ((path) => rm(path, { recursive: true, force: true }));
  const environment = dependencies.environment ?? process.env;
  const result = createPlatformVerificationResult({
    platform,
    expected_codex_version: options.expectedCodexVersion ?? null,
  });
  let beforeStatus = null;
  let temporaryRoot = null;
  let failure = null;

  try {
    if (platform === null) {
      throw new Error(`Unsupported platform: ${platformCode}`);
    }
    getSkillLinkType(platformCode);
    beforeStatus = await gitStatusReader(repositoryRoot);
    temporaryRoot = await temporaryDirectoryFactory();
    const homeDirectory = join(temporaryRoot, "home");
    const codexHome = join(temporaryRoot, "codex-home");
    await mkdir(homeDirectory, { recursive: true });
    const isolatedEnvironment = {
      ...environment,
      HOME: homeDirectory,
      USERPROFILE: homeDirectory,
      CODEX_HOME: codexHome,
    };

    result.codex_version = await readCodexVersion({
      cwd: repositoryRoot,
      environment: isolatedEnvironment,
      commandRunner,
    });
    if (!isCompatibleCodexVersion(result.codex_version)) {
      throw new Error(
        `Codex CLI ${result.codex_version} is older than ${MINIMUM_CODEX_VERSION}.`,
      );
    }
    if (
      result.expected_codex_version !== null &&
      result.codex_version !== result.expected_codex_version
    ) {
      throw new Error(
        `Expected Codex CLI ${result.expected_codex_version}, observed ${result.codex_version}.`,
      );
    }
    result.checks.push(`codex_version:${result.codex_version}`);

    await commandRunner("codex", ["--strict-config", "--help"], {
      cwd: repositoryRoot,
      environment: isolatedEnvironment,
    });
    result.strict_config_verified = true;
    result.checks.push("strict_config:verified");

    const schema = await schemaVerifier({
      environment: isolatedEnvironment,
      commandRunner,
    });
    if (!Number.isInteger(schema.generated_files) || schema.generated_files < 1) {
      throw new Error("App Server schema verification returned no generated files.");
    }
    result.app_server_schema_verified = true;
    result.schema_file_count = schema.generated_files;
    result.checks.push("app_server_schema:verified");

    const processIdentity = await processIdentityCreator();
    const processStatus = await processIdentityInspector(processIdentity);
    if (processStatus.status !== "same") {
      throw new Error(`Process identity verification returned ${processStatus.status ?? "invalid"}.`);
    }
    result.process_identity_verified = true;
    result.checks.push("process_identity:verified");

    const installOptions = {
      repositoryRoot,
      homeDirectory,
      codexHome,
      platform: platformCode,
    };
    const first = await installer(installOptions);
    const second = await installer(installOptions);
    const canonicalSkill = join(
      repositoryRoot,
      ".agents",
      "skills",
      "sol-luna-orchestration",
    );
    result.link_type = await validateInstallation({
      first,
      second,
      canonicalSkill,
      codexHome,
      platform: platformCode,
    });
    result.installation_idempotent = true;
    result.checks.push(`skill_link:${result.link_type}`);
    result.checks.push("global_install:idempotent");
  } catch (error) {
    failure = error;
  } finally {
    if (temporaryRoot !== null) {
      try {
        await removeDirectory(temporaryRoot);
        if (await pathExists(temporaryRoot)) {
          throw new Error(`Temporary directory still exists: ${temporaryRoot}`);
        }
        result.checks.push("temporary_state:removed");
      } catch (error) {
        failure = appendFailure(failure, error, "Cleanup failed: ");
      }
    }
    if (beforeStatus !== null) {
      try {
        const afterStatus = await gitStatusReader(repositoryRoot);
        result.git_unchanged = afterStatus === beforeStatus;
        if (!result.git_unchanged) {
          throw new Error("Git status changed during platform verification.");
        }
        result.checks.push("git_status:unchanged");
      } catch (error) {
        failure = appendFailure(failure, error);
      }
    }
  }

  if (failure !== null) {
    result.warnings.push(failure.message);
    return result;
  }
  result.status = "completed";
  return result;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const verify = dependencies.verifyPlatform ?? verifyPlatform;
  const outputWriter = dependencies.writeJsonOutput ?? writeJsonOutput;
  const writeStdout = dependencies.writeStdout ?? ((value) => process.stdout.write(value));
  const writeStderr = dependencies.writeStderr ?? ((value) => process.stderr.write(value));
  let options;
  let result;
  try {
    options = parseVerifyPlatformArguments(argv);
    if (options.outputPath !== null && isPathInside(REPOSITORY_ROOT, options.outputPath)) {
      throw new Error("--output must be outside the repository so platform verification leaves Git unchanged.");
    }
    result = await verify(options);
  } catch (error) {
    result = createPlatformVerificationResult({
      platform: getPlatformName(),
      warnings: [error.message],
    });
  }

  if (options?.outputPath && !isPathInside(REPOSITORY_ROOT, options.outputPath)) {
    try {
      await outputWriter(options.outputPath, result);
    } catch (error) {
      result.status = "failed";
      result.warnings.push(`Output failed: ${error.message}`);
    }
  }
  writeStdout(`${JSON.stringify(result)}\n`);
  if (result.status !== "completed") {
    writeStderr(`${result.warnings.join(" ")}\n`);
    return 2;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
