import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { resolve } from "node:path";
import { main, parseModelRoutingArguments, buildRootArguments, startConfiguredRoot } from "../.agents/skills/sol-luna-orchestration/scripts/model-routing.mjs";
import { modelCatalog } from "./fixtures/model-routes.mjs";
import { resolveModelRoute } from "../.agents/skills/sol-luna-orchestration/scripts/model-selection.mjs";
import { resolveConfiguredModel } from "../.agents/skills/sol-luna-orchestration/scripts/configured-models.mjs";

test("model routing commands reject model overrides and ambiguous options", () => {
  assert.deepEqual(parseModelRoutingArguments(["root"]), { operation: "root", cwd: process.cwd() });
  assert.equal(parseModelRoutingArguments(["inspect", "--cwd", ".."], process.cwd()).cwd, resolve(".."));
  for (const args of [[], ["root", "--model", "gpt-6-sol"], ["root", "--cwd"], ["inspect", "--cwd", ".", "--cwd", "."], ["root", "--", "--dangerously-bypass-approvals-and-sandbox"]]) assert.throws(() => parseModelRoutingArguments(args));
});

test("root arguments apply configured family, effort and plan effort without changing approvals or sandbox", () => {
  const route = resolveModelRoute("root", { advanced: "sol@latest", efforts: { root: "xhigh" } }, modelCatalog);
  const args = buildRootArguments(route, process.cwd());
  assert.ok(args.includes('model="gpt-6-sol"'));
  assert.ok(args.includes('plan_mode_reasoning_effort="xhigh"'));
  assert.ok(args.includes('model_verbosity="low"'));
  assert.doesNotMatch(args.join(" "), /approval|sandbox|bypass/);
});

test("root uses the resolved native executable, inherited terminal and exact arguments", async () => {
  const route = resolveModelRoute("root", {}, modelCatalog);
  const exit = await startConfiguredRoot(route, {
    cwd: process.cwd(), environment: { TEST: "value" },
    commandResolver: async () => ({ executable: "/native/codex", environment: { TEST: "resolved" } }),
    spawnImplementation: (command, args, options) => {
      assert.equal(command, "/native/codex");
      assert.deepEqual(args, buildRootArguments(route, process.cwd()));
      assert.equal(options.shell, false);
      assert.equal(options.stdio, "inherit");
      assert.equal(options.env.TEST, "resolved");
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  });
  assert.equal(exit, 0);
});

test("inspect emits routes without starting a root; root selection honors Sol configuration", async () => {
  let output = "", diagnostics = "", started = 0;
  const dependencies = {
    configurationReader: async () => ({ path: "/config.json", models: { advanced: "sol@latest" } }),
    catalogReader: async () => modelCatalog,
    rootStarter: async (route) => { started++; assert.equal(route.model, "gpt-6-sol"); return 0; },
    stdout: { write: (value) => { output += value; } }, stderr: { write: (value) => { diagnostics += value; } },
    environment: { NO_COLOR: "1" },
  };
  assert.equal(await main(["inspect"], dependencies), 0);
  assert.equal(JSON.parse(output).routes.review.model, "gpt-6-sol");
  assert.equal(started, 0);
  output = "";
  assert.equal(await main(["root"], dependencies), 0);
  assert.equal(started, 1);
  assert.equal(output, "");
  assert.match(diagnostics, /SOL@LATEST → GPT-6-SOL/);
  assert.equal(await main(["root"], { ...dependencies, catalogReader: async () => [] }), 2);
  assert.equal(started, 1);
});

test("configured resolution validates configuration before querying the runtime", async () => {
  let queried = false;
  await assert.rejects(resolveConfiguredModel("root", {
    configurationReader: async () => ({ models: { advanced: "typo" } }),
    catalogReader: async () => { queried = true; return modelCatalog; },
  }), /selector/);
  assert.equal(queried, false);
});
