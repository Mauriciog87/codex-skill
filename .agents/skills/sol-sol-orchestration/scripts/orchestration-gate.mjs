import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ORCHESTRATION_LOCK_ENV,
  OrchestrationStateError,
  getOrchestrationStatus,
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
  if (!["status", "recover", "hook"].includes(command)) {
    throw new GateInvocationError("Command must be status, recover, or hook.");
  }
  if (command === "hook") {
    if (argv.length !== 1) {
      throw new GateInvocationError("hook does not accept options.");
    }
    return { command, cwd: null, lockId: null };
  }
  const parsed = { command, cwd: null, lockId: null };
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (!["--cwd", "--lock-id"].includes(option)) {
      throw new GateInvocationError(`Unknown option: ${option}`);
    }
    if (seen.has(option)) {
      throw new GateInvocationError(`Duplicate option: ${option}`);
    }
    seen.add(option);
    const value = requireValue(argv, index, option);
    index += 1;
    if (option === "--cwd") {
      parsed.cwd = resolve(baseDirectory, value);
    } else {
      parsed.lockId = value;
    }
  }
  if (parsed.cwd === null) {
    throw new GateInvocationError("--cwd is required.");
  }
  if (command === "status" && parsed.lockId !== null) {
    throw new GateInvocationError("status does not accept --lock-id.");
  }
  if (command === "recover" && parsed.lockId === null) {
    throw new GateInvocationError("recover requires --lock-id.");
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
    const reason = `Sol Ultra orchestration state is invalid and requires manual recovery: ${error.message}`;
    return input.hook_event_name === "PreToolUse"
      ? blockedPreToolUse(reason)
      : sessionContext(reason);
  }
  if (lock === null) {
    return null;
  }
  const ownsLock =
    lock.state === "active" && environment[ORCHESTRATION_LOCK_ENV] === lock.lock_id;
  if (input.hook_event_name === "SessionStart") {
    return sessionContext(
      ownsLock
        ? `This session owns exclusive Sol Ultra takeover ${lock.lock_id} for ${lock.repository}.`
        : `Repository ${lock.repository} is paused by exclusive Sol Ultra takeover ${lock.lock_id}. Do not plan, delegate, edit, or run tools until the lock is released.`,
    );
  }
  if (ownsLock) {
    return null;
  }
  return blockedPreToolUse(
    `Repository is blocked by exclusive Sol Ultra takeover ${lock.lock_id} in state ${lock.state}.`,
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
      : await recoverUltraLock({ cwd: options.cwd, lockId: options.lockId });
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
