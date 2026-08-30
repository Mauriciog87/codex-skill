import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  ControlCliError,
  parseControlArguments,
} from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-control.mjs";

test("control CLI parses read-only and exact-revision mutation commands", () => {
  const baseDirectory = resolve("fixtures", "repository");
  assert.deepEqual(parseControlArguments(["next"], baseDirectory), {
    command: "next",
    cwd: baseDirectory,
    assignmentId: null,
    revision: null,
    authority: "root",
    kind: null,
    requestId: null,
    answer: null,
    reason: null,
    watch: false,
    intervalMs: 1000,
    host: "127.0.0.1",
    port: 0,
  });
  const approve = parseControlArguments([
    "approve",
    "--assignment-id",
    "assignment",
    "--revision",
    "7",
    "--kind",
    "operator",
    "--authority",
    "operator",
  ]);
  assert.equal(approve.revision, 7);
  assert.equal(approve.kind, "operator");
  assert.equal(approve.authority, "operator");
});

test("control CLI rejects mutations without an assignment revision", () => {
  for (const args of [
    ["claim"],
    ["claim", "--assignment-id", "assignment"],
    ["approve", "--assignment-id", "assignment", "--revision", "1"],
    ["answer", "--assignment-id", "assignment", "--revision", "1"],
    ["dashboard", "--host", "0.0.0.0"],
  ]) {
    assert.throws(() => parseControlArguments(args), ControlCliError);
  }
});
