---
name: sol-luna-orchestration
description: Coordinate substantive software work with GPT-5.6 Sol as the low-verbosity root, verified Sol and Luna executor profiles, differentiated concurrency, Playwright MCP isolation, and an exceptional human-confirmed Sol Ultra takeover. Invoke explicitly before planning, delegating, coordinating, or validating independent work.
---

# Sol-Luna Orchestration

Run this workflow once before the first substantive request in a root task. Do not run it inside a session whose developer instructions contain `CODEX_ORCHESTRATION_ROLE=executor`. A session marked `CODEX_ORCHESTRATION_ROLE=ultra-orchestrator` already owns the exceptional takeover workflow and must not acquire another lock.

## Workflow

1. Confirm that the root uses `gpt-5.6-sol`, `xhigh` reasoning, the Standard service tier, and `model_verbosity = "low"`.
2. Define the outcome, acceptance criteria, risks, ownership boundaries, and final verification.
3. Keep planning, integration, tightly coupled work, and sensitive decisions in the root.
4. Delegate only independent scopes when parallelism or lower context cost materially helps. Capacity is not a fan-out target.
5. Select exactly one verified profile from the matrix below.
6. Send a bounded briefing through the canonical Node launcher. Include objective, exclusions, owned files or review target, expected result, and required checks.
7. Serialize overlapping writes and avoid redundant executors whose results would cost more to integrate than they save.
8. Accept a result only when model, effort, and service tier are verified from rollout metadata and `routing_verified` is true.
9. Inspect and integrate the evidence, resolve conflicts, run final checks, and own the user-facing result.

## Profiles

| Profile | Model | Effort | Tier | Sandbox | Purpose |
|---|---|---|---|---|---|
| `explore` | `gpt-5.6-luna` | `max` | Fast | `read-only` | Broad discovery and contract tracing |
| `implement-lite` | `gpt-5.6-luna` | `max` | Fast | `workspace-write` | Small, explicit, low-risk edits |
| `playwright` | `gpt-5.6-luna` | `max` | Standard | `read-only` | Browser inspection and authorized test interaction through Playwright MCP |
| `implement` | `gpt-5.6-sol` | `high` | Standard | `workspace-write` | Bounded implementation requiring stronger judgment |
| `review` | `gpt-5.6-sol` | `high` | Standard | `read-only` | Independent plan or Git-change review |

All roles use low output verbosity. Fast profiles force `features.fast_mode = true`; Standard roles force it to `false`. Model, effort, tier, and sandbox are fixed by the profile and cannot be overridden by the caller.

## Launcher

The canonical interface is:

```text
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile <profile> --cwd <repository> --sandbox <mode> --timeout-seconds 900
```

Examples:

```text
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile explore --cwd <repository> --sandbox read-only
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile implement-lite --cwd <repository> --sandbox workspace-write
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile playwright --cwd <repository> --sandbox read-only
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile implement --cwd <repository> --sandbox workspace-write
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile review --cwd <repository> --sandbox read-only
```

`npm run executor` remains a convenience entry point. Use the direct command for exact option forwarding and exit codes. Code `0` means completed with verified routing, `1` means blocked or failed, and `2` means invocation, capacity, timeout, configuration, contract, MCP, or routing verification failed.

The launcher emits a colored route banner to stderr when the terminal supports color and reserves stdout for one JSON result. It respects `NO_COLOR`, `TERM=dumb`, and `FORCE_COLOR`.

## Capacity

- Luna profiles share a hard limit of 10 active executors per repository and 10 across the PC.
- Sol profiles share a hard limit of 4 active executors per repository and 4 across the PC.
- The machine-wide aggregate limit is 14 executors.
- Playwright has an additional machine-wide limit of 2 and consumes Luna capacity.
- Root and Ultra processes do not consume executor slots. Executors delegated by Ultra do.
- Capacity acquisition is atomic and fails immediately instead of queuing.
- Dead-process leases are pruned only after confirming that the owner PID is no longer active. Corrupt state fails closed.

Inspect repository and machine utilization with:

```text
node .agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs status --cwd <repository>
```

## Profile contracts

`explore` never changes files. It returns conclusions, `path:line` evidence, contracts, risks, and open questions. It blocks and escalates when the work requires architecture, security, concurrency, distributed-invariant, or contradictory-contract decisions.

`implement-lite` owns only a small, explicit, low-risk change. It blocks and recommends `implement` when the scope expands or judgment becomes cross-cutting.

`implement` owns only the assigned files or subsystem, makes the smallest complete change, runs relevant checks, and never self-approves, commits, or pushes.

`review` returns `APPROVE` or `COMMENT` with completed status, or `REQUEST_CHANGES` with blocked status and at least one blocker. It never changes files.

`playwright` requires an installed and enabled stdio Playwright MCP. The launcher gives it an isolated temporary browser profile and output directory, verifies that a Playwright MCP tool was actually used, and removes temporary artifacts. Full interaction is allowed only on localhost and explicitly named development or test environments. External sites are observation-only unless the briefing explicitly authorizes a named state-changing action and destination. Purchases, deletion, publishing, messaging, account or security changes, production mutation, and `browser_run_code_unsafe` are prohibited.

## Exclusive Ultra takeover

Use Sol `ultra` on Standard only when a named architecture, security, concurrency, distributed-invariant, or contradictory-contract decision cannot be resolved responsibly by root Sol/xhigh. The human must provide a reason and `--confirm-exclusive-takeover`.

```text
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-sol-ultra.mjs --cwd <repository> --reason <reason> --confirm-exclusive-takeover --sandbox read-only
```

Workspace writing requires an explicit `--sandbox workspace-write`. Ultra replaces the root temporarily, disables native multi-agent execution, and delegates only through verified profiles. Its executors inherit `CODEX_ORCHESTRATION_LOCK_ID`, consume the normal capacity pools, and serialize overlapping writes.

A verified terminal result releases the lock. Timeout, interruption, process failure, invalid output, or routing failure leaves `recovery-required`. Recover only after the owner process stops and only with the exact lock id:

```text
node .agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs recover --cwd <repository> --lock-id <exact-lock-id>
```

## Guardrails

- Do not use native `spawn_agent` or custom agent TOML for profile routing.
- Do not alter approval policy, request `danger-full-access`, or use bypasses.
- Do not let executors re-delegate, alter orchestration policy, commit, push, or own overlapping files concurrently.
- Keep `explore`, `playwright`, and `review` read-only. Require explicit workspace write for both implementation profiles.
- Do not infer model, effort, or tier from configuration or executor prose; require rollout evidence.
- Do not manually edit or delete orchestration state.
- Treat hooks as defense in depth, not complete enforcement across every tool path.

## Completion criteria

Complete the root task only after every used profile has verified routing, results are integrated without conflicts, relevant checks pass, Playwright usage is verified when requested, every Ultra lock is released or reported as recovery-required, and unresolved limitations are disclosed.
