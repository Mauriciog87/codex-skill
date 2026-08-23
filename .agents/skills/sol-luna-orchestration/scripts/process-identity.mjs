import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { arch, hostname } from "node:os";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const PROCESS_QUERY_TIMEOUT_MS = 5_000;
const currentProcessFingerprints = new Map();

export class ProcessIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProcessIdentityError";
  }
}

export function isPidAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid < 1) {
    return false;
  }
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function parseLinuxProcessStat(content) {
  if (typeof content !== "string") {
    throw new ProcessIdentityError("Linux process stat must be text.");
  }
  const closingParenthesis = content.lastIndexOf(")");
  if (closingParenthesis < 0) {
    throw new ProcessIdentityError("Linux process stat is malformed.");
  }
  const fields = content.slice(closingParenthesis + 1).trim().split(/\s+/);
  const startTime = fields[19];
  if (!/^\d+$/.test(startTime ?? "")) {
    throw new ProcessIdentityError("Linux process stat does not contain a start time.");
  }
  return startTime;
}

function normalizeOutput(value) {
  return String(value ?? "").trim();
}

function captureFailure(error, pid, processAlive) {
  if (!processAlive(pid)) {
    return { status: "dead" };
  }
  return {
    status: "unknown",
    reason: error instanceof Error ? error.message : String(error),
  };
}

async function captureLinuxFingerprint(pid, dependencies) {
  try {
    const [bootId, stat] = await Promise.all([
      dependencies.readFileImplementation("/proc/sys/kernel/random/boot_id", "utf8"),
      dependencies.readFileImplementation(`/proc/${pid}/stat`, "utf8"),
    ]);
    const normalizedBootId = normalizeOutput(bootId);
    if (normalizedBootId.length === 0) {
      throw new ProcessIdentityError("Linux boot id is empty.");
    }
    return {
      status: "found",
      fingerprint: `${normalizedBootId}:${parseLinuxProcessStat(stat)}`,
    };
  } catch (error) {
    return captureFailure(error, pid, dependencies.processAlive);
  }
}

async function captureDarwinFingerprint(pid, dependencies) {
  try {
    const { stdout } = await dependencies.execFileImplementation(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      {
        encoding: "utf8",
        timeout: PROCESS_QUERY_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 64 * 1024,
      },
    );
    const startTime = normalizeOutput(stdout);
    if (startTime.length === 0) {
      return dependencies.processAlive(pid)
        ? { status: "unknown", reason: "ps returned an empty process start time." }
        : { status: "dead" };
    }
    return { status: "found", fingerprint: startTime };
  } catch (error) {
    return captureFailure(error, pid, dependencies.processAlive);
  }
}

async function captureWindowsFingerprint(pid, dependencies) {
  const script = [
    "& { param([int]$TargetPid)",
    "$process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $TargetPid) -ErrorAction Stop",
    "if ($null -eq $process) { exit 3 }",
    "[Console]::Out.Write($process.CreationDate.ToUniversalTime().ToString('o'))",
    `} ${pid}`,
  ].join("; ");
  try {
    const { stdout } = await dependencies.execFileImplementation(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        timeout: PROCESS_QUERY_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 64 * 1024,
      },
    );
    const creationDate = normalizeOutput(stdout);
    if (creationDate.length === 0) {
      return dependencies.processAlive(pid)
        ? { status: "unknown", reason: "CIM returned an empty process creation date." }
        : { status: "dead" };
    }
    return { status: "found", fingerprint: creationDate };
  } catch (error) {
    return captureFailure(error, pid, dependencies.processAlive);
  }
}

function validateCaptureResult(result) {
  if (
    result === null ||
    typeof result !== "object" ||
    !["found", "dead", "unknown"].includes(result.status) ||
    (result.status === "found" &&
      (typeof result.fingerprint !== "string" || result.fingerprint.length === 0))
  ) {
    throw new ProcessIdentityError("Process fingerprint provider returned an invalid result.");
  }
  return result;
}

export async function captureProcessFingerprint(
  pid,
  {
    platform = process.platform,
    readFileImplementation = readFile,
    execFileImplementation = execFile,
    processAlive = isPidAlive,
  } = {},
) {
  if (!Number.isInteger(pid) || pid < 1) {
    return { status: "dead" };
  }
  const dependencies = { readFileImplementation, execFileImplementation, processAlive };
  const usesDefaults =
    readFileImplementation === readFile &&
    execFileImplementation === execFile &&
    processAlive === isPidAlive;
  const cacheKey = `${platform}:${pid}`;
  if (pid === process.pid && usesDefaults && currentProcessFingerprints.has(cacheKey)) {
    return await currentProcessFingerprints.get(cacheKey);
  }
  const capture = platform === "linux"
    ? captureLinuxFingerprint(pid, dependencies)
    : platform === "darwin"
      ? captureDarwinFingerprint(pid, dependencies)
      : platform === "win32"
        ? captureWindowsFingerprint(pid, dependencies)
        : Promise.resolve({
            status: "unknown",
            reason: `Unsupported process identity platform: ${platform}.`,
          });
  if (pid === process.pid && usesDefaults) {
    currentProcessFingerprints.set(cacheKey, capture);
  }
  return validateCaptureResult(await capture);
}

export function validateProcessIdentity(identity) {
  if (
    identity === null ||
    typeof identity !== "object" ||
    !Number.isInteger(identity.pid) ||
    identity.pid < 1 ||
    typeof identity.instance_id !== "string" ||
    identity.instance_id.length === 0 ||
    typeof identity.start_fingerprint !== "string" ||
    identity.start_fingerprint.length === 0 ||
    typeof identity.hostname !== "string" ||
    identity.hostname.length === 0 ||
    typeof identity.platform !== "string" ||
    identity.platform.length === 0 ||
    typeof identity.architecture !== "string" ||
    identity.architecture.length === 0
  ) {
    throw new ProcessIdentityError("Process identity metadata is malformed.");
  }
  return identity;
}

export async function createProcessIdentity({
  pid = process.pid,
  instanceId = randomUUID(),
  platform = process.platform,
  architecture = arch(),
  hostnameValue = hostname(),
  captureFingerprint = captureProcessFingerprint,
} = {}) {
  const captured = validateCaptureResult(await captureFingerprint(pid, { platform }));
  if (captured.status === "dead") {
    throw new ProcessIdentityError(`Process ${pid} is not active.`);
  }
  if (captured.status === "unknown") {
    throw new ProcessIdentityError(
      `Process ${pid} start fingerprint is unknown: ${captured.reason ?? "unavailable"}`,
    );
  }
  return validateProcessIdentity({
    pid,
    instance_id: instanceId,
    start_fingerprint: captured.fingerprint,
    hostname: hostnameValue,
    platform,
    architecture,
  });
}

export async function inspectProcessIdentity(
  identity,
  {
    captureFingerprint = captureProcessFingerprint,
    platform = process.platform,
    architecture = arch(),
    hostnameValue = hostname(),
  } = {},
) {
  validateProcessIdentity(identity);
  if (
    identity.hostname !== hostnameValue ||
    identity.platform !== platform ||
    identity.architecture !== architecture
  ) {
    return { status: "unknown", reason: "Process identity belongs to another host runtime." };
  }
  let captured;
  try {
    captured = validateCaptureResult(
      await captureFingerprint(identity.pid, { platform: identity.platform }),
    );
  } catch (error) {
    return {
      status: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (captured.status !== "found") {
    return captured;
  }
  return captured.fingerprint === identity.start_fingerprint
    ? { status: "same" }
    : { status: "reused" };
}
