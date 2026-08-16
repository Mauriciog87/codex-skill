import { spawn as spawnChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

const MAX_CAPTURE_LENGTH = 32_768;
const FORCE_KILL_DELAY_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 600_000;

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
export class AppServerInterruptedError extends AppServerError {}

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
}) {
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

function isApprovalRequest(method) {
  return method.endsWith("/requestApproval");
}

function isPermissionApprovalRequest(method) {
  return method === "item/permissions/requestApproval";
}

function isElicitationRequest(method) {
  return method === "mcpServer/elicitation/request";
}

function isUserInputRequest(method) {
  return method === "item/tool/requestUserInput";
}

function requestDetail(params) {
  return typeof params?.reason === "string" && params.reason.length > 0
    ? ` Reason: ${params.reason.slice(0, 1_000)}`
    : "";
}

class JsonRpcConnection {
  constructor(
    child,
    { timeoutMs, signal },
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
    this.playwrightMcpUsed = false;
    this.unsafePlaywrightToolUsed = false;
    this.blocked = createDeferred();
    this.failure = createDeferred();
    this.failure.promise.catch(() => {});
    this.closing = false;
    this.closed = false;
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
    if (isPermissionApprovalRequest(message.method)) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "Permission escalation was declined." },
      });
      this.markBlocked(
        `Declined App Server approval request ${message.method}.${requestDetail(message.params)}`,
      );
      return;
    }
    if (isApprovalRequest(message.method)) {
      this.send({ jsonrpc: "2.0", id: message.id, result: { decision: "decline" } });
      this.markBlocked(
        `Declined App Server approval request ${message.method}.${requestDetail(message.params)}`,
      );
      return;
    }
    if (isElicitationRequest(message.method)) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { action: "decline", content: null },
      });
      this.markBlocked(
        `Declined App Server interaction request ${message.method}.${requestDetail(message.params)}`,
      );
      return;
    }
    if (isUserInputRequest(message.method)) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "Interactive input is unavailable." },
      });
      this.markBlocked(
        `Declined App Server interaction request ${message.method}.${requestDetail(message.params)}`,
      );
      return;
    }
    this.send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Unsupported server request." },
    });
    this.markBlocked(
      `Declined unsupported App Server request ${message.method}.${requestDetail(message.params)}`,
    );
  }

  handleNotification(message) {
    const entry = { method: message.method, params: message.params ?? {} };
    const belongsToActiveThread =
      this.activeThreadId === null || entry.params?.threadId === this.activeThreadId;
    if (belongsToActiveThread && entry.method.startsWith("item/")) {
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
      this.blocked.settled = true;
      this.blocked.resolve(reason);
    }
  }

  fail(error) {
    if (this.closing || this.failure.settled) {
      return;
    }
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
  sandboxMode,
  developerInstructions,
  briefing,
  outputSchema,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  spawnImplementation = spawnChildProcess,
  minimumVersion = MINIMUM_CODEX_VERSION,
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AppServerProtocolError("timeoutMs must be a positive number.");
  }
  const expected = { model, reasoningEffort, serviceTier };
  const protocolTier = serviceTier === "fast" ? "priority" : null;
  const args = buildAppServerArguments({ fastMode, configuredServiceTier });
  let child;
  try {
    child = spawnImplementation(command, args, {
      cwd,
      env: environment,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new AppServerProtocolError(`Unable to start Codex App Server: ${error.message}`);
  }
  const connection = new JsonRpcConnection(child, {
    timeoutMs,
    signal,
  });
  let threadId = null;
  let turnId = null;
  try {
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
    const effectiveRouting = validateSettingsNotification(
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
      playwrightMcpUsed: connection.playwrightMcpUsed,
      unsafePlaywrightToolUsed: connection.unsafePlaywrightToolUsed,
      warnings: connection.warnings,
      stderr: connection.stderr,
    };
  } catch (error) {
    if (error instanceof AppServerError) {
      error.threadId ??= threadId;
      error.stderr ??= connection.stderr;
      throw error;
    }
    throw new AppServerProtocolError(error.message, {
      threadId,
      stderr: connection.stderr,
    });
  } finally {
    await connection.close();
  }
}
