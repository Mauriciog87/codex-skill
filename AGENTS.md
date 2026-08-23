# Sol-Luna orchestration

The root Codex session is the orchestrator. At the beginning of every new substantive task, explicitly invoke `$sol-luna-orchestration` before planning, delegating, or editing. A session whose developer instructions contain `CODEX_ORCHESTRATION_ROLE=executor` is an executor and must not invoke the skill or apply the root workflow. A session marked `CODEX_ORCHESTRATION_ROLE=ultra-orchestrator` owns an already authorized exclusive takeover and must not acquire another one.

## Model roles

| Role | Model | Effort | Tier | Sandbox |
|---|---|---|---|---|
| Root and planner | `gpt-5.6-sol` | `xhigh` | Standard | Current session |
| `explore` | `gpt-5.6-luna` | `max` | Fast | `read-only` |
| `implement-lite` | `gpt-5.6-luna` | `max` | Fast | Explicit `workspace-write` |
| `playwright` | `gpt-5.6-luna` | `max` | Standard | `read-only` for repository files |
| `implement` | `gpt-5.6-sol` | `high` | Standard | Explicit `workspace-write` |
| `review` | `gpt-5.6-sol` | `high` | Standard | `read-only` |
| Exceptional takeover | `gpt-5.6-sol` | `ultra` | Standard | Human-confirmed repository lock |

Every role uses `model_verbosity = "low"`. Fast profiles force `features.fast_mode = true`; Standard roles force it to `false`. Verbosity controls response length independently from reasoning effort.

The launchers require Codex CLI 0.147.0 or a later compatible version and use the experimental Codex App Server over local stdio JSON-RPC. They do not fall back to the legacy execution path. Fast maps to protocol `priority`; Standard maps to protocol `default`.

All executor work must use:

```text
node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile explore|implement-lite|playwright|implement|review [options]
```

The briefing is read from stdin. The profile fixes model, reasoning effort, tier, and sandbox. Do not use native `spawn_agent` or custom agent TOML for executor routing. Reconsider native spawning only after it exposes role-specific routing and live tests prove every required model, effort, and tier.

## Concurrency

- Luna profiles share a limit of 10 executors per repository and 10 across the PC.
- Sol profiles share a limit of 4 executors per repository and 4 across the PC.
- The machine-wide aggregate limit is 14.
- Playwright consumes Luna capacity and has a separate machine-wide limit of 2.
- Root and Ultra are excluded; executors started by Ultra are included.
- These are maximum capacities, not fan-out targets. Delegate only useful independent scopes.
- Run overlapping writes sequentially.

The launchers acquire atomic repository and machine leases and fail immediately with code `2` when a pool is full. Inspect utilization through `orchestration-gate.mjs status`. Never manually edit state.

## Exclusive Ultra takeover

Use Ultra only for a named decision that root Sol/xhigh cannot resolve responsibly. Activation requires a nonempty `--reason` and `--confirm-exclusive-takeover`. The canonical launcher is:

```text
node .agents/skills/sol-luna-orchestration/scripts/invoke-sol-ultra.mjs
```

The repository lock has no time-based expiry. Every Ultra epoch receives a repository-persistent monotonic generation. Normal executors and unrelated sessions stop while it exists. Ultra may run only verified profiles carrying the matching `CODEX_ORCHESTRATION_LOCK_ID` and `CODEX_ORCHESTRATION_GENERATION`; those executors consume the normal capacity pools and still serialize overlapping writes. State and result transitions revalidate both values. A verified terminal result releases the lock. Timeout, interruption, process, contract, or routing failure leaves `recovery-required`.

State v2 registers launcher and App Server process identities for Ultra and its executors. Recovery succeeds only when every registered identity is confirmed dead or reused; live and unknown identities fail closed, and recovery never kills a process. Version 1 state remains `legacy-unfenced` until explicitly recovered with `--confirm-legacy-recovery`. History is immutable, sanitized, retention-bounded evidence and is not lock authority. There is no TTL, heartbeat, automatic recovery, worktree isolation, dependency fallback, or `shell: true`. Descendants outside registered launcher/App Server paths cannot be identified portably or atomically stopped.

Inspect or recover only through:

```text
node .agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs status --cwd <repository>
node .agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs history --cwd <repository> --limit 50
node .agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs recover --cwd <repository> --lock-id <exact-lock-id>
```

## Orchestrator responsibilities

1. Own planning, acceptance criteria, risk, task boundaries, integration, and final verification.
2. Keep tightly coupled, sensitive, or architecture-heavy work in the root.
3. Use `explore` for broad discovery that would materially grow root context.
4. Use `implement-lite` only for small, explicit, low-risk edits without architecture or security judgment.
5. Use `playwright` for isolated browser evidence and authorized test interactions.
6. Use `implement` for bounded changes needing stronger engineering judgment.
7. Use `review` for independent critique of a named plan or high-risk Git change.
8. Inspect executor evidence instead of repeating discovery unless verification requires it.
9. Request Ultra only for an explicit exceptional reason and pause while it owns the repository.

## Executor responsibilities

1. Complete only the briefing and preserve unrelated changes.
2. Follow the selected profile, applicable project instructions, and assigned sandbox.
3. Do not re-delegate, launch another Codex session, alter orchestration or approval policy, use bypasses, commit, or push.
4. Return the required structured result with changed files, checks, blockers, and warnings.

`explore` returns no changed files and escalates architectural, security, concurrency, distributed-invariant, or contradictory-contract decisions. `implement-lite` escalates expanded or cross-cutting work to `implement`. Neither implementation profile self-approves. `review` returns `APPROVE` or `COMMENT` with completed status, or `REQUEST_CHANGES` with blocked status and at least one blocker.

`playwright` keeps repository files unchanged, uses the configured Playwright MCP in an isolated temporary environment, and never calls `browser_run_code_unsafe`. Full interaction is limited to localhost and named dev/test targets. External state changes require explicit destination-specific authorization, and purchases, deletion, publishing, messaging, account/security changes, or production mutation are prohibited.

The launcher requires matching `thread/settings/updated` evidence for effective model, effort, and tier plus rollout `turn_context` evidence for the model and effort used during the turn. Missing, contradictory, or incompatible protocol evidence is a routing failure. System, developer, security, user, and more-specific project instructions take precedence over this policy.
