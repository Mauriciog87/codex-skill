import { validateResolvedRoute } from "./model-selection.mjs";

export const ADVANCED_EXECUTOR_POOL = "sol";
export const MODEL_VERBOSITY = "low";

export const LEGACY_ROOT_POLICY = Object.freeze({
  model: "gpt-6-astra",
  reasoningEffort: "high",
  serviceTier: "standard",
  configuredServiceTier: "default",
  fastMode: false,
});

export const LEGACY_ULTRA_POLICY = Object.freeze({
  ...LEGACY_ROOT_POLICY,
  reasoningEffort: "ultra",
});

export const LEGACY_ROOT_CONFIG_VALUES = Object.freeze({
  model: LEGACY_ROOT_POLICY.model,
  model_reasoning_effort: LEGACY_ROOT_POLICY.reasoningEffort,
  model_verbosity: MODEL_VERBOSITY,
  service_tier: LEGACY_ROOT_POLICY.configuredServiceTier,
  plan_mode_reasoning_effort: LEGACY_ROOT_POLICY.reasoningEffort,
});

export function rootConfigValues(route) {
  validateResolvedRoute(route, "root");
  return {
    model: route.model,
    model_reasoning_effort: route.reasoningEffort,
    model_verbosity: MODEL_VERBOSITY,
    service_tier: "default",
    plan_mode_reasoning_effort: route.reasoningEffort,
  };
}
