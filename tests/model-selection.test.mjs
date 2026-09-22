import assert from "node:assert/strict";
import test from "node:test";
import {
  parseModelSelector,
  validateModelConfiguration,
  resolveModelRoute,
  validateResolvedRoute,
} from "../.agents/skills/sol-luna-orchestration/scripts/model-selection.mjs";

const entry = (model, efforts = ["medium", "high", "max", "ultra"], extra = {}) => ({
  id: model, model, hidden: false,
  supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
  serviceTiers: ["default", "priority"], ...extra,
});
const catalog = [entry("gpt-5.6-luna"), entry("gpt-6-luna"), entry("gpt-6-astra"), entry("gpt-6-sol")];

test("defaults select Astra and Luna; one selector switches advanced roles to Sol", () => {
  const configuration = validateModelConfiguration();
  assert.equal(configuration.advanced, "astra@latest");
  assert.equal(configuration.economy, "luna@latest");
  for (const role of ["root", "implement", "review", "ultra"]) {
    assert.equal(resolveModelRoute(role, configuration, catalog).model, "gpt-6-astra");
    assert.equal(resolveModelRoute(role, { ...configuration, advanced: "sol@latest" }, catalog).model, "gpt-6-sol");
  }
  assert.equal(resolveModelRoute("explore", configuration, catalog).model, "gpt-6-luna");
  assert.equal(resolveModelRoute("implement", configuration, catalog).reasoningEffort, "medium");
  assert.equal(resolveModelRoute("review", configuration, catalog).reasoningEffort, "high");
});

test("latest uses numeric releases, not catalog order, default flags, or lexical sorting", () => {
  const models = [entry("gpt-6-sol", undefined, { isDefault: true }), entry("gpt-10-sol"), entry("gpt-9.12-sol"), entry("gpt-9.2-sol")];
  assert.equal(resolveModelRoute("root", { advanced: "sol@latest" }, models).model, "gpt-10-sol");
  assert.equal(resolveModelRoute("root", { advanced: "gpt-6-sol" }, models).model, "gpt-6-sol");
});

test("selectors and configuration reject typos, unknown families and unsupported properties", () => {
  for (const value of ["sol@lastest", "gpt-6", "terra@latest", "gpt-6-sol-preview", "gpt-06-sol", "gpt-6.0-sol"]) {
    assert.throws(() => parseModelSelector(value));
  }
  for (const value of [{ advanced: null }, { economy: null }, { efforts: null }, { advanced: "luna@latest" }, { economy: "sol@latest" }, { fallback: "sol@latest" }, { efforts: { root: "unknown" } }, { efforts: { typo: "high" } }]) {
    assert.throws(() => validateModelConfiguration(value));
  }
});

test("latest ignores hidden and preview versions, rejects duplicate identities and unknown naming", () => {
  const models = [...catalog, entry("gpt-7-astra-preview"), entry("gpt-8-astra", undefined, { hidden: true })];
  assert.equal(resolveModelRoute("root", {}, models).model, "gpt-6-astra");
  assert.throws(() => resolveModelRoute("root", {}, [...catalog, entry("gpt-6-astra")]));
  assert.throws(() => resolveModelRoute("root", {}, [entry("gpt-next-astra")]), /Cannot order/);
  assert.throws(() => resolveModelRoute("root", {}, [...catalog, entry("gpt-7.0.1-astra")]), /ambiguous/);
});

test("newest incompatible model blocks instead of downgrading effort, tier or release", () => {
  assert.throws(() => resolveModelRoute("ultra", {}, [...catalog, entry("gpt-7-astra", ["high"])]), /ultra/);
  assert.throws(() => resolveModelRoute("explore", {}, [entry("gpt-6-luna", ["max"], { serviceTiers: ["default"] })]), /priority/);
  assert.throws(() => resolveModelRoute("root", { advanced: "sol@latest" }, [entry("gpt-6-astra")]));
});

test("route snapshots are validated separately from current configuration and later releases", () => {
  const route = resolveModelRoute("implement", {}, catalog);
  assert.deepEqual(validateResolvedRoute(route, "implement"), route);
  assert.equal(route.model, "gpt-6-astra");
  for (const changed of [{ ...route, role: "review" }, { ...route, serviceTier: "fast" }, { ...route, model: "gpt-6-luna" }, { ...route, model: "astra@latest" }, { ...route, extra: true }]) {
    assert.throws(() => validateResolvedRoute(changed, "implement"));
  }
});
