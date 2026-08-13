import assert from "node:assert/strict";
import test from "node:test";
import {
  executorLaunchMessage,
  executorResultMessage,
  ultraLaunchMessage,
  ultraResultMessage,
  writeStatusMessage,
} from "../.agents/skills/sol-sol-orchestration/scripts/orchestration-messages.mjs";

test("executor messages identify a separate executor and verified routing", () => {
  assert.equal(
    executorLaunchMessage({
      profile: "explore",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      sandboxMode: "read-only",
    }),
    "Sol orchestrator: Launching a separate explore executor with gpt-5.6-sol at medium reasoning in read-only mode.",
  );
  assert.equal(
    executorResultMessage({
      status: "completed",
      profile: "explore",
      model: "gpt-5.6-sol",
      reasoning_effort: "medium",
      routing_verified: true,
    }),
    "Sol orchestrator: Executor routing verified for explore: gpt-5.6-sol at medium reasoning (routing_verified=true). Status: completed.",
  );
});

test("unverified executor messages do not claim a model or reasoning effort", () => {
  const message = executorResultMessage({
    status: "failed",
    profile: "implement",
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    routing_verified: false,
  });
  assert.equal(
    message,
    "Sol orchestrator: Executor routing was not verified for implement. Status: failed.",
  );
  assert.doesNotMatch(message, /gpt-5\.6-sol|high reasoning/);
});

test("Ultra messages identify takeover mode and recovery state", () => {
  assert.equal(
    ultraLaunchMessage({
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      sandboxMode: "read-only",
    }),
    "Sol orchestrator: Starting an exclusive Ultra takeover with gpt-5.6-sol at ultra reasoning in read-only mode.",
  );
  assert.equal(
    ultraResultMessage({
      status: "failed",
      routing_verified: false,
      warnings: ["Ultra lock is recovery-required."],
    }),
    "Sol orchestrator: Ultra routing was not verified. Status: failed. The repository lock requires recovery.",
  );
});

test("status messages use the supplied stream", () => {
  let output = "";
  writeStatusMessage("Sol orchestrator: Test message.", {
    write(value) {
      output += value;
    },
  });
  assert.equal(output, "Sol orchestrator: Test message.\n");
});
