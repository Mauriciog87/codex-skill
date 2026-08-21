import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveCodexInvocation } from "../.agents/skills/sol-luna-orchestration/scripts/codex-command.mjs";

const execFileAsync = promisify(execFile);

export function getPlatformName(platform = process.platform) {
  return {
    win32: "windows",
    linux: "linux",
    darwin: "macos",
  }[platform] ?? null;
}

export function parseCodexVersion(value) {
  const match = String(value ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match === null ? null : match.slice(1).join(".");
}

export async function runCommand(
  command,
  args,
  {
    cwd,
    environment = process.env,
    maxBuffer = 16 * 1024 * 1024,
    platform = process.platform,
    architecture = process.arch,
    commandResolver = resolveCodexInvocation,
    execFileImplementation = execFileAsync,
  } = {},
) {
  const invocation = await commandResolver(command, {
    platform,
    architecture,
    environment,
  });
  return execFileImplementation(invocation.executable, args, {
    cwd,
    env: invocation.environment,
    windowsHide: true,
    maxBuffer,
  });
}

export async function readCodexVersion({
  cwd,
  environment = process.env,
  commandRunner = runCommand,
} = {}) {
  const { stdout = "", stderr = "" } = await commandRunner("codex", ["--version"], {
    cwd,
    environment,
  });
  const version = parseCodexVersion(`${stdout}\n${stderr}`);
  if (version === null) {
    throw new Error("Codex CLI did not report a semantic version.");
  }
  return version;
}

export function isPathInside(parentDirectory, candidatePath) {
  const pathFromParent = relative(resolve(parentDirectory), resolve(candidatePath));
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

export async function writeJsonOutput(outputPath, value) {
  if (outputPath === null || outputPath === undefined) {
    return;
  }
  const destination = resolve(outputPath);
  const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(destination), { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, "utf8");
    try {
      await rename(temporaryPath, destination);
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !["EACCES", "EEXIST", "EPERM"].includes(error.code)
      ) {
        throw error;
      }
      await copyFile(temporaryPath, destination);
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
