# Verified Sol-Sol orchestration for Codex

This repository configures Codex to use GPT-5.6 Sol as one orchestrator and three verified executor profiles:

| Role | Model | Reasoning | Verbosity | Sandbox |
| --- | --- | --- | --- | --- |
| Root orchestrator and planner | `gpt-5.6-sol` | `xhigh` | `low` | Task-specific |
| `explore` | `gpt-5.6-sol` | `medium` | `low` | `read-only` |
| `implement` | `gpt-5.6-sol` | `high` | `low` | Explicit `workspace-write` |
| `review` | `gpt-5.6-sol` | `high` | `low` | `read-only` |
| Exceptional Ultra takeover | `gpt-5.6-sol` | `ultra` | `low` | Explicit per takeover |

The launcher does not trust configuration or model self-reporting. It starts `codex exec`, captures the thread ID, reads the session rollout, and rejects the run unless `turn_context` records the model and reasoning effort fixed by the selected profile.

All roles pin `model_verbosity = "low"` for concise output without reducing their configured reasoning effort.

```text
Root Codex session: Sol / xhigh
  |
  +-- explore:   Sol / medium / read-only
  +-- implement: Sol / high   / workspace-write
  +-- review:    Sol / high   / read-only
           |
           +-- rollout verification -> stable JSON result

Human-confirmed exception: Sol / ultra
  +-- exclusive repository lock
  +-- verified profile executors only
  +-- verified terminal result or manual recovery
```

The root owns planning, delegation, integration, and final verification. There is no planner executor.

## Requirements

- Codex CLI with access to `gpt-5.6-sol`
- Node.js 18 or newer
- Git

The project has no npm dependencies.

## Install globally

```bash
git clone https://github.com/Mauriciog87/codex-skill.git
cd codex-skill
npm run install:global
```

The idempotent installer:

- links the repository skill to `$HOME/.agents/skills/sol-sol-orchestration` using a Windows junction or a macOS/Linux directory symlink;
- sets Sol/xhigh defaults in `$CODEX_HOME/config.toml`, or `~/.codex/config.toml` when `CODEX_HOME` is unset;
- adds one managed Sol-Sol block to the active global instruction file;
- keeps root limits at `agents.max_depth = 1` and `agents.max_threads = 4`;
- enables hooks and adds separate managed inline SessionStart and PreToolUse definitions for the repository lock;
- removes legacy Sol-Terra locations only after verifying their identity or link target;
- preserves unrelated configuration, instruction content, and the existing `$CODEX_HOME/hooks.json` byte for byte.

Open a new Codex session after installation so global changes are loaded. User-level command hooks require an explicit trust review in Codex; open `/hooks`, inspect the two Sol-Sol definitions, and trust them before relying on hook enforcement. The lock in the launchers remains authoritative even while hooks await trust.

## Run an executor

The launcher requires a bounded briefing on stdin and an explicit profile.

Explore a codebase without modifying it:

```powershell
'Trace the authentication flow. Return path:line evidence and unresolved contracts.' |
  node .agents/skills/sol-sol-orchestration/scripts/invoke-sol-executor.mjs `
    --profile explore `
    --cwd . `
    --sandbox read-only `
    --timeout-seconds 900
```

Implement an explicitly assigned scope:

```powershell
'Own only src/auth.mjs and its focused tests. Implement the assigned validation and run those tests.' |
  node .agents/skills/sol-sol-orchestration/scripts/invoke-sol-executor.mjs `
    --profile implement `
    --cwd . `
    --sandbox workspace-write `
    --timeout-seconds 900
```

Review an explicit plan or Git change:

```powershell
'Review the current Git diff for the authentication change. Do not modify files.' |
  node .agents/skills/sol-sol-orchestration/scripts/invoke-sol-executor.mjs `
    --profile review `
    --cwd . `
    --sandbox read-only `
    --timeout-seconds 900
```

The same arguments work in Bash. Use the direct Node command when exact exit codes or option forwarding matter. `npm run executor` remains a convenience entry point.

The launcher rejects missing or unknown profiles, profile/sandbox mismatches, configurable reasoning effort, and `danger-full-access`. Do not run concurrent write tasks against overlapping files. The root may run at most three independent executors at once.

## Result contract

Every invocation prints one JSON object in a stable property order:

```json
{
  "status": "completed",
  "profile": "explore",
  "thread_id": "019f...",
  "model": "gpt-5.6-sol",
  "reasoning_effort": "medium",
  "routing_verified": true,
  "sandbox_mode": "read-only",
  "summary": "Exploration completed.",
  "changed_files": [],
  "checks": ["Relevant contracts traced"],
  "blockers": [],
  "warnings": []
}
```

`profile` is added by the launcher rather than echoed by the executor. Invalid invocations report it as `null`. Unknown routing metadata is also reported as `null`; a mismatch reports the actual recorded values.

| Exit code | Meaning |
| --- | --- |
| `0` | The task completed with verified routing. |
| `1` | The task was blocked or failed, Codex failed, or review requested changes. |
| `2` | The invocation, sandbox, timeout, configuration, output contract, or routing verification was invalid. |

For `review`, `APPROVE` and `COMMENT` use completed status. `REQUEST_CHANGES` uses blocked status and includes at least one blocker.

## Run an exclusive Ultra takeover

Ultra is an exceptional replacement for the root orchestrator, not an executor profile. Use it only when a named architectural, security, concurrency, or distributed-invariant decision genuinely requires more reasoning than root Sol/xhigh. A takeover requires a human-readable reason and the explicit confirmation flag.

Read-only takeover:

```powershell
'Resolve the named architecture decision, verify the result, and do not modify files.' |
  node .agents/skills/sol-sol-orchestration/scripts/invoke-sol-ultra.mjs `
    --cwd . `
    --reason 'Cross-cutting architecture decision' `
    --confirm-exclusive-takeover `
    --sandbox read-only `
    --timeout-seconds 1800
```

Use `--sandbox workspace-write` only when the takeover itself is explicitly authorized to modify the repository. Ultra can delegate to the three existing verified profiles, but native multi-agent spawning remains disabled. No more than three independent executors may run concurrently, and overlapping writes remain sequential.

The takeover acquires a repository-scoped lock under `$CODEX_HOME/sol-sol-orchestration/state`. Normal executors fail while the lock exists. Ultra executors are accepted only when they inherit its exact `CODEX_ORCHESTRATION_LOCK_ID`.

Inspect a repository lock:

```powershell
node .agents/skills/sol-sol-orchestration/scripts/orchestration-gate.mjs status --cwd .
```

Timeout, interruption, process failure, invalid output, or routing failure leaves the lock in `recovery-required`. There is no automatic expiry. After confirming that the owner process has stopped, recover with the exact id printed by the launcher or status command:

```powershell
node .agents/skills/sol-sol-orchestration/scripts/orchestration-gate.mjs recover --cwd . --lock-id <exact-lock-id>
```

Never delete state files manually. SessionStart and PreToolUse hooks add another guardrail, but Codex does not yet intercept every possible tool path, so the launcher lock and repository policy remain required.

Ultra prints a separate stable contract with `mode: "ultra"`, its `lock_id`, verified routing metadata, and an `executors` array reconstructed from registered leases rather than trusted from model output. Exit `0` means Ultra and all recorded executors are verified and the lock was released. Exit `1` means a verified blocked or failed task and a released lock. Exit `2` means an invalid invocation, conflict, timeout, process, contract, or routing failure and requires recovery.

## Verify the setup

```bash
npm test
npm run verify:live
```

`npm test` runs unit and static policy checks. `npm run verify:live` makes real model calls and consumes account usage. It verifies:

1. a root session without overrides records Sol/xhigh;
2. `explore` records Sol/medium and reads `package.json` in read-only mode;
3. `implement` records Sol/high and performs one bounded write in a temporary Git repository;
4. `review` records Sol/high, approves the deterministic temporary diff, and does not modify it;
5. local and global skill discovery use the same canonical content;
6. a normal executor is blocked during a takeover;
7. read-only Sol/ultra records verified routing and releases its lock;
8. workspace-write Sol/ultra can invoke a verified implement executor in a temporary repository;
9. timeout produces `recovery-required` and exact-id manual recovery succeeds;
10. independent repositories do not block each other;
11. the real repository's Git status is identical before and after read-only verification.

## Operating rules

- Executors cannot delegate or launch another Codex session.
- The launcher disables multi-agent support inside executors.
- Executors cannot alter approvals, use bypasses, commit, or push.
- `explore` and `review` are always read-only.
- `implement` requires explicit file or subsystem ownership and explicit `workspace-write`.
- Repository-level `AGENTS.md` and `.codex/config.toml` can override global defaults through normal Codex precedence.
- Ultra requires human confirmation, owns one repository exclusively, and delegates only through verified profiles.
- Locks never expire automatically; recovery requires the exact id and an inactive owner.
- Hooks supplement the lock but are not a complete security boundary.

The canonical workflow lives in `.agents/skills/sol-sol-orchestration`. Repository policy lives in `AGENTS.md`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run install:global` | Install or refresh the global skill, root defaults, and managed instructions. |
| `npm run executor` | Start the profile-aware launcher with a briefing on stdin. |
| `npm run ultra` | Start a human-confirmed exclusive Ultra takeover with a briefing on stdin. |
| `npm run ultra:gate` | Inspect or recover repository takeover state. |
| `npm test` | Run unit tests and static policy checks. |
| `npm run verify:live` | Verify root routing, all executor profiles, locking, Ultra routing, and recovery. |
