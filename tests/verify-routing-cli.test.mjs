import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  main,
  parseVerifyRoutingArguments,
  verifyOutputSchemaLive,
} from "../scripts/verify-routing.mjs";
import { loadExecutorResultContract } from "../.agents/skills/sol-luna-orchestration/scripts/executor-result-contract.mjs";

test("verify-live accepts only one output path", () => {
  assert.deepEqual(parseVerifyRoutingArguments([]), { outputPath: null, schemaOnly: false });
  assert.deepEqual(parseVerifyRoutingArguments(["--schema-only"]), {
    outputPath: null,
    schemaOnly: true,
  });
  assert.throws(() => parseVerifyRoutingArguments(["--output"]), /requires a path/);
  assert.throws(
    () => parseVerifyRoutingArguments(["--output", "one.json", "--output", "two.json"]),
    /only once/,
  );
  assert.throws(
    () => parseVerifyRoutingArguments(["--schema-only", "--schema-only"]),
    /only once/,
  );
  assert.throws(() => parseVerifyRoutingArguments(["--unknown"]), /Unknown argument/);
});

test("verify-live schema-only dispatches only the bounded schema verifier", async () => {
  const result = {
    status: "completed",
    mode: "schema-only",
    executor_output_schema_sha256: "f".repeat(64),
  };
  let fullInvoked = false;
  let schemaInvoked = false;
  let stdout = "";
  const code = await main(["--schema-only"], {
    verifyRouting: async () => {
      fullInvoked = true;
      throw new Error("full verification must not run");
    },
    verifyOutputSchemaLive: async () => {
      schemaInvoked = true;
      return result;
    },
    writeJsonOutput: async () => {},
    writeStdout: (value) => {
      stdout += value;
    },
    writeStderr: () => {},
  });
  assert.equal(code, 0);
  assert.equal(fullInvoked, false);
  assert.equal(schemaInvoked, true);
  assert.deepEqual(JSON.parse(stdout), result);
});

test("schema-only live verification preserves the checkout and reports the exact contract", async () => {
  const productionContract = await loadExecutorResultContract();
  const result = await verifyOutputSchemaLive("C:\\repository", {
    platform: "win32",
    gitStatusReader: async () => "",
    codexVersionReader: async () => "0.151.0",
    outputContractLoader: async () => productionContract,
    sessionRoots: ["C:\\sessions"],
    rootProbeRunner: async (sessionRoots, outputContract) => {
      assert.deepEqual(sessionRoots, ["C:\\sessions"]);
      assert.equal(outputContract.schema, productionContract.schema);
      return {
        threadId: "thread-id",
        routing: {
          model: "gpt-5.6-sol",
          reasoningEffort: "xhigh",
          serviceTier: "standard",
        },
        payload: {
          status: "completed",
          summary: "Sol routing probe completed",
          changed_files: [],
          checks: [],
          blockers: [],
          warnings: [],
          operator_requests: [],
        },
      };
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.mode, "schema-only");
  assert.equal(result.executor_output_schema_sha256, productionContract.sha256);
  assert.equal(result.git_unchanged, true);
  assert.equal(result.root.thread_id, "thread-id");
});

test("schema-only live verification rejects an invalid probe payload", async () => {
  const outputContract = await loadExecutorResultContract();
  await assert.rejects(
    verifyOutputSchemaLive("C:\\repository", {
      platform: "win32",
      gitStatusReader: async () => "",
      codexVersionReader: async () => "0.151.0",
      outputContractLoader: async () => outputContract,
      rootProbeRunner: async () => ({
        threadId: "thread-id",
        routing: {
          model: "gpt-5.6-sol",
          reasoningEffort: "xhigh",
          serviceTier: "standard",
        },
        payload: {
          status: "completed",
          summary: "invalid",
          changed_files: [],
          checks: [],
          blockers: [],
          warnings: [],
        },
      }),
    }),
    /operator_requests/,
  );
});

test("verify-live writes its preserved result with platform metadata", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "verify-live-output-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = join(root, "live.json");
  const result = {
    status: "completed",
    platform: "linux",
    architecture: "x64",
    node_version: "v22.0.0",
    codex_version: "0.147.0",
    root: {},
    executors: [],
  };
  let stdout = "";
  let stderr = "";
  const code = await main(["--output", outputPath], {
    verifyRouting: async () => result,
    writeStdout: (value) => {
      stdout += value;
    },
    writeStderr: (value) => {
      stderr += value;
    },
  });
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), result);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), result);
});

test("verify-live returns code 2 and writes failure evidence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "verify-live-failure-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = join(root, "live.json");
  let stderr = "";
  const code = await main(["--output", outputPath], {
    verifyRouting: async () => {
      throw new Error("sandbox unavailable");
    },
    writeStdout: () => {},
    writeStderr: (value) => {
      stderr += value;
    },
  });
  assert.equal(code, 2);
  const result = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(result.status, "failed");
  assert.match(result.summary, /sandbox unavailable/);
  assert.match(stderr, /sandbox unavailable/);
});
