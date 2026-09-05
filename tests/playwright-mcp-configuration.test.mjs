import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as configuration from "../.agents/skills/sol-luna-orchestration/scripts/playwright-mcp-configuration.mjs";
import { updateGlobalConfig } from "../scripts/install-global-orchestration.mjs";

test("installation leaves existing MCP definitions unchanged and does not create Playwright", () => {
  for (const section of ["", '[mcp_servers.playwright]\nenabled = false\ncommand = "custom"\nargs = ["another-version"]\n', '[mcp_servers.playwright]\nurl = "https://example.test/mcp"\n']) {
    const result = updateGlobalConfig(section).content;
    if (section === "") assert.doesNotMatch(result, /mcp_servers/);
    else assert.ok(result.includes(section.trim()));
  }
});

test("private Playwright preflight accepts user configurations and rejects a reserved name", () => {
  for (const value of [undefined, { enabled: false }, { url: "https://example.test/mcp" }]) {
    assert.doesNotThrow(() => configuration.validatePlaywrightMcpConfiguration({ mcp_servers: { playwright: value } }));
  }
  assert.throws(() => configuration.validatePlaywrightMcpConfiguration({ mcp_servers: { sol_luna_playwright: {} } }), /reserved|already configured/);
});

test("private Playwright runtime isolates environment, files and complete configuration", async () => {
  const parent = await mkdtemp(join(tmpdir(), "private-playwright-test-"));
  let runtime;
  try {
    const environment = { PATH: "tools", PLAYWRIGHT_MCP_CDP_ENDPOINT: "http://external", playwright_mcp_isolated: "false", KEEP: "yes" };
    runtime = await configuration.createPlaywrightMcpRuntime({ environment, temporaryRoot: parent, disableUserPlaywright: true });
    assert.equal(environment.PLAYWRIGHT_MCP_CDP_ENDPOINT, "http://external");
    assert.equal(runtime.environment.PLAYWRIGHT_MCP_CDP_ENDPOINT, undefined);
    assert.equal(runtime.environment.playwright_mcp_isolated, undefined);
    assert.equal(runtime.environment.KEEP, "yes");
    assert.equal((await stat(runtime.outputDirectory)).isDirectory(), true);
    assert.equal((await stat(runtime.tempDirectory)).isDirectory(), true);
    const expected = configuration.createPlaywrightMcpConfiguration(runtime.outputDirectory);
    const effective = { mcp_servers: { playwright: { enabled: false }, sol_luna_playwright: expected } };
    assert.doesNotThrow(() => configuration.validatePlaywrightMcpRuntimeConfiguration(effective, runtime.outputDirectory, { disableUserPlaywright: true }));
    assert.throws(() => configuration.validatePlaywrightMcpRuntimeConfiguration({ mcp_servers: { sol_luna_playwright: { ...expected, url: "https://unexpected.test" } } }, runtime.outputDirectory), /configuration/);
    assert.ok(runtime.overrides.some((value) => value.startsWith("mcp_servers.sol_luna_playwright={")));
    assert.ok(runtime.overrides.includes("mcp_servers.playwright.enabled=false"));
    await configuration.removePlaywrightMcpRuntime(runtime);
    await assert.rejects(stat(runtime.rootDirectory), { code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("private runtime rejects an unusable temporary root without leaving files", async () => {
  const source = new URL(import.meta.url);
  await assert.rejects(configuration.createPlaywrightMcpRuntime({ temporaryRoot: source.pathname }), /./);
  assert.ok((await readFile(source, "utf8")).includes("private runtime rejects"));
});
