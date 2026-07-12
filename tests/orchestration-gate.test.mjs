import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateHook,
  parseGateArguments,
} from "../.agents/skills/sol-sol-orchestration/scripts/orchestration-gate.mjs";
import { ORCHESTRATION_LOCK_ENV } from "../.agents/skills/sol-sol-orchestration/scripts/orchestration-state.mjs";

const lock = {
  lock_id: "lock-123",
  repository: "C:\\repository",
  state: "active",
};

test("gate arguments require explicit repository and recovery id", () => {
  assert.deepEqual(parseGateArguments(["status", "--cwd", "."], "C:\\repo"), {
    command: "status",
    cwd: "C:\\repo",
    lockId: null,
  });
  assert.deepEqual(
    parseGateArguments(["recover", "--cwd", ".", "--lock-id", "abc"], "C:\\repo"),
    { command: "recover", cwd: "C:\\repo", lockId: "abc" },
  );
  assert.throws(() => parseGateArguments(["status"]), /--cwd is required/);
  assert.throws(
    () => parseGateArguments(["recover", "--cwd", "."]),
    /requires --lock-id/,
  );
  assert.throws(
    () => parseGateArguments(["status", "--cwd", ".", "--cwd", "."]),
    /Duplicate option/,
  );
});

test("SessionStart reports ownership and pauses unrelated sessions", async () => {
  const owner = await evaluateHook(
    { cwd: "C:\\repository", hook_event_name: "SessionStart" },
    {
      environment: { [ORCHESTRATION_LOCK_ENV]: lock.lock_id },
      readLock: async () => lock,
    },
  );
  assert.match(owner.hookSpecificOutput.additionalContext, /owns exclusive Sol Ultra takeover/);
  const unrelated = await evaluateHook(
    { cwd: "C:\\repository", hook_event_name: "SessionStart" },
    { environment: {}, readLock: async () => lock },
  );
  assert.match(unrelated.hookSpecificOutput.additionalContext, /is paused/);
});

test("PreToolUse allows the owner and denies other sessions", async () => {
  const input = {
    cwd: "C:\\repository",
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
  };
  assert.equal(
    await evaluateHook(input, {
      environment: { [ORCHESTRATION_LOCK_ENV]: lock.lock_id },
      readLock: async () => lock,
    }),
    null,
  );
  const blocked = await evaluateHook(input, {
    environment: {},
    readLock: async () => lock,
  });
  assert.equal(blocked.hookSpecificOutput.permissionDecision, "deny");
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /lock-123/);
});

test("recovery-required state denies tools even with the former lock id", async () => {
  const blocked = await evaluateHook(
    { cwd: "C:\\repository", hook_event_name: "PreToolUse", tool_name: "Bash" },
    {
      environment: { [ORCHESTRATION_LOCK_ENV]: lock.lock_id },
      readLock: async () => ({ ...lock, state: "recovery-required" }),
    },
  );
  assert.equal(blocked.hookSpecificOutput.permissionDecision, "deny");
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /recovery-required/);
});

test("hooks fail closed when orchestration state is corrupt", async () => {
  const stateError = new Error("invalid JSON");
  const blocked = await evaluateHook(
    { cwd: "C:\\repository", hook_event_name: "PreToolUse" },
    { environment: {}, readLock: async () => { throw stateError; } },
  );
  assert.equal(blocked.hookSpecificOutput.permissionDecision, "deny");
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /manual recovery/);
  const session = await evaluateHook(
    { cwd: "C:\\repository", hook_event_name: "SessionStart" },
    { environment: {}, readLock: async () => { throw stateError; } },
  );
  assert.match(session.hookSpecificOutput.additionalContext, /invalid JSON/);
});

test("hooks remain silent when no repository lock exists", async () => {
  assert.equal(
    await evaluateHook(
      { cwd: "C:\\repository", hook_event_name: "PreToolUse" },
      { environment: {}, readLock: async () => null },
    ),
    null,
  );
});
