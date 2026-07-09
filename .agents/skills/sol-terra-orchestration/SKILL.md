---
name: sol-terra-orchestration
description: Coordinate substantive software work with GPT-5.6 Sol as orchestrator and verified GPT-5.6 Terra executors at xhigh reasoning. Invoke explicitly at the start of every new substantive root Codex task and when planning, delegating, coordinating, or validating independent work.
---

# Sol Terra Orchestration

Run this workflow once before planning the first substantive request in a root task. Do not run it inside a session whose developer instructions contain `SOL_TERRA_ROLE=executor`.

## Workflow

1. Confirm that the root session uses `gpt-5.6-sol` with `xhigh` reasoning.
2. Define the outcome, acceptance criteria, risks, ownership boundaries, and final verification.
3. Keep small, tightly coupled, or sensitive work in the root session.
4. Split only independent work whose delegation materially improves speed or quality.
5. Send each Terra briefing through the skill's Node launcher on stdin. Include the objective, exclusions, owned files or subsystem, expected result, and required checks.
6. Use `read-only` unless the executor must edit explicitly assigned files. Run overlapping write scopes sequentially and cap independent concurrent executors at three.
7. Accept an executor result only when the launcher exits successfully and reports `gpt-5.6-terra` with `xhigh` reasoning.
8. Inspect integrated changes, resolve conflicts, run final verification in the root session, and report material limitations.

## Launcher

Run a read-only executor:

```text
briefing | node .agents/skills/sol-terra-orchestration/scripts/invoke-terra-executor.mjs --cwd <repository> --sandbox read-only --timeout-seconds 900
```

Run a write-enabled executor only for an assigned file scope:

```text
briefing | node .agents/skills/sol-terra-orchestration/scripts/invoke-terra-executor.mjs --cwd <repository> --sandbox workspace-write --timeout-seconds 900
```

The launcher reads the briefing from stdin, fixes the executor to `gpt-5.6-terra` with `xhigh`, disables the `multi_agent` feature, and validates the session rollout. Codex 0.144.0 requires `agents.max_depth` to be at least `1`, so the launcher uses that valid minimum while disabling the feature itself. Exit code `0` means completed with verified routing, `1` means the task or Codex execution failed, and `2` means the invocation, timeout, configuration, output contract, or routing verification failed.

`npm run executor` remains a convenience for the default arguments. Use the direct Node command for option forwarding and exact exit codes across the supported npm versions.

## Guardrails

- Do not use native `spawn_agent` or `.codex/agents/*.toml` for Terra routing.
- Do not alter approval policy, request `danger-full-access`, or use bypass flags.
- Do not ask executors to re-delegate, change orchestration policy, or own overlapping files concurrently.
- Do not claim model selection from configuration alone; require rollout evidence for every executor.

## Completion criteria

Complete the root task only after acceptance criteria pass, executor work is reviewed and integrated without conflicts, relevant checks pass, and unresolved limitations are disclosed.
