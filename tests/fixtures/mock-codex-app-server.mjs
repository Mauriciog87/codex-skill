import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const scenario = JSON.parse(process.env.MOCK_APP_SERVER_SCENARIO ?? "{}");
const capturePath = process.env.MOCK_APP_SERVER_CAPTURE;
const threadId = scenario.threadId ?? "mock-thread";
const turnId = scenario.turnId ?? "mock-turn";
const model = scenario.model ?? "gpt-6-astra";
const effort = scenario.effort ?? "high";
const serviceTier = scenario.serviceTier ?? "default";
const payload = scenario.payload ?? {
  status: "completed",
  summary: "Mock task completed.",
  changed_files: [],
  checks: [],
  blockers: [],
  warnings: [],
  operator_requests: [],
};

if (scenario.ignoreSigterm === true) {
  process.on("SIGTERM", () => {});
}

async function capture(message) {
  if (capturePath !== undefined) {
    await appendFile(capturePath, `${JSON.stringify(message)}\n`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function notification(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function settingsNotification() {
  notification("thread/settings/updated", {
    threadId,
    threadSettings: {
      model: scenario.settingsModel ?? model,
      effort: scenario.settingsEffort ?? effort,
      serviceTier: scenario.settingsServiceTier ?? serviceTier,
    },
  });
}

function defaultServerRequestParams(method) {
  const itemId = "server-request-item";
  if (method === "item/permissions/requestApproval") {
    return {
      threadId,
      turnId,
      itemId,
      environmentId: null,
      cwd: process.cwd(),
      reason: "Mock permission request",
      permissions: {},
      startedAtMs: 1,
    };
  }
  if (method === "mcpServer/elicitation/request") {
    return {
      threadId,
      turnId,
      serverName: "playwright",
      mode: "form",
      message: "Mock elicitation",
      requestedSchema: { type: "object", properties: {} },
    };
  }
  if (method === "item/tool/requestUserInput") {
    return {
      threadId,
      turnId,
      itemId,
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: "decision",
          header: "Decision",
          question: "Continue?",
          options: [
            { label: "Yes", description: "Continue the task." },
            { label: "No", description: "Stop the task." },
          ],
          isOther: false,
          isSecret: false,
        },
      ],
    };
  }
  return { threadId, turnId, itemId, reason: "Mock approval request" };
}

function completeTurn() {
  if (scenario.toolName !== undefined) {
    notification("item/started", {
      threadId,
      turnId,
      item: {
        type: "mcpToolCall",
        server: "playwright",
        tool: scenario.toolName,
      },
    });
  }
  const item = {
    type: "agentMessage",
    id: "message-1",
    text: scenario.finalResponse ?? JSON.stringify(payload),
    phase: "final_answer",
  };
  const emitItem = () => notification("item/completed", { threadId, turnId, item });
  const emitTerminal = () => notification("turn/completed", {
    threadId,
    turn: { id: turnId, status: scenario.turnStatus ?? "completed" },
  });
  if (scenario.terminalBeforeItem === true) {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: scenario.turnStatus ?? "completed" } },
      })}\n${JSON.stringify({
        jsonrpc: "2.0",
        method: "item/completed",
        params: { threadId, turnId, item },
      })}\n`,
    );
  } else {
    emitItem();
    emitTerminal();
  }
}

function runTurn() {
  for (const event of scenario.turnEvents ?? []) {
    setTimeout(() => {
      notification(event.method, {
        threadId: event.threadId ?? threadId,
        turnId: event.turnId ?? turnId,
        ...(event.params ?? {}),
      });
    }, event.delayMs);
  }
  if (scenario.stallAfterTurnStart === true) {
    return;
  }
  if (Number.isFinite(scenario.completeAfterMs)) {
    setTimeout(completeTurn, scenario.completeAfterMs);
    return;
  }
  completeTurn();
}

async function handle(message) {
  await capture(message);
  if (scenario.invalidJsonAfter !== undefined && scenario.invalidJsonAfter === message.method) {
    process.stdout.write("not-json\n");
    return;
  }
  if (scenario.exitAfter !== undefined && scenario.exitAfter === message.method) {
    process.exit(7);
  }
  if (scenario.hangAfter !== undefined && scenario.hangAfter === message.method) {
    return;
  }
  if (message.method === "initialize") {
    result(message.id, { serverInfo: { name: "mock", version: "1" } });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (scenario.rpcErrorAt !== undefined && scenario.rpcErrorAt === message.method) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Simulated RPC error" },
    });
    return;
  }
  if (message.method === "model/list") {
    result(message.id, {
      data: scenario.models ?? [
        {
          id: model,
          supportedReasoningEfforts: scenario.efforts ?? [{ reasoningEffort: effort }],
          serviceTiers: scenario.serviceTiers ?? [{ id: "priority" }],
          additionalSpeedTiers: scenario.additionalSpeedTiers ?? ["fast"],
        },
      ],
    });
    return;
  }
  if (message.method === "config/read") {
    result(message.id, { config: scenario.config ?? { model: "gpt-6-astra" } });
    return;
  }
  if (message.method === "thread/start") {
    result(message.id, {
      model: scenario.threadModel ?? model,
      serviceTier: scenario.threadServiceTier ?? message.params.serviceTier,
      thread: {
        id: threadId,
        cliVersion: scenario.cliVersion ?? "0.147.0",
      },
    });
    return;
  }
  if (message.method === "thread/settings/update") {
    if (scenario.omitSettingsNotification === true) {
      result(message.id, scenario.settingsResult ?? {});
      return;
    }
    if (scenario.settingsNotificationFirst === true) {
      settingsNotification();
      result(message.id, scenario.settingsResult ?? {});
    } else {
      result(message.id, scenario.settingsResult ?? {});
      settingsNotification();
    }
    return;
  }
  if (message.method === "turn/start") {
    result(message.id, { turn: { id: turnId, status: "inProgress" } });
    if (scenario.serverRequest !== undefined) {
      send({
        jsonrpc: "2.0",
        id: 900,
        method: scenario.serverRequest,
        params: scenario.serverRequestParams ?? defaultServerRequestParams(scenario.serverRequest),
      });
      return;
    }
    runTurn();
    return;
  }
  if (message.method === "turn/interrupt") {
    result(message.id, {});
    notification("turn/completed", {
      threadId,
      turn: { id: turnId, status: "interrupted" },
    });
    return;
  }
  if (message.id === 900) {
    if (scenario.hangAfterServerResponse === true) {
      return;
    }
    notification("serverRequest/resolved", { threadId, requestId: "900" });
    if (scenario.continueAfterServerResponse === true) {
      completeTurn();
    }
  }
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of reader) {
  if (line.trim().length > 0) {
    await handle(JSON.parse(line));
  }
}
