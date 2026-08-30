# Sol-Luna orchestration

The root Codex session is the orchestrator. Invoke `$sol-luna-orchestration` at the start of every substantive task, before planning, delegating, or editing. A session with `CODEX_ORCHESTRATION_ROLE=executor` in its developer instructions is an executor; it must not invoke the skill or apply the root workflow. A session marked `CODEX_ORCHESTRATION_ROLE=ultra-orchestrator` already owns an authorized exclusive takeover and must not acquire another one.

## Model roles

| Role | Model | Effort | Tier | Sandbox | Workspace |
|---|---|---|---|---|---|
| Root and planner | `gpt-5.6-sol` | `xhigh` | Standard | Current session | Main checkout |
| `explore` | `gpt-5.6-luna` | `max` | Fast | `read-only` | Shared checkout |
| `implement-lite` | `gpt-5.6-luna` | `max` | Fast | Explicit `workspace-write` | Isolated worktree |
| `playwright` | `gpt-5.6-luna` | `max` | Standard | `read-only` for repository files | Shared checkout |
| `implement` | `gpt-5.6-sol` | `high` | Standard | Explicit `workspace-write` | Isolated worktree |
| `review` | `gpt-5.6-sol` | `high` | Standard | `read-only` | Exact candidate worktree when reviewing a candidate |
| Exceptional takeover | `gpt-5.6-sol` | `ultra` | Standard | Human-confirmed repository lock | Main checkout |

Every role uses `model_verbosity = "low"`. Fast profiles force `features.fast_mode = true`; Standard roles force it to `false`. Verbosity controls response length independently from reasoning effort.

The launchers require Codex CLI 0.147.0 or a later compatible version and use the experimental Codex App Server over local stdio JSON-RPC. They do not fall back to the legacy execution path. Fast maps to protocol `priority`; Standard maps to protocol `default`.

All executor work must use:

```text
node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile explore|implement-lite|playwright|implement|review [options]
```

The briefing comes from stdin. The selected profile fixes the model, reasoning effort, tier, sandbox, workspace strategy, and capabilities. Writer profiles require at least one `--write-root`. Their worktree adds isolation but does not replace `workspace-write`. Do not use native `spawn_agent` or custom agent TOML for executor routing. Reconsider native spawning only when it supports role-specific routing and live tests prove every required model, effort, and tier.

## Durable control plane

Control plane v2 and result format v2 are the defaults. Every assignment binds the base revision, allowed and forbidden write roots, required checks, artifacts, review policy, operator approval policy, and an explicit `manual`, `commit`, or `push` delivery policy. Each state transition requires an action id, the exact state revision, and an authorized actor. Exact replays are idempotent. Stale revisions, changed replays, overlapping writer leases, and stale Ultra generations fail closed.

Writer profiles run in detached worktrees created by the controller outside the repository. Executors never stage, commit, change HEAD, create branches, or push. The controller validates the actual Git changes and declared artifacts, runs required checks without a shell, and creates an immutable candidate ref.

New writer assignments use automatic delivery by default. Set `automatic_delivery` to `false` in `$CODEX_HOME/sol-luna-orchestration/config.json` to disable it, or use an explicit `--delivery` override for one assignment. A user boundary against commits or pushes always requires the matching manual override.

Automatic delivery commits only the integrated candidate and pushes only when the checked-out branch has a matching configured upstream. It never force-pushes. The resolved policy is stored in the assignment and does not change later.

Only root or Ultra may claim, approve, integrate, acknowledge, archive, or retry a writer assignment. Independent `review` runs against the exact candidate revision. Operator questions and approvals must remain explicit.

Use `orchestration-control.mjs status|next|reconcile` to inspect and resume residual work. Its revision-fenced mutation commands handle claim, review, approval, integration, delivery, acknowledgement, answers, retries, abandonment, archival, and cleanup. A failed automatic delivery enters `delivery_blocked` and waits for an explicit retry; the controller does not keep retrying on its own.

The local dashboard is projection-only, bound to loopback, protected by a one-time authentication token, and guarded against CSRF. It allows only operator answers, approvals, and delivery retries. The deterministic simulator changes neither Git nor durable state.

## Concurrency

- Luna profiles share a limit of 10 executors per repository and 10 across the PC.
- Sol profiles share a limit of 4 executors per repository and 4 across the PC.
- The machine-wide aggregate limit is 14.
- Playwright consumes Luna capacity and has a separate machine-wide limit of 2.
- Root and Ultra are excluded; executors started by Ultra are included.
- These are maximum capacities, not fan-out targets. Delegate only useful independent scopes.
- Never run overlapping write roots concurrently. Disjoint writer worktrees may run in parallel when the residual planner selects them.

The launchers acquire atomic repository and machine leases and fail immediately with code `2` when a pool is full. Inspect utilization through `orchestration-gate.mjs status`. Never manually edit state.

## Exclusive Ultra takeover

Use Ultra only for a named decision that root Sol/xhigh cannot resolve responsibly. Activation requires a nonempty `--reason` and `--confirm-exclusive-takeover`. The canonical launcher is:

```text
node .agents/skills/sol-luna-orchestration/scripts/invoke-sol-ultra.mjs
```

The repository lock has no time-based expiry. Every Ultra epoch receives a monotonic generation that persists for the repository. Normal executors and unrelated sessions stop while the lock exists. Ultra may run only verified profiles carrying the matching `CODEX_ORCHESTRATION_LOCK_ID` and `CODEX_ORCHESTRATION_GENERATION`.

Those executors consume the normal capacity pools and still serialize overlapping writes. State and result transitions revalidate the lock id and generation. A verified terminal result releases the lock. Timeout, interruption, process, contract, or routing failure leaves it in `recovery-required`.

State v2 registers the launcher and App Server process identities for Ultra and each executor. Recovery succeeds only when every registered identity is confirmed dead or reused. Live and unknown identities fail closed, and recovery never kills a process.

Version 1 state remains `legacy-unfenced` until it is explicitly recovered with `--confirm-legacy-recovery`. History is immutable, sanitized, and retention-bounded, but it does not determine lock ownership.

There is no TTL, heartbeat, automatic recovery, shared-checkout write fallback, dependency fallback, or `shell: true`. Descendants outside the registered launcher and App Server paths cannot be identified portably or stopped atomically. Ultra cannot release while an assignment from its lock id and generation remains unfinished.

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
8. Claim the durable result, bind review and approval to its candidate id, integrate only after every gate passes, complete its declared delivery, then acknowledge and clean the worktree.
9. Inspect executor evidence instead of repeating discovery unless verification requires it.
10. Request Ultra only for an explicit exceptional reason and pause while it owns the repository.

## Executor responsibilities

1. Complete only the briefing and preserve unrelated changes.
2. Follow the selected profile, applicable project instructions, assigned sandbox, worktree, and path contract.
3. Do not re-delegate, launch another Codex session, alter orchestration or approval policy, use bypasses, stage, commit, change HEAD, create branches, or push.
4. Return the required structured result with changed files, checks, blockers, and warnings.

`explore` returns no changed files and escalates architectural, security, concurrency, distributed-invariant, or contradictory-contract decisions. `implement-lite` escalates expanded or cross-cutting work to `implement`. Neither implementation profile self-approves. `review` returns `APPROVE` or `COMMENT` with completed status, or `REQUEST_CHANGES` with blocked status and at least one blocker.

`playwright` keeps repository files unchanged, uses the configured Playwright MCP in an isolated temporary environment, and never calls `browser_run_code_unsafe`. Full interaction is limited to localhost and named dev/test targets. External state changes require explicit destination-specific authorization, and purchases, deletion, publishing, messaging, account/security changes, or production mutation are prohibited.

The launcher requires matching `thread/settings/updated` evidence for effective model, effort, and tier plus rollout `turn_context` evidence for the model and effort used during the turn. Missing, contradictory, or incompatible protocol evidence is a routing failure. System, developer, security, user, and more-specific project instructions take precedence over this policy.
