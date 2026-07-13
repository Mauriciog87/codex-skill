---
name: sol-sol-orchestration
description: Coordinate substantive software work with GPT-5.6 Sol at low output verbosity, xhigh reasoning as the root orchestrator, verified Sol executor profiles, and an exceptional human-confirmed Sol Ultra takeover. Invoke explicitly at the start of every new substantive root task and when planning, delegating, coordinating, or validating independent work.
---

# Sol Sol Orchestration

Run this workflow once before planning the first substantive request in a root task. Do not run it inside a session whose developer instructions contain `CODEX_ORCHESTRATION_ROLE=executor`. A session marked `CODEX_ORCHESTRATION_ROLE=ultra-orchestrator` already owns the exceptional takeover workflow and must not acquire another lock.

## Workflow

1. Confirm that the root session uses `gpt-5.6-sol` with `xhigh` reasoning and `model_verbosity = "low"`.
2. Define the outcome, acceptance criteria, risks, ownership boundaries, and final verification.
3. Keep planning, integration, small tasks, tightly coupled work, and sensitive decisions in the root session.
4. Delegate only independent scopes whose lower context cost or parallelism materially improves the work.
5. Select exactly one executor profile:
   - `explore`: Sol `medium`, read-only repository discovery and contract tracing.
   - `implement`: Sol `high`, bounded changes to explicitly assigned files or a subsystem.
   - `review`: Sol `high`, read-only review of an explicitly named plan or Git change.
6. Send a task-local briefing through the Node launcher. Include the objective, exclusions, owned files or review target, expected result, and required checks.
7. Run no more than three independent executors concurrently and run overlapping write scopes sequentially.
8. Accept a result only when the launcher verifies Sol with the profile's fixed reasoning effort and reports `routing_verified: true`.
9. Inspect and integrate results, resolve conflicts, run final checks, and own the user-facing result.

Do not create a planner executor. The root Sol/xhigh session owns planning and may use `review` for an independent critique.

## Launcher

Explore in read-only mode:

```text
briefing | node .agents/skills/sol-sol-orchestration/scripts/invoke-sol-executor.mjs --profile explore --cwd <repository> --sandbox read-only --timeout-seconds 900
```

Implement only an explicitly assigned write scope:

```text
briefing | node .agents/skills/sol-sol-orchestration/scripts/invoke-sol-executor.mjs --profile implement --cwd <repository> --sandbox workspace-write --timeout-seconds 900
```

Review an explicitly named plan or Git change:

```text
briefing | node .agents/skills/sol-sol-orchestration/scripts/invoke-sol-executor.mjs --profile review --cwd <repository> --sandbox read-only --timeout-seconds 900
```

The launcher requires `--profile`. It rejects sandbox/profile mismatches and `danger-full-access`, fixes the model and effort, disables the executor's multi-agent feature, and validates the session rollout. Exit code `0` means completed with verified routing, `1` means blocked or failed, and `2` means the invocation, timeout, configuration, contract, or routing verification failed.

For `review`, require `APPROVE` or `COMMENT` with completed status, or `REQUEST_CHANGES` with blocked status and at least one blocker. Treat missing or ambiguous review targets as `REQUEST_CHANGES`.

`npm run executor` remains a convenience entry point. Use the direct Node command for reliable option forwarding and exact exit codes.

## Exclusive Ultra takeover

Use Sol `ultra` only when a specific architecture, security, concurrency, distributed-invariant, or contradictory-contract decision cannot be resolved responsibly at root Sol/xhigh. The human must provide both an auditable reason and the explicit confirmation flag. Ultra temporarily replaces the root for one repository; it is not a fourth executor profile.

Read-only takeover:

```text
briefing | node .agents/skills/sol-sol-orchestration/scripts/invoke-sol-ultra.mjs --cwd <repository> --reason <reason> --confirm-exclusive-takeover --sandbox read-only --timeout-seconds 1800
```

Workspace-write takeover requires an explicit sandbox option:

```text
briefing | node .agents/skills/sol-sol-orchestration/scripts/invoke-sol-ultra.mjs --cwd <repository> --reason <reason> --confirm-exclusive-takeover --sandbox workspace-write --timeout-seconds 1800
```

Ultra pins Sol `ultra`, disables native multi-agent execution, and may delegate only through the verified `explore`, `implement`, and `review` launchers. Its repository lock blocks normal executors and other sessions. Executors started by Ultra must inherit the matching `CODEX_ORCHESTRATION_LOCK_ID`.

Inspect or recover state only through the gate:

```text
node .agents/skills/sol-sol-orchestration/scripts/orchestration-gate.mjs status --cwd <repository>
node .agents/skills/sol-sol-orchestration/scripts/orchestration-gate.mjs recover --cwd <repository> --lock-id <exact-lock-id>
```

A verified terminal result releases the lock. Timeout, interruption, process failure, invalid output, or routing failure leaves `recovery-required`. Recovery has no time-based shortcut: it requires the exact lock id and a stopped owner process.

## Guardrails

- Do not use native `spawn_agent` or `.codex/agents/*.toml` for executor routing.
- Do not alter approval policy, request `danger-full-access`, or use bypass flags.
- Do not let executors re-delegate, change orchestration policy, commit, push, or own overlapping files concurrently.
- Keep `explore` and `review` read-only and require explicit `workspace-write` for `implement`.
- Escalate exploration to the root when it requires architectural, security, concurrency, distributed-invariant, or contradictory-contract decisions.
- Do not claim model selection from configuration or executor text; require rollout evidence.
- Do not start Ultra without a concrete reason and explicit human confirmation.
- Do not delete or edit lock files manually. Treat corrupt state as blocked and use exact-id recovery.
- Treat SessionStart and PreToolUse hooks as defense in depth, not complete enforcement across every tool path.

## Completion Criteria

Complete the root task only after profile routing is verified, executor results are reviewed and integrated without conflicts, relevant checks pass, every Ultra lock is released or explicitly reported as recovery-required, and unresolved limitations are disclosed.
