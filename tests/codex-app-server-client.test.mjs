import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  AppServerProtocolError,
  AppServerRoutingError,
  AppServerTimeoutError,
  MINIMUM_CODEX_VERSION,
  buildAppServerArguments,
  isCompatibleCodexVersion,
  normalizeAppServerServiceTier,
  runAppServerTurn,
} from "../.agents/skills/sol-luna-orchestration/scripts/codex-app-server-client.mjs";
import { loadExecutorResultContract } from "../.agents/skills/sol-luna-orchestration/scripts/executor-result-contract.mjs";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER_PATH = join(TEST_DIRECTORY, "fixtures", "mock-codex-app-server.mjs");
const OUTPUT_SCHEMA = (await loadExecutorResultContract()).schema;

function spawnMock(scenario, capturePath) {
  return (_command, _args, options) => spawn(process.execPath, [MOCK_SERVER_PATH], {
    ...options,
    env: {
      ...options.env,
      MOCK_APP_SERVER_SCENARIO: JSON.stringify(scenario),
      ...(capturePath === undefined ? {} : { MOCK_APP_SERVER_CAPTURE: capturePath }),
    },
  });
}

function runMock(scenario = {}, overrides = {}) {
  const serviceTier = overrides.serviceTier ?? "standard";
  return runAppServerTurn({
    command: overrides.command ?? "codex",
    cwd: resolve("."),
    environment: overrides.environment ?? process.env,
    model: overrides.model ?? scenario.model ?? "gpt-5.6-sol",
    reasoningEffort: overrides.reasoningEffort ?? scenario.effort ?? "high",
    serviceTier,
    configuredServiceTier: serviceTier === "fast" ? "fast" : "default",
    fastMode: serviceTier === "fast",
    configurationOverrides: overrides.configurationOverrides ?? [],
    sandboxMode: overrides.sandboxMode ?? "read-only",
    developerInstructions: "Act as a bounded executor.",
    briefing: "Complete the bounded test task.",
    outputSchema: OUTPUT_SCHEMA,
    timeoutMs: overrides.timeoutMs ?? 2_000,
    platform: overrides.platform ?? process.platform,
    architecture: overrides.architecture ?? process.arch,
    commandResolver: overrides.commandResolver
      ?? (async (command, { environment }) => ({ executable: command, environment })),
    spawnImplementation: overrides.spawnImplementation
      ?? spawnMock(scenario, overrides.capturePath),
    onProcessStarted: overrides.onProcessStarted,
  });
}

test("App Server arguments pin local orchestration safeguards without exec fallback", () => {
  const args = buildAppServerArguments({
    fastMode: true,
    configuredServiceTier: "fast",
    configurationOverrides: ['mcp_servers.playwright.default_tools_approval_mode="approve"'],
  });
  assert.ok(args.includes('model_verbosity="low"'));
  assert.ok(args.includes('service_tier="fast"'));
  assert.ok(args.includes("features.fast_mode=true"));
  assert.ok(args.includes("features.multi_agent=false"));
  assert.ok(args.includes("agents.max_depth=1"));
  assert.ok(args.includes("agents.max_threads=1"));
  assert.ok(args.includes('mcp_servers.playwright.default_tools_approval_mode="approve"'));
  assert.deepEqual(args.slice(-3), ["app-server", "--listen", "stdio://"]);
  assert.equal(args.includes("exec"), false);
  assert.equal(args.includes("--json"), false);
});

test("App Server launches the resolved native Codex executable", async () => {
  const environment = { PATH: "C:\\npm" };
  const nativeExecutable = "C:\\npm\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
  const baseSpawn = spawnMock({});
  let invocation = null;
  const result = await runMock({}, {
    platform: "win32",
    architecture: "x64",
    environment,
    configurationOverrides: ['mcp_servers.playwright.default_tools_approval_mode="approve"'],
    commandResolver: async (command, options) => {
      assert.equal(command, "codex");
      assert.equal(options.platform, "win32");
      assert.equal(options.architecture, "x64");
      assert.equal(options.environment, environment);
      return { executable: nativeExecutable, environment };
    },
    spawnImplementation: (command, args, options) => {
      invocation = { command, args, options };
      return baseSpawn(command, args, options);
    },
  });

  assert.equal(result.turnStatus, "completed");
  assert.equal(invocation.command, nativeExecutable);
  assert.ok(invocation.args.includes('mcp_servers.playwright.default_tools_approval_mode="approve"'));
  assert.deepEqual(invocation.args.slice(-3), ["app-server", "--listen", "stdio://"]);
  assert.equal(invocation.options.env, environment);
  assert.equal(invocation.options.windowsHide, true);
  assert.deepEqual(invocation.options.stdio, ["pipe", "pipe", "pipe"]);
});

test("App Server exposes its process before protocol work begins", async () => {
  let started = null;
  const result = await runMock({}, {
    onProcessStarted: async (processInfo) => {
      started = processInfo;
    },
  });
  assert.equal(result.turnStatus, "completed");
  assert.ok(Number.isInteger(started.pid));
  assert.ok(started.pid > 0);
});

test("App Server stops when process registration fails", async () => {
  await assert.rejects(
    runMock({}, {
      onProcessStarted: async () => {
        throw new Error("registration failed");
      },
    }),
    (error) => error instanceof AppServerProtocolError && /registration failed/.test(error.message),
  );
});

test("App Server reports native Codex resolution failures as protocol errors", async () => {
  await assert.rejects(
    runMock({}, {
      platform: "win32",
      commandResolver: async () => {
        throw new Error("native Codex missing");
      },
    }),
    (error) => error instanceof AppServerProtocolError
      && /Unable to start Codex App Server: native Codex missing/.test(error.message),
  );
});

test("version and service tier normalization enforce the compatibility boundary", () => {
  assert.equal(MINIMUM_CODEX_VERSION, "0.147.0");
  assert.equal(isCompatibleCodexVersion("codex-cli 0.147.0"), true);
  assert.equal(isCompatibleCodexVersion("0.148.1"), true);
  assert.equal(isCompatibleCodexVersion("0.146.9"), false);
  assert.equal(isCompatibleCodexVersion("unknown"), false);
  assert.equal(normalizeAppServerServiceTier("priority"), "fast");
  assert.equal(normalizeAppServerServiceTier("default"), "standard");
  assert.equal(normalizeAppServerServiceTier(null), null);
});

test("handshake correlates responses and accepts settings notification before response", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "app-server-capture-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const capturePath = join(root, "requests.jsonl");
  const result = await runMock(
    { settingsNotificationFirst: true, terminalBeforeItem: true },
    { capturePath },
  );
  assert.equal(result.threadId, "mock-thread");
  assert.equal(result.model, "gpt-5.6-sol");
  assert.equal(result.reasoningEffort, "high");
  assert.equal(result.serviceTier, "standard");
  assert.equal(result.turnStatus, "completed");
  assert.equal(JSON.parse(result.finalResponse).status, "completed");
  const messages = (await readFile(capturePath, "utf8"))
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse);
  assert.equal(messages[0].method, "initialize");
  assert.equal(messages[0].params.capabilities.experimentalApi, true);
  assert.equal(messages.some((message) => message.method === "initialized"), true);
  assert.equal(messages.some((message) => message.method === "model/list"), true);
  const thread = messages.find((message) => message.method === "thread/start");
  assert.equal(thread.params.approvalPolicy, "never");
  const update = messages.find((message) => message.method === "thread/settings/update");
  assert.deepEqual(update.params, {
    threadId: "mock-thread",
    model: "gpt-5.6-sol",
    effort: "high",
    serviceTier: null,
  });
  const turn = messages.find((message) => message.method === "turn/start");
  assert.equal(Object.hasOwn(turn.params, "model"), false);
  assert.equal(Object.hasOwn(turn.params, "effort"), false);
  assert.equal(Object.hasOwn(turn.params, "serviceTier"), false);
  assert.deepEqual(turn.params.outputSchema, OUTPUT_SCHEMA);
});

test("the full root, profile, and Ultra routing matrix is accepted", async () => {
  for (const route of [
    ["gpt-5.6-luna", "max", "fast", "priority"],
    ["gpt-5.6-luna", "max", "standard", "default"],
    ["gpt-5.6-sol", "high", "standard", "default"],
    ["gpt-5.6-sol", "xhigh", "standard", "default"],
    ["gpt-5.6-sol", "ultra", "standard", "default"],
  ]) {
    const [model, effort, publicTier, protocolTier] = route;
    const result = await runMock(
      { model, effort, serviceTier: protocolTier },
      { model, reasoningEffort: effort, serviceTier: publicTier },
    );
    assert.equal(result.model, model);
    assert.equal(result.reasoningEffort, effort);
    assert.equal(result.serviceTier, publicTier);
  }
});

test("model/list rejects missing models, efforts, and priority support", async () => {
  await assert.rejects(
    runMock({ models: [] }),
    (error) => error instanceof AppServerRoutingError && /does not advertise gpt-5.6-sol/.test(error.message),
  );
  await assert.rejects(
    runMock({ efforts: [{ reasoningEffort: "medium" }] }),
    (error) => error instanceof AppServerRoutingError && /high effort/.test(error.message),
  );
  await assert.rejects(
    runMock(
      { model: "gpt-5.6-luna", effort: "max", serviceTiers: [], additionalSpeedTiers: [] },
      { model: "gpt-5.6-luna", reasoningEffort: "max", serviceTier: "fast" },
    ),
    (error) => error instanceof AppServerRoutingError && /priority service/.test(error.message),
  );
});

test("thread and settings contradictions preserve observed routing", async () => {
  await assert.rejects(
    runMock({ threadModel: "gpt-5.5" }),
    (error) => error instanceof AppServerRoutingError && error.actualModel === "gpt-5.5",
  );
  await assert.rejects(
    runMock({ settingsEffort: "medium" }),
    (error) =>
      error instanceof AppServerRoutingError &&
      error.actualReasoningEffort === "medium" &&
      error.actualServiceTier === "standard",
  );
  await assert.rejects(
    runMock({ settingsResult: { unexpected: true } }),
    (error) => error instanceof AppServerProtocolError && /empty result/.test(error.message),
  );
  await assert.rejects(
    runMock({ cliVersion: "0.146.9" }),
    (error) => error instanceof AppServerProtocolError && /0.147.0 or later/.test(error.message),
  );
  await assert.rejects(
    runMock({ omitSettingsNotification: true }, { timeoutMs: 100 }),
    AppServerTimeoutError,
  );
});

test("App Server approval protocols receive method-specific decline responses", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "app-server-approval-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]) {
    const capturePath = join(root, `${method.replaceAll("/", "-")}.jsonl`);
    const result = await runMock({ serverRequest: method }, { capturePath });
    assert.match(result.blockedReason, /Declined App Server approval request/);
    const messages = (await readFile(capturePath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map(JSON.parse);
    const response = messages.find((message) => message.id === 900 && message.method === undefined);
    assert.deepEqual(response.result, { decision: "decline" });
  }
});

test("permission and MCP elicitation declines satisfy their response contracts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "app-server-interaction-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    ["item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
    ["mcpServer/elicitation/request", { action: "decline", content: null }],
  ];
  for (const [method, expected] of cases) {
    const capturePath = join(root, `${method.replaceAll("/", "-")}.jsonl`);
    const result = await runMock({ serverRequest: method }, { capturePath });
    assert.match(result.blockedReason, /Declined App Server/);
    const messages = (await readFile(capturePath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map(JSON.parse);
    const response = messages.find((message) => message.id === 900 && message.method === undefined);
    assert.deepEqual(response.result, expected);
    assert.equal(response.error, undefined);
  }
});

test("blocking user input becomes durable operator requests", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "app-server-user-input-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const capturePath = join(root, "requests.jsonl");
  const result = await runMock(
    { serverRequest: "item/tool/requestUserInput" },
    { capturePath },
  );
  assert.match(result.blockedReason, /Decision: Continue\?/);
  assert.deepEqual(result.operatorRequests, [
    {
      question: "Decision: Continue?",
      choices: ["Yes", "No"],
      source: "app_server_user_input",
      sensitive: false,
    },
  ]);
  const messages = (await readFile(capturePath, "utf8"))
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse);
  const response = messages.find((message) => message.id === 900 && message.method === undefined);
  assert.deepEqual(response.result, { answers: {} });
});

test("non-blocking user input continues without answers", async () => {
  const result = await runMock({
    serverRequest: "item/tool/requestUserInput",
    continueAfterServerResponse: true,
    serverRequestParams: {
      threadId: "mock-thread",
      turnId: "mock-turn",
      itemId: "input-item",
      isBlocking: false,
      questions: [{ id: "optional", header: "Optional", question: "Add detail?", options: null }],
    },
  });
  assert.equal(result.turnStatus, "completed");
  assert.equal(result.blockedReason, null);
  assert.deepEqual(result.operatorRequests, []);
  assert.ok(result.warnings.includes("App Server non-blocking user input request was resolved without answers."));
});

test("secret and malformed user input requests fail closed without durable content", async () => {
  const secret = await runMock({
    serverRequest: "item/tool/requestUserInput",
    serverRequestParams: {
      threadId: "mock-thread",
      turnId: "mock-turn",
      itemId: "input-item",
      isBlocking: true,
      questions: [{ id: "secret", header: "Secret", question: "Token?", options: null, isSecret: true }],
    },
  });
  assert.match(secret.blockedReason, /secret input/);
  assert.deepEqual(secret.operatorRequests, []);

  const malformed = await runMock({
    serverRequest: "item/tool/requestUserInput",
    serverRequestParams: { threadId: "mock-thread", turnId: "mock-turn" },
  });
  assert.match(malformed.blockedReason, /malformed/);
  assert.deepEqual(malformed.operatorRequests, []);
});

test("tool notifications record Playwright evidence and unsafe use", async () => {
  const result = await runMock({
    toolName: "mcp__playwright__browser_snapshot",
  });
  assert.equal(result.playwrightMcpUsed, true);
  assert.equal(result.unsafePlaywrightToolUsed, false);
  const unsafe = await runMock({ toolName: "browser_run_code_unsafe" });
  assert.equal(unsafe.playwrightMcpUsed, true);
  assert.equal(unsafe.unsafePlaywrightToolUsed, true);
});

test("invalid JSON, RPC errors, and premature exits fail closed", async () => {
  await assert.rejects(
    runMock({ invalidJsonAfter: "initialize" }),
    (error) => error instanceof AppServerProtocolError && /invalid JSON/.test(error.message),
  );
  await assert.rejects(
    runMock({ rpcErrorAt: "model/list" }),
    (error) => error instanceof AppServerProtocolError && /model\/list failed/.test(error.message),
  );
  await assert.rejects(
    runMock({ exitAfter: "thread/start" }),
    (error) => error instanceof AppServerProtocolError && /exited before completion/.test(error.message),
  );
});

test("global timeout force-terminates an unresponsive App Server", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runMock(
      { hangAfter: "initialize", ignoreSigterm: true },
      { timeoutMs: 100 },
    ),
    AppServerTimeoutError,
  );
  assert.ok(Date.now() - startedAt < 3_000);
});
