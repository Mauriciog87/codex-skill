---
name: sol-luna-orchestration
description: Coordinate substantive software work with GPT-5.6 Sol at the root and verified Sol and Luna executor profiles. Covers durable assignments, isolated writer worktrees, candidate review, validated delivery, and human-confirmed Sol Ultra takeovers. Invoke it before planning, delegating, coordinating, or validating independent work.
---

# Sol-Luna Orchestration

Use this workflow once, before the first substantive request in a root task. Do not run it inside a session whose developer instructions contain `CODEX_ORCHESTRATION_ROLE=executor`. A session marked `CODEX_ORCHESTRATION_ROLE=ultra-orchestrator` already owns the takeover workflow and must not acquire another lock.

## Workflow

1. Confirm that the root uses `gpt-5.6-sol`, `xhigh` reasoning, the Standard service tier, and `model_verbosity = "low"`.
2. Define the outcome, acceptance criteria, risks, ownership boundaries, and final verification.
3. Keep planning, integration, tightly coupled work, and sensitive decisions in the root.
4. Delegate only independent scopes when parallelism or lower context cost materially helps. Capacity is not a fan-out target.
5. Select exactly one verified profile and create a bounded assignment contract: base revision, allowed and forbidden write roots, required checks, artifacts, review policy, operator approval gate, and a resolved `manual`, `commit`, or `push` delivery policy.
6. Send the briefing through the canonical Node launcher. Writer profiles require at least one `--write-root` and run inside an isolated worktree while retaining `workspace-write` sandbox enforcement.
7. Use durable assignment state and the residual planner to resume queued work. Never overlap active write roots.
8. Accept a result only when App Server settings and rollout turn metadata agree, `routing_verified` is true, and the reported changed files match the candidate Git tree.
9. Claim and review the exact immutable candidate, obtain required approvals, integrate it into the root checkout, complete its declared delivery, acknowledge it, and clean its worktree.

## Profiles

| Profile | Model | Effort | Tier | Sandbox | Workspace | Purpose |
|---|---|---|---|---|---|---|
| `explore` | `gpt-5.6-luna` | `max` | Fast | `read-only` | Shared checkout | Broad discovery and contract tracing |
| `implement-lite` | `gpt-5.6-luna` | `max` | Fast | `workspace-write` | Isolated worktree | Small, explicit, low-risk edits |
| `playwright` | `gpt-5.6-luna` | `max` | Standard | `read-only` | Shared checkout | Browser inspection and authorized test interaction through Playwright MCP |
| `implement` | `gpt-5.6-sol` | `high` | Standard | `workspace-write` | Isolated worktree | Bounded implementation requiring stronger judgment |
| `review` | `gpt-5.6-sol` | `high` | Standard | `read-only` | Exact candidate worktree when `--candidate-id` is used | Independent plan or Git-change review |

All roles use low output verbosity. Fast profiles force `features.fast_mode = true`; Standard roles force it to `false`. Model, effort, tier, and sandbox are fixed by the profile and cannot be overridden by the caller.

The launcher requires Codex CLI 0.147.0 or a later compatible version and uses the experimental Codex App Server over local stdio JSON-RPC. It deliberately has no fallback to the legacy execution path. App Server protocol `priority` maps to public `fast`, and protocol `default` maps to public `standard`.

## Platform verification

Windows uses a junction for the global skill. Linux and macOS use directory symlinks. Treat portability as two separate gates:

```text
npm run verify:platform
npm run verify:live
```

`verify:platform` is the required authentication-free gate on Windows, Linux, and macOS. It verifies Codex CLI compatibility, strict configuration, generated App Server schemas, the current process fingerprint, an idempotent isolated global installation, the native link type and canonical target, temporary cleanup, and unchanged Git state.

`verify:live` is a manual authenticated gate. It verifies root, every executor profile, Playwright, Ultra, locks, recovery, isolation, capacity, and unchanged repository state. Mark a platform as live verified only after its self-hosted `codex-live` artifact succeeds. A sandbox failure keeps the platform pending and never justifies a bypass or weaker sandbox.

## Launcher

The canonical interface is:

```text
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile <profile> --cwd <repository> --sandbox <mode> --timeout-seconds 900 [assignment contract]
```

Examples:

```text
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile explore --cwd <repository> --sandbox read-only
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile implement-lite --cwd <repository> --sandbox workspace-write --write-root <path>
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile playwright --cwd <repository> --sandbox read-only
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile implement --cwd <repository> --sandbox workspace-write --write-root <path>
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile review --cwd <repository> --sandbox read-only
```

`npm run executor` remains a convenience entry point. Use the direct command for exact option forwarding and exit codes. Code `0` means completed with verified routing, `1` means blocked or failed, and `2` means invocation, capacity, timeout, configuration, contract, MCP, or routing verification failed.

The default control plane and result format are both v2. Use `--enqueue-only` to persist work without starting it, then resume the stored contract with `--assignment-id <id>`. Repeat `--write-root`, `--forbid-root`, `--check-json`, and `--artifact-json` as needed. Add `--review-policy independent`, `--require-operator-approval`, or `--candidate-id <id>` only when the assignment needs those gates.

New writer assignments read their automatic-delivery default from `$CODEX_HOME/sol-luna-orchestration/config.json`. Set `automatic_delivery` to `false` to opt out globally. When enabled, the controller commits the validated candidate and also selects push if the checked-out branch has a matching configured upstream.

For one new assignment, override the configuration with `--delivery manual`, `--delivery commit --commit-message <message>`, or `--delivery push --commit-message <message> --push-remote <configured-name> --push-branch <existing-branch>`. Read-only profiles and resumed assignments do not resolve the setting again.

The launcher writes a colored route banner to stderr when the terminal supports color and reserves stdout for one JSON result. It respects `NO_COLOR`, `TERM=dumb`, and `FORCE_COLOR`.

Read [the assignment schema](references/assignment-request.schema.json) when constructing a durable contract, [the executor task schema](references/executor-result.schema.json) when changing model-facing output, and [the v2 envelope schema](references/executor-result-v2.schema.json) when consuming controller results.

## Durable assignments and candidates

Assignment records and sanitized action events live outside the repository under Codex state. Every mutation carries an action id, expected state revision, and authority. Replays with the same action are idempotent; stale revisions, reused action ids with changed content, stale Ultra generations, and overlapping writer leases fail closed.

Writer worktrees complement the sandbox; they do not replace it. The executor can write only inside its isolated worktree. The controller verifies the declared paths, symlink and submodule capabilities, required checks, and artifact boundaries before creating an immutable candidate commit. The executor never stages or commits, and only root or Ultra may integrate the candidate.

Manual delivery leaves the integration unstaged. Commit delivery uses a temporary index containing only the candidate paths and preserves unrelated staged and working changes. Push delivery uses the remote and branch stored in the assignment, requires the delivery parent to exist remotely, verifies ancestry, and performs a normal noninteractive push without force. It never publishes unrelated local parent commits. There is no fallback to a shared writable checkout.

Controller commits use deterministic Git plumbing and do not run commit hooks or create signed commits. Express mandatory validation as required checks, and use manual delivery when repository policy requires hooks or signing.

Use the control CLI to inspect residual work and perform explicit transitions:

```text
npm run control -- status --cwd <repository>
npm run control -- next --cwd <repository>
npm run control -- reconcile --cwd <repository>
npm run control -- claim --cwd <repository> --assignment-id <id> --revision <n>
npm run control -- request-review --cwd <repository> --assignment-id <id> --revision <n>
npm run control -- approve --cwd <repository> --assignment-id <id> --revision <n> --kind root
npm run control -- integrate --cwd <repository> --assignment-id <id> --revision <n>
npm run control -- commit-delivery --cwd <repository> --assignment-id <id> --revision <n>
npm run control -- push-delivery --cwd <repository> --assignment-id <id> --revision <n>
npm run control -- retry-delivery --cwd <repository> --assignment-id <id> --revision <n>
npm run control -- ack --cwd <repository> --assignment-id <id> --revision <n>
```

Mutations require the exact current revision. `reconcile` mechanically performs any pending commit, push, acknowledgement, and cleanup steps. A Git delivery failure records only a sanitized error, enters `delivery_blocked`, and waits for an explicit `retry-delivery`. It does not retry a failing push in a loop.

Independent review runs `review` against `--candidate-id <id>` and publishes a verdict bound to that candidate revision. Operator questions, approvals, and delivery retries remain explicit dashboard or CLI actions. The controller never invents an answer.

The optional dashboard binds only to loopback, uses a one-time URL token, an HttpOnly session cookie, origin and CSRF checks, and exposes only the redacted status projection plus operator answer/approval actions:

```text
npm run dashboard -- --cwd <repository>
npm run simulate -- --iterations 1000 --seed 73
```

The simulator is pure and deterministic: it mutates neither Git nor durable state and exercises successful, blocked/retry, recovery, review, approval, stale-action, stale-candidate, and unauthorized-action paths.

## Capacity

- Luna profiles share a hard limit of 10 active executors per repository and 10 across the PC.
- Sol profiles share a hard limit of 4 active executors per repository and 4 across the PC.
- The machine-wide aggregate limit is 14 executors.
- Playwright has an additional machine-wide limit of 2 and consumes Luna capacity.
- Root and Ultra processes do not consume executor slots. Executors delegated by Ultra do.
- Executor capacity acquisition is atomic and fails immediately. Durable assignments may remain queued until the residual planner can start them without an overlapping resource lease.
- Dead-process leases are pruned only after confirming that the owner PID is no longer active. Corrupt state fails closed.

Inspect repository and machine utilization with:

```text
node .agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs status --cwd <repository>
```

## Profile contracts

`explore` never changes files. It returns conclusions, `path:line` evidence, contracts, risks, and open questions. It blocks and escalates when the work requires architecture, security, concurrency, distributed-invariant, or contradictory-contract decisions.

`implement-lite` owns only a small, explicit, low-risk change. It blocks and recommends `implement` when the scope expands or judgment becomes cross-cutting.

`implement` owns only the assigned files or subsystem, makes the smallest complete change in its isolated worktree, and never self-approves, stages, commits, changes HEAD, or pushes. The controller runs declared checks, publishes the candidate, and alone performs the resolved delivery after all gates pass.

`review` returns `APPROVE` or `COMMENT` with completed status, or `REQUEST_CHANGES` with blocked status and at least one blocker. It never changes files.

`playwright` requires the enabled stdio MCP configuration `npx --yes @playwright/mcp@0.0.80`. The global installer pins or repairs that configuration. The launcher applies `mcp_servers.playwright.default_tools_approval_mode="approve"` only to that App Server process, adds `browser_run_code_unsafe` to its MCP deny-list, sets the MCP process working directory to a unique temporary directory, and extends the MCP arguments with the official `--isolated` and `--output-dir` options for the same location. It verifies that a Playwright MCP tool was used and removes the temporary artifacts.

Executor turns use App Server approval policy `never`. Command and file approvals, permission grants, and MCP elicitations fail closed with protocol-valid responses. Non-blocking user-input requests receive an empty answer. Blocking, non-sensitive questions become durable operator requests whose acknowledged answers are carried into a retry; sensitive answers are never persisted.

Full interaction is allowed only on localhost and explicitly named development or test environments. External sites are observation-only unless the briefing authorizes a named state-changing action and destination. Purchases, deletion, publishing, messaging, account or security changes, production mutation, and `browser_run_code_unsafe` are prohibited.

## Exclusive Ultra takeover

Use Sol `ultra` on Standard only when a named architecture, security, concurrency, distributed-invariant, or contradictory-contract decision cannot be resolved responsibly by root Sol/xhigh. The human must provide a reason and `--confirm-exclusive-takeover`.

```text
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-sol-ultra.mjs --cwd <repository> --reason <reason> --confirm-exclusive-takeover --sandbox read-only
```

Workspace writing requires an explicit `--sandbox workspace-write`. Ultra temporarily replaces the root, disables native multi-agent execution, and delegates only through verified profiles. Its executors inherit the exact `CODEX_ORCHESTRATION_LOCK_ID` and monotonic `CODEX_ORCHESTRATION_GENERATION`. They consume the normal capacity pools and never overlap write roots.

New Ultra-owned writer assignments inherit the operator-controlled automatic-delivery setting. An explicit user boundary against commits or pushes takes precedence and requires `--delivery manual`. Durable executor output uses the v2 envelope; the Ultra result includes its integer `generation`.

A verified terminal result releases the lock. Timeout, interruption, process failure, invalid output, or routing failure leaves it in `recovery-required`. State v2 registers the Ultra launcher and App Server, plus every executor launcher and App Server, with a portable process-start fingerprint.

Recover only with the exact lock id and only after every registered identity is confirmed `dead` or `reused`. A live or `unknown` identity fails closed, and recovery never kills it:

```text
node .agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs status --cwd <repository>
node .agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs history --cwd <repository> --limit 50
node .agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs recover --cwd <repository> --lock-id <exact-lock-id>
```

Active version 1 state remains `legacy-unfenced` and is never converted silently. After its owners stop, recovery also requires `--confirm-legacy-recovery`; a v1-only repository then starts v2 at generation 1. History is immutable and sanitized. Retention targets 1,000 events while protecting the active generation, but history does not determine lock ownership.

## Guardrails

- Do not use native `spawn_agent` or custom agent TOML for profile routing.
- Do not alter approval policy, request `danger-full-access`, or use bypasses.
- Do not let executors re-delegate, alter orchestration policy, stage, commit, change HEAD, push, or own overlapping files concurrently.
- Keep `explore`, `playwright`, and `review` read-only. Require explicit workspace write for both implementation profiles.
- Do not infer model, effort, or tier from configuration or executor prose. Require matching `thread/settings/updated` model, effort, and tier plus rollout `turn_context` model and effort.
- Do not manually edit or delete orchestration state.
- Treat hooks as defense in depth, not complete enforcement across every tool path.
- Do not add TTLs, heartbeats, automatic recovery, shared-checkout write fallbacks, dependency fallbacks, or `shell: true`.
- Disclose that unregistered descendants cannot be identified portably and that fencing cannot atomically cancel an arbitrary workspace mutation already in progress.

## Completion criteria

A root task is complete only when every applicable condition below is met:

- Every used profile has verified routing.
- Every accepted candidate has the required review and approvals.
- Integration is conflict-free and the declared delivery is complete.
- Relevant checks and platform verification pass.
- Durable assignments are acknowledged and their worktrees are cleaned or explicitly archived.
- Playwright use is verified when requested.
- Every Ultra generation is released or reported as `recovery-required`.
- Any unresolved portability, descendant-registration, or sandbox limitation is disclosed.
