import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

export const PLAYWRIGHT_MCP_SERVER_NAME = "sol_luna_playwright";
export const PLAYWRIGHT_MCP_VERSION = "0.0.80";
export const PLAYWRIGHT_RUNTIME_VERSION = "1.63.0-alpha-2026-08-31";
export const PLAYWRIGHT_MCP_PACKAGE_SPEC = `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`;
export const PLAYWRIGHT_MCP_COMMAND = "npx";
export const PLAYWRIGHT_MCP_ARGUMENTS = ["--yes", PLAYWRIGHT_MCP_PACKAGE_SPEC];
export const PLAYWRIGHT_MCP_DISABLED_TOOLS = ["browser_run_code_unsafe"];
export const PLAYWRIGHT_MCP_REQUIRED_TOOLS = [
  "browser_navigate", "browser_snapshot", "browser_click", "browser_take_screenshot", "browser_close",
];
export const PLAYWRIGHT_MCP_STARTUP_TIMEOUT_MS = 30_000;

export function createPlaywrightMcpConfiguration(outputDirectory) {
  if (typeof outputDirectory !== "string" || !isAbsolute(outputDirectory)) {
    throw new Error("The Playwright MCP output directory must be an absolute path.");
  }
  const runtimeArguments = [
    ...PLAYWRIGHT_MCP_ARGUMENTS,
    "--isolated",
    "--output-dir",
    outputDirectory,
  ];
  const temporaryDirectory = join(dirname(outputDirectory), "tmp");
  return {
    enabled: true,
    command: PLAYWRIGHT_MCP_COMMAND,
    args: runtimeArguments,
    cwd: outputDirectory,
    env: { TMP: temporaryDirectory, TEMP: temporaryDirectory, TMPDIR: temporaryDirectory },
    default_tools_approval_mode: "approve",
    disabled_tools: [...PLAYWRIGHT_MCP_DISABLED_TOOLS],
    startup_timeout_sec: PLAYWRIGHT_MCP_STARTUP_TIMEOUT_MS / 1_000,
  };
}

function inlineToml(value) {
  if (Array.isArray(value)) return `[${value.map(inlineToml).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).map(([key, entry]) => `${key}=${inlineToml(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createPlaywrightMcpRuntimeOverrides(outputDirectory, { disableUserPlaywright = false } = {}) {
  return [
    `mcp_servers.${PLAYWRIGHT_MCP_SERVER_NAME}=${inlineToml(createPlaywrightMcpConfiguration(outputDirectory))}`,
    ...(disableUserPlaywright ? ["mcp_servers.playwright.enabled=false"] : []),
  ];
}

export function validatePlaywrightMcpConfiguration(configuration) {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    throw new Error("config/read did not return a valid configuration for the Playwright preflight.");
  }
  if (Object.hasOwn(configuration.mcp_servers ?? {}, PLAYWRIGHT_MCP_SERVER_NAME)) {
    throw new Error(`The reserved MCP name ${PLAYWRIGHT_MCP_SERVER_NAME} is already configured. Rename that entry before running the Playwright executor.`);
  }
  return configuration;
}

export function validatePlaywrightMcpRuntimeConfiguration(configuration, outputDirectory, { disableUserPlaywright = false } = {}) {
  const servers = configuration?.mcp_servers;
  const actual = { ...servers?.[PLAYWRIGHT_MCP_SERVER_NAME] };
  if (actual.environment_id === "local") delete actual.environment_id;
  if (actual.tool_timeout_sec === null) delete actual.tool_timeout_sec;
  if (!isDeepStrictEqual(actual, createPlaywrightMcpConfiguration(outputDirectory)) ||
      (disableUserPlaywright ? servers?.playwright?.enabled !== false : Object.hasOwn(servers ?? {}, "playwright"))) {
    throw new Error("The private Playwright MCP effective configuration does not match its isolated runtime configuration.");
  }
}

export async function createPlaywrightMcpRuntime({ environment = process.env, temporaryRoot = tmpdir(), disableUserPlaywright = false } = {}) {
  const rootDirectory = await mkdtemp(join(temporaryRoot, "sol-luna-playwright-"));
  const runtime = {
    rootDirectory,
    outputDirectory: join(rootDirectory, "artifacts"),
    tempDirectory: join(rootDirectory, "tmp"),
    disableUserPlaywright,
    environment: Object.fromEntries(Object.entries(environment).filter(([key]) => !/^PLAYWRIGHT_MCP_/i.test(key))),
  };
  try {
    for (const directory of [runtime.outputDirectory, runtime.tempDirectory]) {
      await mkdir(directory);
      const probe = join(directory, ".write-probe");
      const handle = await open(probe, "wx");
      try { await handle.writeFile("writable"); } finally { await handle.close(); }
      await rm(probe);
    }
    runtime.overrides = createPlaywrightMcpRuntimeOverrides(runtime.outputDirectory, { disableUserPlaywright });
    return runtime;
  } catch (error) {
    try { await removePlaywrightMcpRuntime(runtime); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `${error.message} Cleanup failed: ${cleanupError.message}`);
    }
    throw error;
  }
}

export async function removePlaywrightMcpRuntime(runtime) {
  await rm(runtime.rootDirectory, { recursive: true, force: true });
}
