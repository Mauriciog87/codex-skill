export const MODEL_VERBOSITY = "low";

const PROFILE_DEFINITIONS = {
  explore: {
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    serviceTier: "fast",
    configuredServiceTier: "fast",
    fastMode: true,
    sandboxMode: "read-only",
    concurrencyPool: "luna",
    colorCode: 36,
    instructions: [
      "Explore the assigned question without modifying files or running state-changing commands.",
      "Search broadly, read only the evidence needed, and stop when the briefing can be answered.",
      "Report a direct conclusion, path:line evidence, relevant contracts, risks, and unresolved questions.",
      "Do not return raw file dumps or long command output, and identify inferences explicitly.",
      "Return blocked and recommend escalation to the root when the task requires architectural decisions, security judgment, concurrency analysis, distributed invariants, or resolution of contradictory contracts.",
      "Keep changed_files empty.",
    ],
  },
  "implement-lite": {
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    serviceTier: "fast",
    configuredServiceTier: "fast",
    fastMode: true,
    sandboxMode: "workspace-write",
    concurrencyPool: "luna",
    colorCode: 92,
    instructions: [
      "Implement only the small, explicit, low-risk change assigned in the briefing and preserve unrelated changes.",
      "Read the relevant local contract before editing, follow existing patterns, and avoid architecture or security decisions.",
      "Add or update focused tests when behavior changes and run the relevant validation.",
      "Return blocked and recommend the Sol implement profile if the task expands, becomes ambiguous, or requires cross-cutting judgment.",
      "Do not self-approve, commit, push, or expand the assigned scope.",
      "Return completed only when the implementation and requested checks succeed, and report every changed file.",
    ],
  },
  playwright: {
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    serviceTier: "standard",
    configuredServiceTier: "default",
    fastMode: false,
    sandboxMode: "read-only",
    concurrencyPool: "luna",
    concurrencyLimit: 2,
    colorCode: 94,
    instructions: [
      "Use only the configured Playwright MCP tools for the browser task and keep repository files unchanged.",
      "You may navigate, inspect, and interact fully with localhost and explicitly named development or test environments.",
      "Treat external sites as observation-only unless the briefing explicitly authorizes a named state-changing action and destination.",
      "Never purchase, delete, publish, send messages, change account or security settings, or mutate production systems.",
      "Do not call browser_run_code_unsafe or an equivalent unsafe browser execution tool.",
      "Report the pages and evidence inspected, the interactions performed, and any generated temporary artifacts in checks.",
      "Keep changed_files empty.",
    ],
  },
  implement: {
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    serviceTier: "standard",
    configuredServiceTier: "default",
    fastMode: false,
    sandboxMode: "workspace-write",
    concurrencyPool: "sol",
    colorCode: 33,
    instructions: [
      "Implement only the explicitly assigned files or subsystem and preserve unrelated changes.",
      "Read the relevant contracts before editing, make the smallest complete change, and follow existing project patterns.",
      "Add or update focused tests when behavior changes and run the relevant validation.",
      "Do not self-approve, commit, push, or expand the assigned scope.",
      "Return completed only when the implementation and requested checks succeed, and report every changed file.",
    ],
  },
  review: {
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    serviceTier: "standard",
    configuredServiceTier: "default",
    fastMode: false,
    sandboxMode: "read-only",
    concurrencyPool: "sol",
    colorCode: 35,
    instructions: [
      "Review only the plan or Git changes explicitly named in the briefing and never modify files.",
      "Prioritize high-confidence correctness, security, reliability, compatibility, and validation findings with path:line evidence when applicable.",
      "Put required corrections in blockers, non-blocking observations in warnings, and inspected evidence or commands in checks.",
      "Begin summary with APPROVE when no correction is needed, COMMENT for non-blocking observations, or REQUEST_CHANGES when blockers require correction.",
      "Use completed for APPROVE or COMMENT and blocked for REQUEST_CHANGES.",
      "Return REQUEST_CHANGES with blocked status when the review target is ambiguous.",
      "Keep changed_files empty.",
    ],
  },
};

export const EXECUTOR_PROFILES = Object.freeze(
  Object.fromEntries(
    Object.entries(PROFILE_DEFINITIONS).map(([name, profile]) => [
      name,
      Object.freeze({
        name,
        model: profile.model,
        reasoningEffort: profile.reasoningEffort,
        serviceTier: profile.serviceTier,
        configuredServiceTier: profile.configuredServiceTier,
        fastMode: profile.fastMode,
        sandboxMode: profile.sandboxMode,
        concurrencyPool: profile.concurrencyPool,
        concurrencyLimit: profile.concurrencyLimit ?? null,
        colorCode: profile.colorCode,
        instructions: Object.freeze([...profile.instructions]),
      }),
    ]),
  ),
);

export const EXECUTOR_PROFILE_NAMES = Object.freeze(Object.keys(EXECUTOR_PROFILES));

export function getExecutorProfile(name) {
  return typeof name === "string" && Object.hasOwn(EXECUTOR_PROFILES, name)
    ? EXECUTOR_PROFILES[name]
    : null;
}
