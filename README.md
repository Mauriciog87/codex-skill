# Verified Sol-Sol orchestration for Codex

This repository configures Codex to use GPT-5.6 Sol in two distinct roles:

- The root session plans and coordinates with `gpt-5.6-sol` at `xhigh` reasoning.
- Executors handle bounded tasks with `gpt-5.6-sol` at `high` reasoning.

The executor model is not trusted from configuration alone. A Node.js launcher starts `codex exec`, captures its thread ID, reads the session rollout, and rejects the run unless `turn_context` records the expected model and reasoning effort.

```text
Root Codex session
  Sol / xhigh
       |
       v
Node.js launcher -> codex exec -> Sol / high
                         |
                         v
                rollout verification -> stable JSON result
```

## Requirements

- Codex CLI with access to `gpt-5.6-sol`
- Node.js 18 or newer
- Git

The current implementation is tested with Codex CLI `0.144.0`. It has no npm dependencies.

## Install globally

```bash
git clone https://github.com/Mauriciog87/codex-skill.git
cd codex-skill
npm run install:global
```

The installer is safe to run more than once. It makes these targeted changes:

- Links the repository skill to `$HOME/.agents/skills/sol-sol-orchestration`. Windows uses a junction; macOS and Linux use a directory symlink.
- Sets the global Codex model and reasoning defaults in `$CODEX_HOME/config.toml`, or `~/.codex/config.toml` when `CODEX_HOME` is not set.
- Adds one managed Sol-Sol block to the active global instruction file. A nonempty `AGENTS.override.md` takes precedence over `AGENTS.md`.
- Sets `agents.max_depth = 1` and `agents.max_threads = 4` for root sessions.
- Removes old Sol-Terra skill locations only after their identity or link target has been verified.

Existing configuration and instructions outside the managed values are preserved. New Codex sessions pick up the global changes; sessions that are already open do not reload them.

On another computer, clone the repository and run the same install command.

## Verify the setup

```bash
npm test
npm run verify:live
```

`npm test` runs the local unit and policy checks. `npm run verify:live` makes real model calls and therefore consumes account usage. The live check verifies all of the following:

1. A root session started without model overrides records Sol at `xhigh`.
2. The global skill link points to this repository.
3. An executor records Sol at `high`.
4. The executor can read the workspace in `read-only` mode and calculate the SHA-256 of `package.json`.
5. Git status is identical before and after verification.

## Run an executor

The launcher reads a bounded briefing from standard input. `read-only` is the default and should be used unless the executor owns specific files.

PowerShell:

```powershell
'Inspect the test suite and report gaps. Do not modify files.' |
  node .agents/skills/sol-sol-orchestration/scripts/invoke-sol-executor.mjs `
    --cwd . `
    --sandbox read-only `
    --timeout-seconds 900
```

Bash:

```bash
printf '%s\n' 'Inspect the test suite and report gaps. Do not modify files.' |
  node .agents/skills/sol-sol-orchestration/scripts/invoke-sol-executor.mjs \
    --cwd . \
    --sandbox read-only \
    --timeout-seconds 900
```

Use `--sandbox workspace-write` only when the briefing names the files or subsystem the executor owns. Do not run concurrent write tasks against overlapping files. The orchestration policy allows at most three independent executors at once.

`npm run executor` is a shorter entry point for the default arguments. Use the direct Node.js command when exact exit codes or forwarded options matter.

## Result contract

Every launcher invocation prints one JSON object:

```json
{
  "status": "completed",
  "thread_id": "019f...",
  "model": "gpt-5.6-sol",
  "reasoning_effort": "high",
  "routing_verified": true,
  "sandbox_mode": "read-only",
  "summary": "Inspection completed.",
  "changed_files": [],
  "checks": ["node --test passed"],
  "blockers": [],
  "warnings": []
}
```

If routing cannot be verified, `routing_verified` is `false`. Unknown model metadata is reported as `null`; the launcher does not substitute the model it expected to run.

| Exit code | Meaning |
| --- | --- |
| `0` | The task completed and routing was verified. |
| `1` | The task was blocked or failed, or Codex exited with an error. |
| `2` | The invocation, timeout, configuration, output contract, or routing check was invalid. |

## Operating rules

- Executors cannot delegate or launch another Codex session.
- The launcher disables multi-agent support inside executor sessions.
- `danger-full-access`, approval bypasses, and sandbox bypass flags are rejected.
- The root session owns planning, task boundaries, conflict resolution, and final verification.
- Repository-level `AGENTS.md` and `.codex/config.toml` files can override global defaults through normal Codex precedence.

The canonical workflow lives in `.agents/skills/sol-sol-orchestration`. Operational policy for this repository lives in `AGENTS.md`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run install:global` | Install or refresh the global skill, model defaults, and managed instructions. |
| `npm run executor` | Start one executor with default launcher options and a briefing on stdin. |
| `npm test` | Run unit tests and static policy checks. |
| `npm run verify:live` | Verify global root routing, executor routing, workspace access, and Git immutability. |
