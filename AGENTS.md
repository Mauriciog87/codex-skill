# Sol-Sol orchestration

The root Codex session is the orchestrator. At the beginning of every new substantive task, it must explicitly invoke `$sol-sol-orchestration` before planning, delegating, or editing. A session whose developer instructions contain `CODEX_ORCHESTRATION_ROLE=executor` is an executor and must not invoke the skill or apply the orchestrator workflow. A session marked `CODEX_ORCHESTRATION_ROLE=ultra-orchestrator` owns an already authorized exclusive takeover and must not acquire another one.

## Model roles

- Orchestrator and planner: `gpt-5.6-sol` with `xhigh` reasoning.
- `explore` executor: `gpt-5.6-sol` with `medium` reasoning and `read-only` sandbox.
- `implement` executor: `gpt-5.6-sol` with `high` reasoning and explicitly requested `workspace-write` sandbox.
- `review` executor: `gpt-5.6-sol` with `high` reasoning and `read-only` sandbox.
- Exceptional takeover: `gpt-5.6-sol` with `ultra` reasoning and a human-confirmed repository lock.

All executor work must use `node .agents/skills/sol-sol-orchestration/scripts/invoke-sol-executor.mjs --profile explore|implement|review [options]` with a bounded briefing on stdin. The profile is mandatory and fixes the reasoning effort and sandbox policy. Use the direct Node command when exit-code fidelity matters; npm 11 normalizes failed lifecycle scripts and can consume forwarded options unless given an additional separator.

Do not use native `spawn_agent` or a custom agent TOML for executor routing. Reconsider native spawning only after the tool exposes `agent_role` and live routing tests prove every required Sol profile and effort.

## Exclusive Ultra takeover

Use Ultra only for a named decision that root Sol/xhigh cannot resolve responsibly. Activation requires a nonempty `--reason` and `--confirm-exclusive-takeover`. The canonical launcher is `node .agents/skills/sol-sol-orchestration/scripts/invoke-sol-ultra.mjs`; `npm run ultra` is only a convenience command.

The lock is repository-scoped and has no time-based expiry. Normal executors and unrelated sessions must stop while it exists. Ultra may run only verified profile executors that inherit the matching `CODEX_ORCHESTRATION_LOCK_ID`; it must still serialize overlapping writes. A verified terminal result releases the lock. Timeout, interruption, process, contract, or routing failure leaves `recovery-required`.

Inspect state with `node .agents/skills/sol-sol-orchestration/scripts/orchestration-gate.mjs status --cwd <repository>`. Recover only after the owner process stops, using `recover --cwd <repository> --lock-id <exact-lock-id>`. Never remove state manually.

Global SessionStart and PreToolUse hooks surface and enforce the lock where Codex supports interception. They are defense in depth and do not replace the launcher lock or repository policy.

## Orchestrator responsibilities

1. Own planning, acceptance criteria, risks, task boundaries, integration, and final verification.
2. Keep small, tightly coupled, sensitive, or architecture-heavy work in the root session.
3. Use `explore` for broad discovery or contract tracing that would materially grow root context.
4. Use `implement` only for explicit, non-overlapping file or subsystem ownership.
5. Use `review` for an independent critique of a named plan or for high-risk, security-sensitive, architectural, public-API, migration, concurrency, or difficult-to-validate changes.
6. Run no more than three independent executors concurrently and run overlapping writes sequentially.
7. Inspect executor evidence instead of repeating discovery unless verification is necessary.
8. Request human-confirmed Ultra takeover only for an explicit exceptional reason, then pause this root while Ultra owns the repository.

## Executor responsibilities

1. Complete only the briefing and preserve unrelated changes.
2. Follow the selected profile, applicable project instructions, and assigned sandbox.
3. Do not re-delegate, launch another Codex session, alter orchestration or approval policy, use bypasses, commit, or push.
4. Return the required structured result with profile-appropriate changed files, checks, blockers, and warnings.

`explore` must return no changed files and must block rather than make architecture, security, concurrency, distributed-invariant, or contradictory-contract decisions. `implement` must not self-approve. `review` must return `APPROVE` or `COMMENT` with completed status, or `REQUEST_CHANGES` with blocked status and at least one blocker.

The launcher disables multi-agent execution and verifies `turn_context`. An unverified model, a model other than `gpt-5.6-sol`, or an effort different from the selected profile is a routing failure. System, developer, user, security, and more-specific project instructions take precedence over this policy.
