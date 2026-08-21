import { stat } from "node:fs/promises";
import { join } from "node:path";

const WINDOWS_TARGETS = Object.freeze({
  x64: Object.freeze({
    packageName: "codex-win32-x64",
    target: "x86_64-pc-windows-msvc",
  }),
  arm64: Object.freeze({
    packageName: "codex-win32-arm64",
    target: "aarch64-pc-windows-msvc",
  }),
});

function getEnvironmentPath(environment) {
  const entries = Object.entries(environment ?? {})
    .filter(([key]) => key.toLowerCase() === "path")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return entries.length === 0 ? "" : String(entries[0][1] ?? "");
}

function getWindowsPathDirectories(environment) {
  return getEnvironmentPath(environment)
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.startsWith('"') && entry.endsWith('"')
      ? entry.slice(1, -1)
      : entry);
}

async function isFile(path, statImplementation) {
  try {
    return (await statImplementation(path)).isFile();
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) {
      return false;
    }
    throw error;
  }
}

function getNpmNativeCandidates(directory, target) {
  const vendorSegments = ["vendor", target.target, "bin", "codex.exe"];
  return [
    join(
      directory,
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      target.packageName,
      ...vendorSegments,
    ),
    join(
      directory,
      "node_modules",
      "@openai",
      target.packageName,
      ...vendorSegments,
    ),
    join(
      directory,
      "node_modules",
      "@openai",
      "codex",
      ...vendorSegments,
    ),
  ];
}

function createNpmEnvironment(environment, packageRoot) {
  const managedEnvironment = {
    ...environment,
    CODEX_MANAGED_PACKAGE_ROOT: packageRoot,
    CODEX_MANAGED_BY_NPM: "1",
  };
  delete managedEnvironment.CODEX_MANAGED_BY_BUN;
  delete managedEnvironment.CODEX_MANAGED_BY_PNPM;
  return managedEnvironment;
}

export async function resolveCodexInvocation(
  command,
  {
    platform = process.platform,
    architecture = process.arch,
    environment = process.env,
    statImplementation = stat,
  } = {},
) {
  if (command !== "codex" || platform !== "win32") {
    return { executable: command, environment };
  }

  const target = WINDOWS_TARGETS[architecture];
  if (target === undefined) {
    throw new Error(`Unsupported Windows architecture for Codex: ${architecture}.`);
  }

  let shimFound = false;
  for (const directory of getWindowsPathDirectories(environment)) {
    const directExecutable = join(directory, "codex.exe");
    if (await isFile(directExecutable, statImplementation)) {
      return { executable: directExecutable, environment };
    }

    const shim = join(directory, "codex.cmd");
    if (!await isFile(shim, statImplementation)) {
      continue;
    }
    shimFound = true;
    const packageRoot = join(directory, "node_modules", "@openai", "codex");
    for (const candidate of getNpmNativeCandidates(directory, target)) {
      if (await isFile(candidate, statImplementation)) {
        return {
          executable: candidate,
          environment: createNpmEnvironment(environment, packageRoot),
        };
      }
    }
  }

  if (shimFound) {
    throw new Error(
      `Found a Codex command shim but no native codex.exe for win32-${architecture}. Reinstall @openai/codex.`,
    );
  }
  throw new Error("Codex executable was not found on PATH.");
}
