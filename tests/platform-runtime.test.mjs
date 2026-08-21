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
