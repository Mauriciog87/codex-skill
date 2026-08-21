import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  main,
  parseVerifyRoutingArguments,
} from "../scripts/verify-routing.mjs";

test("verify-live accepts only one output path", () => {
  assert.deepEqual(parseVerifyRoutingArguments([]), { outputPath: null });
  assert.throws(() => parseVerifyRoutingArguments(["--output"]), /requires a path/);
  assert.throws(
    () => parseVerifyRoutingArguments(["--output", "one.json", "--output", "two.json"]),
    /only once/,
  );
  assert.throws(() => parseVerifyRoutingArguments(["--unknown"]), /Unknown argument/);
});

test("verify-live writes its preserved result with platform metadata", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "verify-live-output-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = join(root, "live.json");
  const result = {
    status: "completed",
    platform: "linux",
    architecture: "x64",
    node_version: "v22.0.0",
    codex_version: "0.147.0",
    root: {},
    executors: [],
  };
  let stdout = "";
  let stderr = "";
  const code = await main(["--output", outputPath], {
    verifyRouting: async () => result,
    writeStdout: (value) => {
      stdout += value;
    },
    writeStderr: (value) => {
      stderr += value;
    },
  });
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), result);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), result);
});

test("verify-live returns code 2 and writes failure evidence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "verify-live-failure-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = join(root, "live.json");
  let stderr = "";
  const code = await main(["--output", outputPath], {
    verifyRouting: async () => {
      throw new Error("sandbox unavailable");
    },
    writeStdout: () => {},
    writeStderr: (value) => {
      stderr += value;
    },
  });
  assert.equal(code, 2);
  const result = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(result.status, "failed");
  assert.match(result.summary, /sandbox unavailable/);
  assert.match(stderr, /sandbox unavailable/);
});
