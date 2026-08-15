# Verified Sol-Luna orchestration for Codex

This repository provides a small, dependency-free orchestration layer for Codex. It keeps planning and integration on GPT-5.6 Sol, moves bounded work to verified Sol or Luna profiles, and checks the model, reasoning effort, and service tier recorded by each Codex session before accepting its result.

The launchers use separate `codex exec` processes instead of native subagent routing. That keeps each route explicit and independently verifiable while native multi-agent execution remains disabled.

## Roles

| Role | Model | Effort | Tier | Access | Best use |
|---|---|---|---|---|---|
| Root | Sol | xhigh | Standard | Current session | Planning, delegation, integration, final validation |
| `explore` | Luna | max | Fast | Read-only | Repository discovery, documentation, contract tracing |
| `implement-lite` | Luna | max | Fast | Explicit workspace write | Small, low-risk, tightly bounded edits |
| `playwright` | Luna | max | Standard | Read-only repository | Browser inspection and authorized test interaction |
| `implement` | Sol | high | Standard | Explicit workspace write | Changes that need stronger engineering judgment |
| `review` | Sol | high | Standard | Read-only | Independent plan and code review |
| Ultra | Sol | ultra | Standard | Explicit takeover sandbox | Exceptional architecture, security, or concurrency decisions |

Every role uses `model_verbosity = "low"`. Fast profiles force `features.fast_mode = true`, while Standard roles force it to `false`. Reasoning effort and output verbosity are independent settings.

## Installation

The project requires only the Node.js runtime bundled with Codex.

```text
npm run install:global
```

The installer is idempotent and performs a complete preflight before changing anything. It:

- links the canonical skill to `$HOME/.agents/skills/sol-luna-orchestration`;
- uses a junction on Windows and a directory symlink on macOS or Linux;
- configures the global root as Sol/xhigh/Standard with low verbosity;
- preserves unrelated Codex configuration and instructions;
- installs the Ultra SessionStart and PreToolUse hooks without changing an existing `hooks.json`;
- migrates validated Sol-Sol and Sol-Terra links and managed blocks;
- refuses unrelated destinations, malformed managed markers, and ambiguous TOML.

Repository-specific Codex instructions still take precedence over the global defaults.

## Running an executor

The direct Node command is the canonical interface:

```text
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile explore --cwd . --sandbox read-only --timeout-seconds 900
```

Use `workspace-write` explicitly for either implementation profile:

```text
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile implement-lite --cwd . --sandbox workspace-write
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile implement --cwd . --sandbox workspace-write
```

Read-only profiles reject `workspace-write`. Write profiles do not enable it automatically. Every profile rejects `danger-full-access`, approval overrides, and bypass flags.

`npm run executor -- --profile ...` is available for convenience, but the direct command provides the clearest option forwarding and exit-code behavior.

The launcher prints a colored route banner to stderr when the terminal supports color:

```text
◆ PLAYWRIGHT · GPT-5.6-LUNA · MAX · STANDARD · READ-ONLY
```

Machine-readable JSON remains the only stdout output. `NO_COLOR`, `TERM=dumb`, and `FORCE_COLOR` are honored.

## Result contract

```json
{
  "status": "completed | blocked | failed",
  "profile": "explore | implement-lite | playwright | implement | review | null",
  "thread_id": "string | null",
  "model": "string | null",
  "reasoning_effort": "string | null",
  "service_tier": "fast | standard | null",
  "routing_verified": false,
  "sandbox_mode": "read-only | workspace-write",
  "summary": "string",
  "changed_files": [],
  "checks": [],
  "blockers": [],
  "warnings": []
}
```

The executor supplies only task fields. The launcher adds the profile and observed routing metadata. `routing_verified` becomes true only when rollout metadata confirms the profile's model, effort, and tier.

Exit codes are stable:

- `0`: completed with verified routing;
- `1`: blocked, failed, or Codex returned a task-level error;
- `2`: invalid invocation, capacity conflict, timeout, configuration, contract, MCP, or routing verification failure.

## Concurrency

Capacity is enforced with atomic leases at repository and machine scope:

- Luna: 10 active executors per repository and 10 across the PC;
- Sol: 4 active executors per repository and 4 across the PC;
- total machine capacity: 14 executors;
- Playwright: 2 across the PC, counted inside the Luna pool.

The root and Ultra process do not consume executor slots. Executors started by Ultra do. Reaching a limit fails immediately; the launcher does not create a hidden queue.

These numbers are upper bounds, not a target. Parallel work should have independent evidence or ownership. Overlapping writes must remain sequential, and creating redundant executors usually costs more integration time than it saves.

Inspect active leases and capacity with:

```text
node .agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs status --cwd .
```

Dead leases are removed only after their process is confirmed stopped. Corrupt state fails closed.

## Playwright profile

The `playwright` profile verifies that the `playwright` MCP is installed, enabled, and configured over stdio before Codex starts. Each run receives an isolated browser profile and a unique output directory under the operating system's temporary directory. The launcher removes those artifacts in `finally`, so it does not create `.playwright-mcp` in the repository.

The session must emit an actual Playwright MCP tool call. A successful result includes `playwright_mcp:verified` in `checks`; the executor cannot add that verification itself.

Full interaction is allowed on localhost and explicitly named development or test environments. External sites are observation-only unless the briefing explicitly authorizes a named state-changing action and destination. Purchases, deletion, publishing, messaging, account or security changes, production mutation, and `browser_run_code_unsafe` are always prohibited.

## Exclusive Ultra takeover

Ultra is not an executor profile. It temporarily replaces the root for one repository and requires both a reason and explicit human confirmation:

```text
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-sol-ultra.mjs --cwd . --reason "Named exceptional decision" --confirm-exclusive-takeover --sandbox read-only
```

The lock blocks normal sessions and has no automatic expiry. Ultra may delegate only through the verified profiles, which inherit its lock id and consume the normal capacity pools.

A verified terminal result releases the lock. Timeout, interruption, process, contract, or routing failure leaves `recovery-required`. Check and recover it only through the gate:

```text
node .agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs status --cwd .
node .agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs recover --cwd . --lock-id <exact-lock-id>
```

## Verification

```text
npm test
npm run verify:live
```

The unit suite covers profile routing, structured results, tiers, terminal colors, capacity races, Ultra locks, Playwright preflight and tool evidence, installer rollback, and migration behavior. Live verification checks the root and every profile against real rollout metadata, uses temporary repositories for write tests, and confirms that read-only checks do not alter this repository.
