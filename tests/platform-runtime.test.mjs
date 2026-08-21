import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getPlatformName,
  isPathInside,
  parseCodexVersion,
  readCodexVersion,
  runCommand,
  writeJsonOutput,
} from "../scripts/platform-runtime.mjs";

test("platform names use the public cross-platform contract", () => {
  assert.equal(getPlatformName("win32"), "windows");
  assert.equal(getPlatformName("linux"), "linux");
  assert.equal(getPlatformName("darwin"), "macos");
  assert.equal(getPlatformName("freebsd"), null);
});

test("Codex versions are parsed and read from native process output", async () => {
  assert.equal(parseCodexVersion("codex-cli 0.147.0"), "0.147.0");
  assert.equal(parseCodexVersion("version unavailable"), null);
  assert.equal(
    await readCodexVersion({
      commandRunner: async () => ({ stdout: "codex-cli 0.148.1\n", stderr: "" }),
    }),
    "0.148.1",
  );
  await assert.rejects(
    readCodexVersion({
      commandRunner: async () => ({ stdout: "unknown", stderr: "" }),
    }),
    /semantic version/,
  );
});

test("command execution resolves Codex and preserves native process options", async () => {
  const environment = { PATH: "C:\\npm" };
  const calls = [];
  const commandResolver = async (command, options) => {
    calls.push({ type: "resolve", command, options });
    return {
      executable: command === "codex" ? "C:\\native\\codex.exe" : command,
      environment,
    };
  };
  const execFileImplementation = async (command, args, options) => {
    calls.push({ type: "execute", command, args, options });
    return { stdout: "ok", stderr: "" };
  };

  await runCommand("codex", ["--version"], {
    cwd: "C:\\workspace",
    environment,
    maxBuffer: 4096,
    platform: "win32",
    architecture: "x64",
    commandResolver,
    execFileImplementation,
  });
  await runCommand("git", ["status"], {
    environment,
    commandResolver,
    execFileImplementation,
  });

  assert.deepEqual(calls[0], {
    type: "resolve",
    command: "codex",
    options: {
      platform: "win32",
      architecture: "x64",
      environment,
    },
  });
  assert.deepEqual(calls[1], {
    type: "execute",
    command: "C:\\native\\codex.exe",
    args: ["--version"],
    options: {
      cwd: "C:\\workspace",
      env: environment,
      windowsHide: true,
      maxBuffer: 4096,
    },
  });
  assert.equal(calls[2].command, "git");
  assert.equal(calls[3].command, "git");
});

test("repository containment rejects evidence files inside the checkout", () => {
  const root = join(tmpdir(), "platform-runtime-repository");
  assert.equal(isPathInside(root, join(root, "evidence.json")), true);
  assert.equal(isPathInside(root, join(root, "nested", "evidence.json")), true);
  assert.equal(isPathInside(root, join(root, "..", "evidence.json")), false);
});

test("JSON evidence is written atomically with one trailing newline", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "platform-runtime-output-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = join(root, "nested", "evidence.json");
  const value = { status: "completed", checks: ["atomic:verified"] };
  await writeJsonOutput(outputPath, value);
  assert.equal(await readFile(outputPath, "utf8"), `${JSON.stringify(value)}\n`);
  const replacement = { status: "failed", checks: [] };
  await writeJsonOutput(outputPath, replacement);
  assert.equal(
    await readFile(outputPath, "utf8"),
    `${JSON.stringify(replacement)}\n`,
  );
});
