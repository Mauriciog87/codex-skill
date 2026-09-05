import assert from "node:assert/strict";
import test from "node:test";
import {
  colorizeStatus,
  executorLaunchMessage,
  executorResultMessage,
  shouldUseColor,
  ultraLaunchMessage,
  ultraResultMessage,
  writeStatusMessage,
} from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-messages.mjs";

test("executor messages identify the complete verified route", () => {
  assert.equal(
    executorLaunchMessage({
      profile: "playwright",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      serviceTier: "standard",
      sandboxMode: "read-only",
    }),
    "◆ PLAYWRIGHT · GPT-5.6-LUNA · MAX · STANDARD · READ-ONLY",
  );
  assert.equal(
    executorResultMessage({
      status: "completed",
      profile: "explore",
      model: "gpt-5.6-luna",
      reasoning_effort: "max",
      service_tier: "fast",
      sandbox_mode: "read-only",
      routing_verified: true,
    }),
    "Astra-Luna orchestrator: explore task completed. Routing: verified (gpt-5.6-luna, max reasoning, fast tier, read-only).",
  );
});

test("unverified executor messages do not claim route metadata", () => {
  const message = executorResultMessage({
    status: "failed",
    profile: "implement",
    model: "gpt-6-astra",
    reasoning_effort: "high",
    service_tier: "standard",
    routing_verified: false,
  });
  assert.equal(
    message,
    "Astra-Luna orchestrator: implement task failed. Routing: not verified. See blockers and warnings in the JSON result.",
  );
  assert.doesNotMatch(message, /gpt-6-astra|high reasoning|standard tier/);
});

test("Ultra messages identify takeover mode and recovery state", () => {
  assert.equal(
    ultraLaunchMessage({
      model: "gpt-6-astra",
      reasoningEffort: "ultra",
      serviceTier: "standard",
      sandboxMode: "read-only",
    }),
    "◆ ULTRA · GPT-6-ASTRA · ULTRA · STANDARD · READ-ONLY",
  );
  assert.equal(
    ultraResultMessage({
      status: "failed",
      routing_verified: false,
      warnings: ["Ultra lock is recovery-required."],
    }),
    "Astra-Luna orchestrator: Ultra task failed. Routing: not verified. See blockers and warnings in the JSON result. The repository lock requires recovery. Inspect it with the orchestration gate status command before attempting recovery.",
  );
});

test("verified routing does not imply that the task completed", () => {
  for (const status of ["blocked", "failed"]) {
    const result = {
      status,
      profile: "implement",
      model: "gpt-6-astra",
      reasoning_effort: "medium",
      service_tier: "standard",
      sandbox_mode: "workspace-write",
      routing_verified: true,
    };
    const executorMessage = executorResultMessage(result);
    const ultraMessage = ultraResultMessage({ ...result, reasoning_effort: "ultra" });
    for (const message of [executorMessage, ultraMessage]) {
      assert.match(message, new RegExp(`task ${status}\\.`));
      assert.match(message, /Routing: verified/);
      assert.doesNotMatch(message, /completed|not verified/);
    }
    assert.match(executorMessage, /gpt-6-astra, medium reasoning/);
    assert.match(ultraMessage, /gpt-6-astra, ultra reasoning/);
  }
});

test("status colors respect TTY, NO_COLOR, TERM, and FORCE_COLOR", () => {
  const ttyStream = { isTTY: true, write() {} };
  const plainStream = { isTTY: false, write() {} };
  assert.equal(shouldUseColor(ttyStream, {}), true);
  assert.equal(shouldUseColor(ttyStream, { NO_COLOR: "1" }), false);
  assert.equal(shouldUseColor(ttyStream, { TERM: "dumb" }), false);
  assert.equal(shouldUseColor(plainStream, { FORCE_COLOR: "1" }), true);
  assert.equal(colorizeStatus("route", 94, { stream: ttyStream, environment: {} }), "\u001b[94mroute\u001b[0m");

  let output = "";
  const stream = {
    isTTY: true,
    write(value) {
      output += value;
    },
  };
  writeStatusMessage("route", stream, { colorCode: 94, environment: {} });
  assert.equal(output, "\u001b[94mroute\u001b[0m\n");
});
