import { resolveModelRoute } from "../../.agents/skills/sol-luna-orchestration/scripts/model-selection.mjs";
import { EXECUTOR_PROFILE_NAMES, bindExecutorProfile } from "../../.agents/skills/sol-luna-orchestration/scripts/executor-profiles.mjs";

export const modelCatalog = ["gpt-6-astra", "gpt-6-sol", "gpt-5.6-luna"].map((model) => ({
  id: model, model, hidden: false,
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort })),
  serviceTiers: ["priority"],
}));

export const fixtureModelResolver = async (role) => resolveModelRoute(role, {}, modelCatalog);
export const fixtureExecutorProfiles = Object.fromEntries(EXECUTOR_PROFILE_NAMES.map((name) => [name, bindExecutorProfile(name, resolveModelRoute(name, {}, modelCatalog))]));
