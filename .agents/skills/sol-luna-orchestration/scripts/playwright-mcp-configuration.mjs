import { isAbsolute } from "node:path";

export const PLAYWRIGHT_MCP_VERSION = "0.0.80";
export const PLAYWRIGHT_MCP_PACKAGE_SPEC = `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`;
export const PLAYWRIGHT_MCP_COMMAND = "npx";
export const PLAYWRIGHT_MCP_ARGUMENTS = ["--yes", PLAYWRIGHT_MCP_PACKAGE_SPEC];
export const PLAYWRIGHT_MCP_APPROVAL_OVERRIDE =
  'mcp_servers.playwright.default_tools_approval_mode="approve"';
export const PLAYWRIGHT_MCP_DISABLED_TOOLS = ["browser_run_code_unsafe"];

export function createPlaywrightMcpRuntimeOverrides(outputDirectory) {
  if (typeof outputDirectory !== "string" || !isAbsolute(outputDirectory)) {
    throw new Error("The Playwright MCP output directory must be an absolute path.");
  }
  const runtimeArguments = [
    ...PLAYWRIGHT_MCP_ARGUMENTS,
    "--isolated",
    "--output-dir",
    outputDirectory,
  ];
  return [
    PLAYWRIGHT_MCP_APPROVAL_OVERRIDE,
    `mcp_servers.playwright.disabled_tools=${JSON.stringify(PLAYWRIGHT_MCP_DISABLED_TOOLS)}`,
    `mcp_servers.playwright.cwd=${JSON.stringify(outputDirectory)}`,
    `mcp_servers.playwright.args=${JSON.stringify(runtimeArguments)}`,
  ];
}

export function validatePlaywrightMcpConfiguration(configuration) {
  if (
    configuration?.name !== "playwright" ||
    configuration.enabled !== true ||
    configuration.transport?.type !== "stdio"
  ) {
    throw new Error(
      "The Playwright MCP must be installed, enabled, and configured with stdio transport.",
    );
  }
  if (
    configuration.transport.command !== PLAYWRIGHT_MCP_COMMAND ||
    JSON.stringify(configuration.transport.args) !== JSON.stringify(PLAYWRIGHT_MCP_ARGUMENTS)
  ) {
    throw new Error(
      `The Playwright MCP must use ${PLAYWRIGHT_MCP_COMMAND} ${PLAYWRIGHT_MCP_ARGUMENTS.join(" ")}. Run npm run install:global to repair the configuration.`,
    );
  }
  return configuration;
}
