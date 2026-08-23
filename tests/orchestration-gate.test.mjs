import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  evaluateHook,
  parseGateArguments,
} from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs";
import {
  ORCHESTRATION_GENERATION_ENV,
  ORCHESTRATION_LOCK_ENV,
} from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-state.mjs";

const lock = {
  version: 2,
  lock_id: "lock-123",
  generation: 7,
  repository: "C:\\repository",
  state: "active",
};

const ownerEnvironment = {
  [ORCHESTRATION_LOCK_ENV]: lock.lock_id,
  [ORCHESTRATION_GENERATION_ENV]: String(lock.generation),
};

test("gate arguments require explicit repository and recovery id", () => {
  const repository = resolve("gate-test-repository");
  assert.deepEqual(parseGateArguments(["status", "--cwd", "."], repository), {
    command: "status",
    cwd: repository,
    lockId: null,
    limit: null,
    confirmLegacyRecovery: false,
  });
  assert.deepEqual(
    parseGateArguments(["recover", "--cwd", ".", "--lock-id", "abc"], repository),
    {
      command: "recover",
      cwd: repository,
      lockId: "abc",
      limit: null,
      confirmLegacyRecovery: false,
    },
  );
  assert.deepEqual(
    parseGateArguments(["history", "--cwd", ".", "--limit", "12"], repository),
    {
      command: "history",
      cwd: repository,
      lockId: null,
      limit: 12,
      confirmLegacyRecovery: false,
    },
  );
  assert.equal(
    parseGateArguments([
      "recover",
      "--cwd",
      ".",
      "--lock-id",
      "abc",
      "--confirm-legacy-recovery",
    ], repository).confirmLegacyRecovery,
    true,
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
      environment: ownerEnvironment,
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
      environment: ownerEnvironment,
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
      environment: ownerEnvironment,
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

test("hooks deny stale or incomplete ownership variables even without a lock", async () => {
  for (const environment of [
    ownerEnvironment,
    { [ORCHESTRATION_LOCK_ENV]: lock.lock_id },
    { [ORCHESTRATION_GENERATION_ENV]: String(lock.generation) },
  ]) {
    const blocked = await evaluateHook(
      { cwd: "C:\\repository", hook_event_name: "PreToolUse" },
      { environment, readLock: async () => null },
    );
    assert.equal(blocked.hookSpecificOutput.permissionDecision, "deny");
    assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /stale|incomplete/);
  }
});

test("hooks reject an old or future generation for the matching lock id", async () => {
  for (const generation of [lock.generation - 1, lock.generation + 1]) {
    const blocked = await evaluateHook(
      { cwd: "C:\\repository", hook_event_name: "PreToolUse" },
      {
        environment: {
          [ORCHESTRATION_LOCK_ENV]: lock.lock_id,
          [ORCHESTRATION_GENERATION_ENV]: String(generation),
        },
        readLock: async () => lock,
      },
    );
    assert.equal(blocked.hookSpecificOutput.permissionDecision, "deny");
    assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /generation/);
  }
});

test("legacy v1 owners remain compatible but are identified as unfenced", async () => {
  const legacy = { ...lock, version: 1 };
  delete legacy.generation;
  const session = await evaluateHook(
    { cwd: "C:\\repository", hook_event_name: "SessionStart" },
    {
      environment: { [ORCHESTRATION_LOCK_ENV]: legacy.lock_id },
      readLock: async () => legacy,
    },
  );
  assert.match(session.hookSpecificOutput.additionalContext, /legacy-unfenced/);
  assert.equal(
    await evaluateHook(
      { cwd: "C:\\repository", hook_event_name: "PreToolUse" },
      {
        environment: { [ORCHESTRATION_LOCK_ENV]: legacy.lock_id },
        readLock: async () => legacy,
      },
    ),
    null,
  );
});
