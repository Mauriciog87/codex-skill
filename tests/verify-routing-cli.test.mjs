import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  main,
  parseVerifyRoutingArguments,
  runGlobalRootProbe,
  verifyRootConfiguration,
  verifyOutputSchemaLive,
  verifyPlaywrightOnly,
} from "../scripts/verify-routing.mjs";
import { loadExecutorResultContract } from "../.agents/skills/sol-luna-orchestration/scripts/executor-result-contract.mjs";

test("root configuration verification does not require global MCP settings in the repository", () => {
  const minimal = { model: "gpt-6-astra", model_reasoning_effort: "high", plan_mode_reasoning_effort: "high", model_verbosity: "low", service_tier: "default" };
  assert.deepEqual(verifyRootConfiguration(minimal), minimal);
  assert.deepEqual(verifyRootConfiguration({ ...minimal, mcp_servers: { unrelated: { enabled: true } } }), minimal);
  assert.throws(() => verifyRootConfiguration({ ...minimal, model: "gpt-5.6-sol" }), /did not confirm model/);
});

test("root verification reads effective defaults without overrides before negotiating a turn", async () => {
  let probeDirectory;
  const calls = [];
  const configuration = {
    model: "gpt-6-astra",
    model_reasoning_effort: "high",
    plan_mode_reasoning_effort: "high",
    model_verbosity: "low",
    service_tier: "default",
  };
  const payload = { status: "completed", summary: "probe", changed_files: [], checks: [], blockers: [], warnings: [], operator_requests: [] };
  const result = await runGlobalRootProbe([], await loadExecutorResultContract(), {
    configReader: async (options) => {
      assert.deepEqual(Object.keys(options), ["cwd"]);
      probeDirectory = options.cwd;
      await assert.rejects(access(join(options.cwd, ".codex", "config.toml")), { code: "ENOENT" });
      calls.push("config");
      return configuration;
    },
    appServerRunner: async (options) => {
      assert.equal(options.model, "gpt-6-astra");
      assert.equal(options.reasoningEffort, "high");
      assert.equal(options.cwd, probeDirectory);
      calls.push("turn");
      return { threadId: "probe", turnStatus: "completed", blockedReason: null, finalResponse: JSON.stringify(payload), serviceTier: "standard" };
    },
    routingVerifier: async () => ({ model: "gpt-6-astra", reasoningEffort: "high" }),
  });
  assert.deepEqual(calls, ["config", "turn"]);
  assert.deepEqual(result.configuration, configuration);
  await assert.rejects(access(probeDirectory), { code: "ENOENT" });
});

test("correct turn overrides cannot hide missing or stale global defaults", async () => {
  const valid = { model: "gpt-6-astra", model_reasoning_effort: "high", plan_mode_reasoning_effort: "high", model_verbosity: "low", service_tier: "default" };
  for (const changed of [{ model: "gpt-5.6-sol" }, { model_reasoning_effort: "xhigh" }, { plan_mode_reasoning_effort: "xhigh" }, { model_verbosity: "medium" }, { service_tier: "fast" }, { model: undefined }]) {
    let turnStarted = false;
    let probeDirectory;
    await assert.rejects(runGlobalRootProbe([], await loadExecutorResultContract(), {
      configReader: async ({ cwd }) => { probeDirectory = cwd; return { ...valid, ...changed }; },
      appServerRunner: async () => { turnStarted = true; },
    }), /Global root configuration did not confirm/);
    assert.equal(turnStarted, false);
    await assert.rejects(access(probeDirectory), { code: "ENOENT" });
  }
});

test("verify-live accepts only one output path", () => {
  assert.deepEqual(parseVerifyRoutingArguments([]), {
    outputPath: null,
    schemaOnly: false,
    playwrightOnly: false,
  });
  assert.deepEqual(parseVerifyRoutingArguments(["--schema-only"]), {
    outputPath: null,
    schemaOnly: true,
    playwrightOnly: false,
  });
  assert.deepEqual(parseVerifyRoutingArguments(["--playwright-only"]), {
    outputPath: null,
    schemaOnly: false,
    playwrightOnly: true,
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
  assert.throws(
    () => parseVerifyRoutingArguments(["--playwright-only", "--playwright-only"]),
    /only once/,
  );
  assert.throws(
    () => parseVerifyRoutingArguments(["--schema-only", "--playwright-only"]),
    /mutually exclusive/,
  );
  assert.throws(() => parseVerifyRoutingArguments(["--unknown"]), /Unknown argument/);
});

test("verify-live playwright-only dispatches only the bounded browser verifier", async () => {
  const result = { status: "completed", mode: "playwright-only" };
  let fullInvoked = false;
  let schemaInvoked = false;
  let playwrightInvoked = false;
  let stdout = "";
  const code = await main(["--playwright-only"], {
    verifyRouting: async () => {
      fullInvoked = true;
      throw new Error("full verification must not run");
    },
    verifyOutputSchemaLive: async () => {
      schemaInvoked = true;
      throw new Error("schema verification must not run");
    },
    verifyPlaywrightOnly: async () => {
      playwrightInvoked = true;
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
  assert.equal(schemaInvoked, false);
  assert.equal(playwrightInvoked, true);
  assert.deepEqual(JSON.parse(stdout), result);
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
          model: "gpt-6-astra",
          reasoningEffort: "high",
          serviceTier: "standard",
        },
        payload: {
          status: "completed",
          summary: "Astra routing probe completed",
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
          model: "gpt-6-astra",
          reasoningEffort: "high",
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

test("playwright-only live verification preserves the checkout", async () => {
  const statuses = ["before", "before"];
  const result = await verifyPlaywrightOnly("C:\\repository", {
    platform: "win32",
    gitStatusReader: async () => statuses.shift(),
    codexVersionReader: async () => "0.151.0",
    sessionRoots: ["C:\\sessions"],
    playwrightProbeRunner: async (repositoryRoot, sessionRoots) => {
      assert.equal(repositoryRoot, "C:\\repository");
      assert.deepEqual(sessionRoots, ["C:\\sessions"]);
      return {
        profile: "playwright",
        status: "completed",
        checks: ["playwright_mcp:verified", "heading:verified", "interaction:verified"],
      };
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.mode, "playwright-only");
  assert.equal(result.codex_version, "0.151.0");
  assert.equal(result.playwright.profile, "playwright");
  assert.equal(result.git_unchanged, true);
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
