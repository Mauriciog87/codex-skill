import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ORCHESTRATION_GENERATION_ENV,
  ORCHESTRATION_LOCK_ENV,
  OrchestrationStateError,
  getOrchestrationStatus,
  readOrchestrationHistory,
  readUltraLock,
  recoverUltraLock,
} from "./orchestration-state.mjs";

const MAX_HOOK_INPUT_BYTES = 1_048_576;

export class GateInvocationError extends Error {
  constructor(message) {
    super(message);
    this.name = "GateInvocationError";
  }
}

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new GateInvocationError(`${option} requires a value.`);
  }
  return value;
}

export function parseGateArguments(argv, baseDirectory = process.cwd()) {
  const command = argv[0];
  if (!["status", "recover", "history", "hook"].includes(command)) {
    throw new GateInvocationError("Command must be status, recover, history, or hook.");
  }
  if (command === "hook") {
    if (argv.length !== 1) {
      throw new GateInvocationError("hook does not accept options.");
    }
    return {
      command,
      cwd: null,
      lockId: null,
      limit: null,
      confirmLegacyRecovery: false,
    };
  }
  const parsed = {
    command,
    cwd: null,
    lockId: null,
    limit: command === "history" ? 50 : null,
    confirmLegacyRecovery: false,
  };
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (!["--cwd", "--lock-id", "--limit", "--confirm-legacy-recovery"].includes(option)) {
      throw new GateInvocationError(`Unknown option: ${option}`);
    }
    if (seen.has(option)) {
      throw new GateInvocationError(`Duplicate option: ${option}`);
    }
    seen.add(option);
    if (option === "--confirm-legacy-recovery") {
      parsed.confirmLegacyRecovery = true;
      continue;
    }
    const value = requireValue(argv, index, option);
    index += 1;
    if (option === "--cwd") {
      parsed.cwd = resolve(baseDirectory, value);
    } else if (option === "--lock-id") {
      parsed.lockId = value;
    } else {
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new GateInvocationError("--limit must be an integer between 1 and 200.");
      }
      parsed.limit = limit;
    }
  }
  if (parsed.cwd === null) {
    throw new GateInvocationError("--cwd is required.");
  }
  if (command === "status" && parsed.lockId !== null) {
    throw new GateInvocationError("status does not accept --lock-id.");
  }
  if (command === "status" && (seen.has("--limit") || parsed.confirmLegacyRecovery)) {
    throw new GateInvocationError("status accepts only --cwd.");
  }
  if (command === "recover" && parsed.lockId === null) {
    throw new GateInvocationError("recover requires --lock-id.");
  }
  if (command === "recover" && seen.has("--limit")) {
    throw new GateInvocationError("recover does not accept --limit.");
  }
  if (command === "history" && (parsed.lockId !== null || parsed.confirmLegacyRecovery)) {
    throw new GateInvocationError("history accepts only --cwd and --limit.");
  }
  return parsed;
}

async function readStandardInput(stream = process.stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_HOOK_INPUT_BYTES) {
      throw new GateInvocationError("Hook input exceeds the maximum supported size.");
    }
    chunks.push(chunk);
  }
  const content = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new GateInvocationError(`Hook input is invalid JSON: ${error.message}`);
  }
}

function blockedPreToolUse(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function sessionContext(message) {
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: message,
    },
  };
}

export async function evaluateHook(
  input,
  { environment = process.env, readLock = readUltraLock } = {},
) {
  if (input === null || typeof input !== "object" || typeof input.cwd !== "string") {
    throw new GateInvocationError("Hook input must contain cwd.");
  }
  if (!["SessionStart", "PreToolUse"].includes(input.hook_event_name)) {
    return null;
  }
  let lock;
  try {
    lock = await readLock(input.cwd, { environment });
  } catch (error) {
    const reason = `Sol-Luna Ultra orchestration state is invalid and requires manual recovery: ${error.message}`;
    return input.hook_event_name === "PreToolUse"
      ? blockedPreToolUse(reason)
      : sessionContext(reason);
  }
  const inheritedLockId = environment[ORCHESTRATION_LOCK_ENV] ?? null;
  const inheritedGeneration = environment[ORCHESTRATION_GENERATION_ENV] ?? null;
  if (lock === null) {
    if (inheritedLockId === null && inheritedGeneration === null) {
      return null;
    }
    const reason = inheritedLockId === null || inheritedGeneration === null
      ? "Session has incomplete Ultra ownership variables without an active repository lock."
      : "Session has stale Ultra ownership variables without an active repository lock.";
    return input.hook_event_name === "PreToolUse"
      ? blockedPreToolUse(reason)
      : sessionContext(reason);
  }
  const legacy = lock.version === 1;
  const ownsLock = lock.state === "active" && inheritedLockId === lock.lock_id && (
    legacy
      ? inheritedGeneration === null
      : inheritedGeneration === String(lock.generation)
  );
  if (input.hook_event_name === "SessionStart") {
    return sessionContext(
      ownsLock
        ? legacy
          ? `This session owns legacy-unfenced Sol Ultra takeover ${lock.lock_id} for ${lock.repository}. Drain it without starting new executors.`
          : `This session owns exclusive Sol Ultra takeover ${lock.lock_id} generation ${lock.generation} for ${lock.repository}.`
        : `Repository ${lock.repository} is paused by exclusive Sol Ultra takeover ${lock.lock_id}${legacy ? " legacy-unfenced" : ` generation ${lock.generation}`} in state ${lock.state}. Do not plan, delegate, edit, or run tools until the lock is released.`,
    );
  }
  if (ownsLock) {
    return null;
  }
  return blockedPreToolUse(
    `Repository is blocked by exclusive Sol Ultra takeover ${lock.lock_id}${legacy ? " legacy-unfenced" : ` generation ${lock.generation}`} in state ${lock.state}.`,
  );
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseGateArguments(argv);
    if (options.command === "hook") {
      const output = await evaluateHook(await readStandardInput());
      if (output !== null) {
        process.stdout.write(`${JSON.stringify(output)}\n`);
      }
      return 0;
    }
    const output = options.command === "status"
      ? await getOrchestrationStatus(options.cwd)
      : options.command === "history"
        ? await readOrchestrationHistory(options.cwd, { limit: options.limit })
        : await recoverUltraLock({
            cwd: options.cwd,
            lockId: options.lockId,
            confirmLegacyRecovery: options.confirmLegacyRecovery,
          });
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ status: "failed", summary: message })}\n`);
    return error instanceof GateInvocationError || error instanceof OrchestrationStateError ? 2 : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
