import { spawn as spawnChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveCodexInvocation } from "./codex-command.mjs";

const MAX_CAPTURE_LENGTH = 32_768;
const MAX_OPERATOR_QUESTIONS = 3;
const MAX_OPERATOR_CHOICES = 20;
const FORCE_KILL_DELAY_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 600_000;
const APPROVAL_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

export const MINIMUM_CODEX_VERSION = "0.147.0";

export class AppServerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = new.target.name;
    Object.assign(this, details);
  }
}

export class AppServerProtocolError extends AppServerError {}
export class AppServerRoutingError extends AppServerError {}
export class AppServerTimeoutError extends AppServerError {}
export class AppServerIdleTimeoutError extends AppServerTimeoutError {}
export class AppServerInterruptedError extends AppServerError {}

export function createIdleWatchdog({
  idleTimeoutMs,
  onTimeout,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new AppServerProtocolError("idleTimeoutMs must be a positive number.");
  }
  if (typeof onTimeout !== "function") {
    throw new AppServerProtocolError("Idle watchdog requires an onTimeout callback.");
  }
  let timer = null;
  let active = false;
  let threadId = null;
  let turnId = null;
  let lastProgressMethod = null;
  let lastProgressAt = null;

  function stop() {
    active = false;
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  }

  function arm() {
    if (timer !== null) {
      cancel(timer);
    }
    timer = schedule(() => {
      timer = null;
      if (!active) {
        return;
      }
      active = false;
      onTimeout({
        threadId,
        turnId,
        idleTimeoutMs,
        idleDurationMs: now() - lastProgressAt,
        lastProgressMethod,
        lastProgressAt,
      });
    }, idleTimeoutMs);
    timer?.unref?.();
  }

  return {
    start(nextThreadId, nextTurnId) {
      threadId = nextThreadId;
      turnId = nextTurnId;
      lastProgressMethod = "turn/start";
      lastProgressAt = now();
      active = true;
      arm();
    },
    progress(method) {
      if (!active) {
        return;
      }
      lastProgressMethod = method;
      lastProgressAt = now();
      arm();
    },
    stop,
  };
}

function appendLimited(current, addition) {
  const combined = `${current}${addition}`;
  return combined.length <= MAX_CAPTURE_LENGTH
    ? combined
    : combined.slice(combined.length - MAX_CAPTURE_LENGTH);
}

function createDeferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function parseVersion(value) {
  const match = String(value ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match === null ? null : match.slice(1).map(Number);
}

export function isCompatibleCodexVersion(
  actualVersion,
  minimumVersion = MINIMUM_CODEX_VERSION,
) {
  const actual = parseVersion(actualVersion);
  const minimum = parseVersion(minimumVersion);
  if (actual === null || minimum === null) {
    return false;
  }
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) {
      return actual[index] > minimum[index];
    }
  }
  return true;
}

export function normalizeAppServerServiceTier(value) {
  if (["priority", "fast"].includes(value)) {
    return "fast";
  }
  if (["default", "standard"].includes(value)) {
    return "standard";
  }
  return value ?? null;
}

export function buildAppServerArguments({
  fastMode,
  configuredServiceTier,
  modelVerbosity = "low",
  configurationOverrides = [],
}) {
  const overrideArguments = configurationOverrides.flatMap((value) => ["-c", value]);
  return [
    "-c",
    `model_verbosity=${JSON.stringify(modelVerbosity)}`,
    "-c",
    `service_tier=${JSON.stringify(configuredServiceTier)}`,
    "-c",
    `features.fast_mode=${Boolean(fastMode)}`,
    "-c",
    "features.multi_agent=false",
    "-c",
    "agents.max_depth=1",
    "-c",
    "agents.max_threads=1",
    ...overrideArguments,
    "app-server",
    "--listen",
    "stdio://",
  ];
}

function modelSupportsEffort(model, effort) {
  const efforts = model.supportedReasoningEfforts ?? model.supported_reasoning_efforts;
  return Array.isArray(efforts) && efforts.some((entry) => {
    const value = typeof entry === "string" ? entry : entry?.reasoningEffort ?? entry?.effort;
    return value === effort;
  });
}

function modelSupportsPriority(model) {
  const tiers = model.serviceTiers ?? model.service_tiers;
  const speeds = model.additionalSpeedTiers ?? model.additional_speed_tiers;
  return (
    (Array.isArray(tiers) && tiers.some((entry) => (entry?.id ?? entry) === "priority")) ||
    (Array.isArray(speeds) && speeds.some((entry) => (entry?.id ?? entry) === "fast"))
  );
}

function findModel(modelListResult, modelName) {
  const models = modelListResult?.data ?? modelListResult?.models;
  if (!Array.isArray(models)) {
    throw new AppServerProtocolError("model/list did not return a model collection.");
  }
  return models.find((model) =>
    [model?.id, model?.model, model?.slug].includes(modelName),
  );
}

function requestDetail(params) {
  return typeof params?.reason === "string" && params.reason.length > 0
    ? ` Reason: ${params.reason.slice(0, 1_000)}`
    : "";
}

function invalidServerRequest(method, message) {
  return {
    response: { error: { code: -32602, message } },
    blockedReason: `Rejected malformed App Server request ${method}.`,
    operatorRequests: [],
    warnings: [],
  };
}

function validRequestEnvelope(params, { item = true, turn = true } = {}) {
  return (
    params !== null &&
    typeof params === "object" &&
    !Array.isArray(params) &&
    typeof params.threadId === "string" &&
    (!turn || typeof params.turnId === "string") &&
    (!item || typeof params.itemId === "string")
  );
}

function normalizeUserInputQuestions(params) {
  if (
    !validRequestEnvelope(params) ||
    !Array.isArray(params.questions) ||
    params.questions.length < 1 ||
    params.questions.length > MAX_OPERATOR_QUESTIONS ||
    (params.isBlocking !== undefined && typeof params.isBlocking !== "boolean") ||
    Buffer.byteLength(JSON.stringify(params), "utf8") > MAX_CAPTURE_LENGTH
  ) {
    return null;
  }
  const normalized = [];
  for (const value of params.questions) {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof value.id !== "string" ||
      value.id.length === 0 ||
      typeof value.header !== "string" ||
      typeof value.question !== "string" ||
      value.question.trim().length === 0 ||
      (value.isSecret !== undefined && typeof value.isSecret !== "boolean") ||
      (value.isOther !== undefined && typeof value.isOther !== "boolean") ||
      !(value.options === null || value.options === undefined || Array.isArray(value.options)) ||
      (Array.isArray(value.options) && value.options.length > MAX_OPERATOR_CHOICES)
    ) {
      return null;
    }
    const choices = [];
    for (const option of value.options ?? []) {
      if (
        option === null ||
        typeof option !== "object" ||
        Array.isArray(option) ||
        typeof option.label !== "string" ||
        option.label.trim().length === 0
      ) {
        return null;
      }
      choices.push(option.label.trim());
    }
    if (value.isOther === true) {
      choices.push("Other");
    }
    normalized.push({
      question: value.header.trim().length > 0
        ? `${value.header.trim()}: ${value.question.trim()}`
        : value.question.trim(),
      choices,
      secret: value.isSecret === true,
    });
  }
  return normalized;
}

export function createServerRequestDecision(method, params) {
  if (APPROVAL_REQUEST_METHODS.has(method)) {
    if (!validRequestEnvelope(params)) {
      return invalidServerRequest(method, "Approval request parameters are invalid.");
    }
    return {
      response: { result: { decision: "decline" } },
      blockedReason: `Declined App Server approval request ${method}.${requestDetail(params)}`,
      operatorRequests: [],
      warnings: [],
    };
  }
  if (method === "item/permissions/requestApproval") {
    if (
      !validRequestEnvelope(params) ||
      typeof params.cwd !== "string" ||
      params.permissions === null ||
      typeof params.permissions !== "object" ||
      Array.isArray(params.permissions)
    ) {
      return invalidServerRequest(method, "Permission request parameters are invalid.");
    }
    return {
      response: { result: { permissions: {}, scope: "turn" } },
      blockedReason: `Declined App Server approval request ${method}.${requestDetail(params)}`,
      operatorRequests: [],
      warnings: [],
    };
  }
  if (method === "mcpServer/elicitation/request") {
    if (
      !validRequestEnvelope(params, { item: false, turn: false }) ||
      typeof params.serverName !== "string" ||
      !["form", "openai/form", "url"].includes(params.mode) ||
      typeof params.message !== "string"
    ) {
      return invalidServerRequest(method, "MCP elicitation parameters are invalid.");
    }
    return {
      response: { result: { action: "decline", content: null } },
      blockedReason: `Declined App Server interaction request ${method}.`,
      operatorRequests: [],
      warnings: [],
    };
  }
  if (method === "item/tool/requestUserInput") {
    const questions = normalizeUserInputQuestions(params);
    if (questions === null) {
      return invalidServerRequest(method, "User input request parameters are invalid.");
    }
    if (params.isBlocking === false) {
      return {
        response: { result: { answers: {} } },
        blockedReason: null,
        operatorRequests: [],
        warnings: ["App Server non-blocking user input request was resolved without answers."],
      };
    }
    if (questions.some((question) => question.secret)) {
      return {
        response: { result: { answers: {} } },
        blockedReason: "App Server requested secret input that cannot be stored by a durable executor.",
        operatorRequests: [],
        warnings: [],
      };
    }
    const operatorRequests = questions.map(({ question, choices }) => ({
      question,
      choices,
      source: "app_server_user_input",
      sensitive: false,
    }));
    return {
      response: { result: { answers: {} } },
      blockedReason: `App Server requested operator input: ${operatorRequests.map((request) => request.question).join(" | ")}`,
      operatorRequests,
      warnings: [],
    };
  }
  return {
    response: { error: { code: -32601, message: "Unsupported server request." } },
    blockedReason: `Declined unsupported App Server request ${method}.${requestDetail(params)}`,
    operatorRequests: [],
    warnings: [],
  };
}

class JsonRpcConnection {
  constructor(
    child,
    { timeoutMs, idleTimeoutMs, signal },
  ) {
    this.child = child;
    this.signal = signal;
    this.pending = new Map();
    this.notificationWaiters = [];
    this.notifications = [];
    this.nextId = 1;
    this.activeThreadId = null;
    this.stderr = "";
    this.warnings = [];
    this.agentMessages = [];
    this.operatorRequests = [];
    this.playwrightMcpUsed = false;
    this.unsafePlaywrightToolUsed = false;
    this.blocked = createDeferred();
    this.failure = createDeferred();
    this.failure.promise.catch(() => {});
    this.closing = false;
    this.closed = false;
    this.idleWatchdog = idleTimeoutMs === null
      ? null
      : createIdleWatchdog({
        idleTimeoutMs,
        onTimeout: (details) => {
          this.fail(
            new AppServerIdleTimeoutError(
              `The executor went ${idleTimeoutMs / 1_000} seconds without reporting progress for the active thread.`,
              details,
            ),
          );
        },
      });
    this.lineReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lineReader.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => {
      this.stderr = appendLimited(this.stderr, chunk.toString("utf8"));
    });
    child.stdin.on("error", (error) => {
      if (!this.closing) {
        this.fail(new AppServerProtocolError(`App Server stdin failed: ${error.message}`));
      }
    });
    child.once("error", (error) => {
      this.fail(new AppServerProtocolError(`Unable to run Codex App Server: ${error.message}`));
    });
    child.once("close", (code, processSignal) => {
      this.closed = true;
      if (!this.closing) {
        this.fail(
          new AppServerProtocolError(
            `Codex App Server exited before completion with code ${code ?? "null"} and signal ${processSignal ?? "none"}.`,
            { exitCode: code, processSignal },
          ),
        );
      }
    });
    this.abortListener = () => {
      this.fail(new AppServerInterruptedError("Codex App Server execution was interrupted."));
    };
    if (signal?.aborted) {
      this.abortListener();
    } else {
      signal?.addEventListener("abort", this.abortListener, { once: true });
    }
    this.timeout = setTimeout(() => {
      this.fail(new AppServerTimeoutError("Codex App Server execution timed out."));
    }, timeoutMs);
    this.timeout.unref();
  }

  send(message) {
    if (this.closed || this.child.stdin.destroyed) {
      throw new AppServerProtocolError("Codex App Server stdin is not available.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params = {}) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async request(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const deferred = createDeferred();
    this.pending.set(id, { method, deferred });
    this.send({ jsonrpc: "2.0", id, method, params });
    return await this.guard(deferred.promise);
  }

  waitForNotification(method, predicate = () => true) {
    const bufferedIndex = this.notifications.findIndex(
      (entry) => entry.method === method && predicate(entry.params),
    );
    if (bufferedIndex >= 0) {
      const [entry] = this.notifications.splice(bufferedIndex, 1);
      return Promise.resolve(entry.params);
    }
    const deferred = createDeferred();
    this.notificationWaiters.push({ method, predicate, deferred });
    return this.guard(deferred.promise);
  }

  async guard(promise) {
    return await Promise.race([promise, this.failure.promise]);
  }

  handleLine(line) {
    if (line.trim().length === 0) {
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.fail(new AppServerProtocolError(`App Server emitted invalid JSON: ${error.message}`));
      return;
    }
    if (Object.hasOwn(message, "id") && typeof message.method === "string") {
      this.handleServerRequest(message);
      return;
    }
    if (Object.hasOwn(message, "id")) {
      this.handleResponse(message);
      return;
    }
    if (typeof message.method === "string") {
      this.handleNotification(message);
      return;
    }
    this.fail(new AppServerProtocolError("App Server emitted an invalid JSON-RPC message."));
  }

  handleResponse(message) {
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      this.fail(new AppServerProtocolError(`App Server returned an unknown response id ${message.id}.`));
      return;
    }
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      pending.deferred.reject(
        new AppServerProtocolError(
          `${pending.method} failed: ${message.error.message ?? JSON.stringify(message.error)}.`,
          { rpcError: message.error },
        ),
      );
      return;
    }
    pending.deferred.resolve(message.result);
  }

  handleServerRequest(message) {
    const decision = createServerRequestDecision(message.method, message.params);
    this.send({
      jsonrpc: "2.0",
      id: message.id,
      ...decision.response,
    });
    this.operatorRequests.push(...decision.operatorRequests);
    this.warnings.push(...decision.warnings);
    if (decision.blockedReason !== null) {
      this.markBlocked(decision.blockedReason);
    }
  }

  handleNotification(message) {
    const entry = { method: message.method, params: message.params ?? {} };
    const belongsToActiveThread =
      this.activeThreadId === null || entry.params?.threadId === this.activeThreadId;
    if (belongsToActiveThread && entry.method.startsWith("item/")) {
      this.idleWatchdog?.progress(entry.method);
      const serialized = JSON.stringify(entry);
      if (/mcp__playwright__|"server"\s*:\s*"playwright"|"serverName"\s*:\s*"playwright"/i.test(serialized)) {
        this.playwrightMcpUsed = true;
      }
      if (/browser_run_code_unsafe/i.test(serialized)) {
        this.unsafePlaywrightToolUsed = true;
      }
    }
    if (belongsToActiveThread && entry.method === "item/completed") {
      const item = entry.params?.item;
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        this.agentMessages.push(item.text);
      }
      if (item?.type === "error") {
        const errorMessage = item.message ?? item.text;
        if (typeof errorMessage === "string") {
          this.warnings.push(errorMessage);
        }
      }
    }
    if (belongsToActiveThread && entry.method === "turn/completed") {
      this.idleWatchdog?.stop();
    }
    const waiterIndex = this.notificationWaiters.findIndex(
      (waiter) => waiter.method === entry.method && waiter.predicate(entry.params),
    );
    if (waiterIndex >= 0) {
      const [waiter] = this.notificationWaiters.splice(waiterIndex, 1);
      waiter.deferred.resolve(entry.params);
      return;
    }
    this.notifications.push(entry);
    if (this.notifications.length > 200) {
      this.notifications.shift();
    }
  }

  markBlocked(reason) {
    if (!this.blocked.settled) {
      this.idleWatchdog?.stop();
      this.blocked.settled = true;
      this.blocked.resolve(reason);
    }
  }

  fail(error) {
    if (this.closing || this.failure.settled) {
      return;
    }
    this.idleWatchdog?.stop();
    this.failure.settled = true;
    this.failure.reject(error);
    for (const { deferred } of this.pending.values()) {
      deferred.reject(error);
    }
    this.pending.clear();
    for (const { deferred } of this.notificationWaiters) {
      deferred.reject(error);
    }
    this.notificationWaiters = [];
  }

  async interruptTurn(threadId, turnId) {
    if (typeof threadId !== "string" || typeof turnId !== "string") {
      return;
    }
    try {
      await this.request("turn/interrupt", { threadId, turnId });
    } catch (error) {
      this.warnings.push(`Unable to interrupt blocked turn: ${error.message}`);
    }
  }

  async close() {
    if (this.closing) {
      return;
    }
    this.closing = true;
    clearTimeout(this.timeout);
    this.idleWatchdog?.stop();
    this.signal?.removeEventListener("abort", this.abortListener);
    this.lineReader.close();
    if (this.closed) {
      return;
    }
    const closed = new Promise((resolvePromise) => {
      this.child.once("close", resolvePromise);
    });
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    const forceKillTimer = setTimeout(() => {
      if (!this.closed) {
        this.child.kill("SIGKILL");
      }
    }, FORCE_KILL_DELAY_MS);
    forceKillTimer.unref();
    await closed;
    clearTimeout(forceKillTimer);
  }
}

function validateModelCapability(modelListResult, expected) {
  const model = findModel(modelListResult, expected.model);
  if (model === undefined) {
    throw new AppServerRoutingError(
      `App Server model/list does not advertise ${expected.model}.`,
    );
  }
  if (!modelSupportsEffort(model, expected.reasoningEffort)) {
    throw new AppServerRoutingError(
      `App Server model/list does not advertise ${expected.reasoningEffort} effort for ${expected.model}.`,
    );
  }
  if (expected.serviceTier === "fast" && !modelSupportsPriority(model)) {
    throw new AppServerRoutingError(
      `App Server model/list does not advertise priority service for ${expected.model}.`,
    );
  }
}

function validateThreadStart(result, expected, minimumVersion) {
  const thread = result?.thread;
  if (thread === null || typeof thread !== "object") {
    throw new AppServerProtocolError("thread/start did not return a thread.");
  }
  if (typeof thread.id !== "string" || thread.id.length === 0) {
    throw new AppServerProtocolError("thread/start did not return a thread id.");
  }
  if (!isCompatibleCodexVersion(thread.cliVersion, minimumVersion)) {
    throw new AppServerProtocolError(
      `Codex CLI ${thread.cliVersion ?? "unknown"} is incompatible; ${minimumVersion} or later is required.`,
      { threadId: thread.id },
    );
  }
  const actualModel = result.model ?? null;
  const actualTier = normalizeAppServerServiceTier(result.serviceTier);
  const tierMatches =
    expected.serviceTier === "standard"
      ? actualTier === null || actualTier === "standard"
      : actualTier === expected.serviceTier;
  if (actualModel !== expected.model || !tierMatches) {
    throw new AppServerRoutingError(
      `thread/start routing mismatch: expected ${expected.model}/${expected.serviceTier}, received ${actualModel}/${actualTier ?? "null"}.`,
      {
        threadId: thread.id,
        actualModel,
        actualServiceTier: actualTier,
      },
    );
  }
  return thread;
}

function validateSettingsNotification(params, threadId, expected) {
  const settings = params?.threadSettings;
  const actualThreadId = params?.threadId ?? settings?.threadId;
  if (actualThreadId !== threadId || settings === null || typeof settings !== "object") {
    throw new AppServerProtocolError(
      "thread/settings/updated did not contain matching thread settings.",
      { threadId },
    );
  }
  const actualModel = settings.model ?? null;
  const actualReasoningEffort = settings.effort ?? null;
  const actualServiceTier = normalizeAppServerServiceTier(settings.serviceTier);
  if (
    actualModel !== expected.model ||
    actualReasoningEffort !== expected.reasoningEffort ||
    actualServiceTier !== expected.serviceTier
  ) {
    throw new AppServerRoutingError(
      `thread/settings/updated routing mismatch: expected ${expected.model}/${expected.reasoningEffort}/${expected.serviceTier}, received ${actualModel}/${actualReasoningEffort}/${actualServiceTier}.`,
      {
        threadId,
        actualModel,
        actualReasoningEffort,
        actualServiceTier,
      },
    );
  }
  return { model: actualModel, reasoningEffort: actualReasoningEffort, serviceTier: actualServiceTier };
}

function validateEmptySettingsResult(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length > 0) {
    throw new AppServerProtocolError("thread/settings/update did not return an empty result.");
  }
}

export async function runAppServerTurn({
  command = "codex",
  cwd,
  environment = process.env,
  model,
  reasoningEffort,
  serviceTier,
  configuredServiceTier,
  fastMode,
  configurationOverrides = [],
  sandboxMode,
  developerInstructions,
  briefing,
  outputSchema,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  idleTimeoutMs = null,
  signal,
  platform = process.platform,
  architecture = process.arch,
  commandResolver = resolveCodexInvocation,
  spawnImplementation = spawnChildProcess,
  minimumVersion = MINIMUM_CODEX_VERSION,
  onProcessStarted,
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AppServerProtocolError("timeoutMs must be a positive number.");
  }
  if (idleTimeoutMs !== null && (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0)) {
    throw new AppServerProtocolError("idleTimeoutMs must be null or a positive number.");
  }
  const expected = { model, reasoningEffort, serviceTier };
  const protocolTier = serviceTier === "fast" ? "priority" : null;
  const args = buildAppServerArguments({
    fastMode,
    configuredServiceTier,
    configurationOverrides,
  });
  let child;
  try {
    const invocation = await commandResolver(command, {
      platform,
      architecture,
      environment,
    });
    child = spawnImplementation(invocation.executable, args, {
      cwd,
      env: invocation.environment,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new AppServerProtocolError(`Unable to start Codex App Server: ${error.message}`);
  }
  const connection = new JsonRpcConnection(child, {
    timeoutMs,
    idleTimeoutMs,
    signal,
  });
  let threadId = null;
  let turnId = null;
  let effectiveRouting = null;
  try {
    if (typeof onProcessStarted === "function") {
      if (!Number.isInteger(child.pid) || child.pid < 1) {
        throw new AppServerProtocolError("Codex App Server did not expose a valid process id.");
      }
      await onProcessStarted({ pid: child.pid });
    }
    await connection.request("initialize", {
      clientInfo: { name: "sol-luna-orchestration", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    connection.notify("initialized", {});
    const modelList = await connection.request("model/list", {
      includeHidden: true,
      limit: 100,
    });
    validateModelCapability(modelList, expected);
    const started = await connection.request("thread/start", {
      model,
      cwd,
      sandbox: sandboxMode,
      approvalPolicy: "never",
      developerInstructions,
      serviceTier: protocolTier,
    });
    const thread = validateThreadStart(started, expected, minimumVersion);
    threadId = thread.id;
    connection.activeThreadId = threadId;
    const settingsNotification = connection.waitForNotification(
      "thread/settings/updated",
      (params) => (params?.threadId ?? params?.threadSettings?.threadId) === threadId,
    );
    const settingsResult = await connection.request("thread/settings/update", {
      threadId,
      model,
      effort: reasoningEffort,
      serviceTier: protocolTier,
    });
    validateEmptySettingsResult(settingsResult);
    effectiveRouting = validateSettingsNotification(
      await settingsNotification,
      threadId,
      expected,
    );
    const terminalNotification = connection.waitForNotification(
      "turn/completed",
      (params) => params?.threadId === threadId,
    );
    const turnResult = await connection.request("turn/start", {
      threadId,
      input: [{ type: "text", text: briefing }],
      outputSchema,
    });
    turnId = turnResult?.turn?.id ?? null;
    if (typeof turnId !== "string") {
      throw new AppServerProtocolError("turn/start did not return a turn id.", { threadId });
    }
    connection.idleWatchdog?.start(threadId, turnId);
    const completion = await Promise.race([
      terminalNotification.then((params) => ({ type: "terminal", params })),
      connection.blocked.promise.then((reason) => ({ type: "blocked", reason })),
      connection.failure.promise,
    ]);
    let blockedReason = null;
    let turnStatus = null;
    if (completion.type === "blocked") {
      blockedReason = completion.reason;
      await connection.interruptTurn(threadId, turnId);
      turnStatus = "interrupted";
    } else {
      turnStatus = completion.params?.turn?.status ?? completion.params?.status ?? null;
    }
    return {
      threadId,
      model: effectiveRouting.model,
      reasoningEffort: effectiveRouting.reasoningEffort,
      serviceTier: effectiveRouting.serviceTier,
      turnStatus,
      finalResponse: connection.agentMessages.at(-1) ?? null,
      blockedReason,
      operatorRequests: connection.operatorRequests,
      playwrightMcpUsed: connection.playwrightMcpUsed,
      unsafePlaywrightToolUsed: connection.unsafePlaywrightToolUsed,
      warnings: connection.warnings,
      stderr: connection.stderr,
    };
  } catch (error) {
    if (error instanceof AppServerError) {
      error.threadId ??= threadId;
      error.stderr ??= connection.stderr;
      error.settingsRoutingVerified ??= effectiveRouting !== null;
      error.actualModel ??= effectiveRouting?.model ?? null;
      error.actualReasoningEffort ??= effectiveRouting?.reasoningEffort ?? null;
      error.actualServiceTier ??= effectiveRouting?.serviceTier ?? null;
      throw error;
    }
    throw new AppServerProtocolError(error.message, {
      threadId,
      stderr: connection.stderr,
      settingsRoutingVerified: effectiveRouting !== null,
      actualModel: effectiveRouting?.model ?? null,
      actualReasoningEffort: effectiveRouting?.reasoningEffort ?? null,
      actualServiceTier: effectiveRouting?.serviceTier ?? null,
    });
  } finally {
    await connection.close();
  }
}
