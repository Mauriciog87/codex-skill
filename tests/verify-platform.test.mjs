import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MINIMUM_CODEX_VERSION } from "../.agents/skills/sol-luna-orchestration/scripts/codex-app-server-client.mjs";
import { getSkillLinkType } from "../scripts/install-global-orchestration.mjs";
import {
  createPlatformVerificationResult,
  main,
  parseVerifyPlatformArguments,
  verifyPlatform,
} from "../scripts/verify-platform.mjs";

function createCommandRunner(version = MINIMUM_CODEX_VERSION) {
  return async (command, args) => {
    assert.equal(command, "codex");
    if (args.length === 1 && args[0] === "--version") {
      return { stdout: `codex-cli ${version}\n`, stderr: "" };
    }
    assert.deepEqual(args, ["--strict-config", "--help"]);
    return { stdout: "Codex help", stderr: "" };
  };
}

function schemaVerifier(fileCount = 3) {
  return async () => ({ cli_minimum: MINIMUM_CODEX_VERSION, generated_files: fileCount });
}

test("verify-platform arguments are strict and deterministic", () => {
  assert.deepEqual(parseVerifyPlatformArguments([]), {
    expectedCodexVersion: null,
    outputPath: null,
  });
  assert.equal(
    parseVerifyPlatformArguments(["--expected-codex-version", "0.147.0"])
      .expectedCodexVersion,
    "0.147.0",
  );
  assert.throws(
    () => parseVerifyPlatformArguments(["--expected-codex-version"]),
    /requires a value/,
  );
  assert.throws(
    () =>
      parseVerifyPlatformArguments([
        "--expected-codex-version",
        "0.147.0",
        "--expected-codex-version",
        "0.147.0",
      ]),
    /only once/,
  );
  assert.throws(
    () => parseVerifyPlatformArguments(["--expected-codex-version", "latest"]),
    /major\.minor\.patch/,
  );
  assert.throws(
    () => parseVerifyPlatformArguments(["--output", "one.json", "--output", "two.json"]),
    /only once/,
  );
  assert.throws(() => parseVerifyPlatformArguments(["--unknown"]), /Unknown argument/);
});

test("platform result property order remains stable", () => {
  assert.deepEqual(Object.keys(createPlatformVerificationResult()), [
    "status",
    "platform",
    "architecture",
    "node_version",
    "codex_version",
    "minimum_codex_version",
    "expected_codex_version",
    "link_type",
    "strict_config_verified",
    "app_server_schema_verified",
    "schema_file_count",
    "process_identity_verified",
    "installation_idempotent",
    "git_unchanged",
    "checks",
    "warnings",
  ]);
});

test("platform smoke installs twice and verifies the native link", async () => {
  const result = await verifyPlatform(
    { expectedCodexVersion: MINIMUM_CODEX_VERSION },
    {
      commandRunner: createCommandRunner(),
      schemaVerifier: schemaVerifier(7),
    },
  );
  assert.equal(result.status, "completed");
  assert.equal(result.codex_version, MINIMUM_CODEX_VERSION);
  assert.equal(result.link_type, getSkillLinkType());
  assert.equal(result.strict_config_verified, true);
  assert.equal(result.app_server_schema_verified, true);
  assert.equal(result.schema_file_count, 7);
  assert.equal(result.process_identity_verified, true);
  assert.equal(result.installation_idempotent, true);
  assert.equal(result.git_unchanged, true);
  assert.deepEqual(result.warnings, []);
});

test("platform smoke fails closed on version, strict config, and schema errors", async () => {
  const unsupported = await verifyPlatform({}, { platform: "freebsd" });
  assert.equal(unsupported.status, "failed");
  assert.equal(unsupported.platform, null);
  assert.match(unsupported.warnings[0], /Unsupported platform/);

  const oldVersion = await verifyPlatform(
    { expectedCodexVersion: null },
    {
      commandRunner: createCommandRunner("0.146.9"),
      schemaVerifier: schemaVerifier(),
    },
  );
  assert.equal(oldVersion.status, "failed");
  assert.match(oldVersion.warnings[0], /older than/);

  const unexpectedVersion = await verifyPlatform(
    { expectedCodexVersion: "0.147.0" },
    {
      commandRunner: createCommandRunner("0.148.0"),
      schemaVerifier: schemaVerifier(),
    },
  );
  assert.equal(unexpectedVersion.status, "failed");
  assert.match(unexpectedVersion.warnings[0], /Expected Codex CLI 0\.147\.0, observed 0\.148\.0/);

  const strictConfig = await verifyPlatform(
    {},
    {
      commandRunner: async (command, args) => {
        if (args[0] === "--version") {
          return { stdout: `codex-cli ${MINIMUM_CODEX_VERSION}`, stderr: "" };
        }
        throw new Error("strict config rejected");
      },
      schemaVerifier: schemaVerifier(),
    },
  );
  assert.equal(strictConfig.status, "failed");
  assert.match(strictConfig.warnings[0], /strict config rejected/);

  const schema = await verifyPlatform(
    {},
    {
      commandRunner: createCommandRunner(),
      schemaVerifier: async () => {
        throw new Error("schema incompatible");
      },
    },
  );
  assert.equal(schema.status, "failed");
  assert.match(schema.warnings[0], /schema incompatible/);
});

test("platform smoke removes its isolated home after a failed installation", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "platform-cleanup-parent-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const temporaryRoot = join(parent, "isolated");
  const result = await verifyPlatform(
    {},
    {
      commandRunner: createCommandRunner(),
      schemaVerifier: schemaVerifier(),
      temporaryDirectoryFactory: async () => {
        await mkdir(temporaryRoot, { recursive: true });
        return temporaryRoot;
      },
      installer: async () => {
        throw new Error("installer conflict");
      },
    },
  );
  assert.equal(result.status, "failed");
  assert.match(result.warnings[0], /installer conflict/);
  await assert.rejects(lstat(temporaryRoot), { code: "ENOENT" });
});

test("platform smoke reports cleanup failures without unlocking them silently", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "platform-cleanup-failure-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const result = await verifyPlatform(
    {},
    {
      commandRunner: createCommandRunner(),
      schemaVerifier: schemaVerifier(),
      temporaryDirectoryFactory: async () => temporaryRoot,
      removeDirectory: async () => {
        throw new Error("cleanup denied");
      },
    },
  );
  assert.equal(result.status, "failed");
  assert.match(result.warnings[0], /Cleanup failed: cleanup denied/);
});

test("verify-platform main writes identical JSON evidence and returns stable codes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "platform-main-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = join(root, "platform.json");
  const completed = createPlatformVerificationResult({
    status: "completed",
    platform: "linux",
    git_unchanged: true,
  });
  let stdout = "";
  let stderr = "";
  const completedCode = await main(["--output", outputPath], {
    verifyPlatform: async () => completed,
    writeStdout: (value) => {
      stdout += value;
    },
    writeStderr: (value) => {
      stderr += value;
    },
  });
  assert.equal(completedCode, 0);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), completed);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), completed);

  stdout = "";
  stderr = "";
  const failedCode = await main(["--unknown"], {
    writeStdout: (value) => {
      stdout += value;
    },
    writeStderr: (value) => {
      stderr += value;
    },
  });
  assert.equal(failedCode, 2);
  assert.equal(JSON.parse(stdout).status, "failed");
  assert.match(stderr, /Unknown argument/);

  stdout = "";
  stderr = "";
  const failedResult = createPlatformVerificationResult({
    platform: "windows",
    warnings: ["schema mismatch"],
  });
  const verificationCode = await main([], {
    verifyPlatform: async () => failedResult,
    writeStdout: (value) => {
      stdout += value;
    },
    writeStderr: (value) => {
      stderr += value;
    },
  });
  assert.equal(verificationCode, 2);
  assert.deepEqual(JSON.parse(stdout), failedResult);
  assert.match(stderr, /schema mismatch/);
});
