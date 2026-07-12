const PROFILE_DEFINITIONS = {
  explore: {
    reasoningEffort: "medium",
    sandboxMode: "read-only",
    instructions: [
      "Explore the assigned question without modifying files or running state-changing commands.",
      "Search broadly, read only the evidence needed, and stop when the briefing can be answered.",
      "Report a direct conclusion, path:line evidence, relevant contracts, risks, and unresolved questions.",
      "Do not return raw file dumps or long command output, and identify inferences explicitly.",
      "Return blocked and recommend escalation to the root when the task requires architectural decisions, security judgment, concurrency analysis, distributed invariants, or resolution of contradictory contracts.",
      "Keep changed_files empty.",
    ],
  },
  implement: {
    reasoningEffort: "high",
    sandboxMode: "workspace-write",
    instructions: [
      "Implement only the explicitly assigned files or subsystem and preserve unrelated changes.",
      "Read the relevant contracts before editing, make the smallest complete change, and follow existing project patterns.",
      "Add or update focused tests when behavior changes and run the relevant validation.",
      "Do not self-approve, commit, push, or expand the assigned scope.",
      "Return completed only when the implementation and requested checks succeed, and report every changed file.",
    ],
  },
  review: {
    reasoningEffort: "high",
    sandboxMode: "read-only",
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
        reasoningEffort: profile.reasoningEffort,
        sandboxMode: profile.sandboxMode,
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
