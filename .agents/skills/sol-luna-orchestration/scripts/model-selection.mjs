const MODEL_PATTERN = /^gpt-([1-9]\d*)(?:\.([1-9]\d*))?-(astra|sol|luna)$/;
const ALIAS_PATTERN = /^(astra|sol|luna)@latest$/;
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export const DEFAULT_MODEL_CONFIGURATION = Object.freeze({
  advanced: "astra@latest",
  economy: "luna@latest",
  efforts: Object.freeze({ root: "high", explore: "max", "implement-lite": "max", playwright: "max", implement: "medium", review: "high", ultra: "ultra" }),
});

export class ModelSelectionError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelSelectionError";
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelSelectionError(`${label} must be an object.`);
}

function requireKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ModelSelectionError(`${label} contains unknown properties: ${unknown.join(", ")}.`);
}

export function parseConcreteModel(model) {
  if (typeof model !== "string") return null;
  const match = model.match(MODEL_PATTERN);
  if (!match) return null;
  const version = [Number(match[1]), Number(match[2] ?? 0)];
  if (!version.every(Number.isSafeInteger)) return null;
  return { family: match[3], version };
}

export function parseModelSelector(selector) {
  const alias = typeof selector === "string" ? selector.match(ALIAS_PATTERN) : null;
  if (alias) return { selector, family: alias[1], latest: true };
  const concrete = parseConcreteModel(selector);
  if (concrete) return { selector, family: concrete.family, latest: false };
  throw new ModelSelectionError(`Invalid model selector ${JSON.stringify(selector)}. Use astra@latest, sol@latest, luna@latest, or an exact stable model id such as gpt-6-astra.`);
}

export function validateModelConfiguration(value = {}) {
  requireObject(value, "models");
  requireKeys(value, ["advanced", "economy", "efforts"], "models");
  const advanced = Object.hasOwn(value, "advanced") ? value.advanced : DEFAULT_MODEL_CONFIGURATION.advanced;
  const economy = Object.hasOwn(value, "economy") ? value.economy : DEFAULT_MODEL_CONFIGURATION.economy;
  if (!["astra", "sol"].includes(parseModelSelector(advanced).family)) throw new ModelSelectionError("models.advanced must select Astra or Sol.");
  if (parseModelSelector(economy).family !== "luna") throw new ModelSelectionError("models.economy must select Luna.");
  const overrides = Object.hasOwn(value, "efforts") ? value.efforts : {};
  requireObject(overrides, "models.efforts");
  requireKeys(overrides, Object.keys(DEFAULT_MODEL_CONFIGURATION.efforts), "models.efforts");
  for (const [role, effort] of Object.entries(overrides)) {
    if (!EFFORTS.has(effort)) throw new ModelSelectionError(`Unsupported reasoning effort for ${role}: ${effort}.`);
  }
  if (overrides.ultra !== undefined && overrides.ultra !== "ultra") throw new ModelSelectionError("The exceptional takeover must use ultra effort.");
  return { advanced, economy, efforts: { ...DEFAULT_MODEL_CONFIGURATION.efforts, ...overrides } };
}

export function roleModelPolicy(role, configuration = {}) {
  const models = validateModelConfiguration(configuration);
  if (!Object.hasOwn(models.efforts, role)) throw new ModelSelectionError(`Unknown model role: ${role}.`);
  const economy = ["explore", "implement-lite", "playwright"].includes(role);
  return {
    role,
    selector: economy ? models.economy : models.advanced,
    reasoningEffort: models.efforts[role],
    serviceTier: ["explore", "implement-lite"].includes(role) ? "fast" : "standard",
  };
}

export function modelSupportsRoute(model, route) {
  const efforts = model.supportedReasoningEfforts ?? model.supported_reasoning_efforts;
  if (!Array.isArray(efforts) || !efforts.some((entry) => (typeof entry === "string" ? entry : entry?.reasoningEffort ?? entry?.effort) === route.reasoningEffort)) {
    throw new ModelSelectionError(`model/list does not advertise ${route.reasoningEffort} effort for ${route.model}.`);
  }
  const tiers = model.serviceTiers ?? model.service_tiers;
  const speeds = model.additionalSpeedTiers ?? model.additional_speed_tiers;
  const priority = (Array.isArray(tiers) && tiers.some((tier) => (tier?.id ?? tier) === "priority")) ||
    (Array.isArray(speeds) && speeds.some((tier) => (tier?.id ?? tier) === "fast"));
  if (route.serviceTier === "fast" && !priority) {
    throw new ModelSelectionError(`model/list does not advertise priority service for ${route.model}.`);
  }
}

export function resolveModelRoute(role, configuration, catalog) {
  const policy = roleModelPolicy(role, configuration);
  const selector = parseModelSelector(policy.selector);
  if (!Array.isArray(catalog)) throw new ModelSelectionError("model/list did not return a catalog.");
  const seen = new Set();
  for (const model of catalog) {
    if (typeof model?.model !== "string" || !model.model || seen.has(model.model)) throw new ModelSelectionError("model/list contains missing or duplicate model identities.");
    seen.add(model.model);
    if (selector.latest && model.hidden === false && model.model.endsWith(`-${selector.family}`) && !parseConcreteModel(model.model)) {
      throw new ModelSelectionError(`Cannot order advertised ${selector.family} model ${model.model}. Pin an exact supported id or update the resolver; latest is ambiguous.`);
    }
  }
  const choices = catalog.filter((entry) => {
    const identity = parseConcreteModel(entry.model);
    return identity?.family === selector.family && (selector.latest ? entry.hidden === false : entry.model === selector.selector);
  }).sort((left, right) => {
    const a = parseConcreteModel(left.model).version;
    const b = parseConcreteModel(right.model).version;
    return b[0] - a[0] || b[1] - a[1];
  });
  const selected = choices[0];
  if (!selected) throw new ModelSelectionError(`No stable model advertised for ${policy.selector}. Check account availability or pin an advertised stable id.`);
  const route = { ...policy, model: selected.model };
  modelSupportsRoute(selected, route);
  return Object.freeze(route);
}

export function validateResolvedRoute(route, role) {
  requireObject(route, "Resolved model route");
  requireKeys(route, ["role", "selector", "model", "reasoningEffort", "serviceTier"], "Resolved model route");
  const selector = parseModelSelector(route.selector);
  const concrete = parseConcreteModel(route.model);
  const economy = ["explore", "implement-lite", "playwright"].includes(role);
  if (!Object.hasOwn(DEFAULT_MODEL_CONFIGURATION.efforts, role) || route.role !== role || !concrete || concrete.family !== selector.family ||
      (economy ? concrete.family !== "luna" : !["astra", "sol"].includes(concrete.family)) ||
      (!selector.latest && route.model !== selector.selector) || !EFFORTS.has(route.reasoningEffort) ||
      (role === "ultra" && route.reasoningEffort !== "ultra") ||
      route.serviceTier !== (["explore", "implement-lite"].includes(role) ? "fast" : "standard")) {
    throw new ModelSelectionError(`Invalid resolved route for ${role}.`);
  }
  return Object.freeze({ ...route });
}
