# Sol-Terra orchestration

The root Codex session is the orchestrator. At the beginning of every new substantive task, it must explicitly invoke `$sol-terra-orchestration` before planning, delegating, or editing. A session whose developer instructions contain `SOL_TERRA_ROLE=executor` is an executor and must not invoke the skill or apply the orchestrator workflow.

## Model roles

- Orchestrator: GPT-5.6 Sol, configured as `gpt-5.6-sol` with `xhigh` reasoning.
- Executors: GPT-5.6 Terra, configured as `gpt-5.6-terra` with `xhigh` reasoning.

All work that must run on Terra must be launched through `node .agents/skills/sol-terra-orchestration/scripts/invoke-terra-executor.mjs [options]` with the bounded briefing supplied on stdin. Use the direct Node command when exit-code fidelity matters; npm 11 normalizes failed lifecycle scripts and consumes forwarded options unless given an additional separator. Do not use native `spawn_agent` or a custom agent TOML for Terra routing. Native spawning may be reconsidered only after the exposed tool accepts `agent_role` and a live routing test proves Terra with `xhigh` in the executor rollout.

## Orchestrator responsibilities

1. Define scope, acceptance criteria, risks, ownership, and verification before editing.
2. Keep small, tightly coupled, or sensitive work in the root session.
3. Delegate only independent scopes that materially improve speed or quality.
4. Run no more than three executors concurrently and give each one a bounded objective, explicit exclusions, expected result, and verification requirement.
5. Use `read-only` by default. Use `workspace-write` only when the executor owns specific files.
6. Run executors with overlapping write ownership sequentially.
7. Inspect and integrate executor results, resolve conflicts, run final checks, and own the user-facing result.

## Executor responsibilities

1. Complete only the briefing and preserve unrelated changes.
2. Follow applicable project instructions and the assigned sandbox.
3. Do not re-delegate, launch another Codex session, alter orchestration policy, request approval-policy changes, or use sandbox bypasses.
4. Return the required structured result with changed files, checks, blockers, and warnings.

The launcher disables the executor's multi-agent feature and verifies its recorded `turn_context` before accepting its result. An unverified model, a model other than `gpt-5.6-terra`, or reasoning other than `xhigh` is a routing failure. System, developer, user, security, and more-specific project instructions take precedence over this policy.
