export const ADVANCED_MODEL = "gpt-6-astra";
export const ADVANCED_EXECUTOR_POOL = "sol";
export const MODEL_VERBOSITY = "low";

export const ROOT_POLICY = Object.freeze({
  model: ADVANCED_MODEL,
  reasoningEffort: "high",
  serviceTier: "standard",
  configuredServiceTier: "default",
  fastMode: false,
});

export const ULTRA_POLICY = Object.freeze({
  ...ROOT_POLICY,
  reasoningEffort: "ultra",
});

export const ROOT_CONFIG_VALUES = Object.freeze({
  model: ROOT_POLICY.model,
  model_reasoning_effort: ROOT_POLICY.reasoningEffort,
  model_verbosity: MODEL_VERBOSITY,
  service_tier: ROOT_POLICY.configuredServiceTier,
  plan_mode_reasoning_effort: ROOT_POLICY.reasoningEffort,
});
