# Verified Astra-Luna orchestration for Codex

This repository adds a dependency-free orchestration layer to Codex. GPT-6 Astra handles planning and integration; Astra and Luna executors handle assigned tasks. Task records survive interruptions, and writers work in isolated Git worktrees.

The controller checks the model, reasoning effort, service tier, and required validation before accepting a candidate: a saved, validated snapshot of the proposed changes. It can then commit or push that candidate according to the task's delivery policy.

The architecture is Astra-Luna. The skill identifier `sol-luna-orchestration`, existing commands (including `invoke-sol-ultra.mjs`), managed markers, and state namespaces keep their historical names for compatibility. There is no Sol execution fallback.

The launchers talk to the [experimental Codex App Server](https://developers.openai.com/codex/app-server) over local stdio JSON-RPC instead of using native subagent routing. App Server applies and reports each route explicitly, while native multi-agent execution stays disabled. There is no legacy fallback. An incompatible protocol fails closed with exit code `2`.

## Roles

| Role | Model | Effort | Tier | Sandbox | Workspace | Best use |
|---|---|---|---|---|---|---|
| Root | Astra | high | Standard | Current session | Main checkout | Planning, delegation, integration, final validation |
| `explore` | Luna | max | Fast | Read-only | Shared checkout | Repository discovery, documentation, contract tracing |
| `implement-lite` | Luna | max | Fast | Workspace write | Isolated worktree | Small, low-risk, tightly bounded edits |
| `playwright` | Luna | max | Standard | Read-only repository | Shared checkout | Browser inspection and authorized test interaction |
| `implement` | Astra | medium | Standard | Workspace write | Isolated worktree | Changes that need stronger engineering judgment |
| `review` | Astra | high | Standard | Read-only | Exact candidate worktree when requested | Independent plan and code review |
| Ultra | Astra | ultra | Standard | Explicit takeover sandbox | Main checkout | Exceptional architecture, security, or concurrency decisions |

Every role uses `model_verbosity = "low"`. Fast profiles force `features.fast_mode = true`, while Standard roles force it to `false`. Reasoning effort and output verbosity are independent settings.

The advanced model is `gpt-6-astra`; the economical model remains `gpt-5.6-luna`. `model-policy.mjs` defines the advanced model and root/takeover defaults, and `executor-profiles.mjs` fixes each executor route. Review stays at high effort for independent critique; implementation uses medium. Root retains planning and acceptance authority. Ultra is available only when the installed runtime advertises that effort and the operator explicitly authorizes a takeover.

Once `turn/start` succeeds, `explore` gets 120 seconds to report `item/*` progress for the active thread. Each matching event resets this idle timer, but does not extend the overall timeout. The overall timeout defaults to 900 seconds and can be changed with `--timeout-seconds`. Other profiles use only the overall timeout.

Routing requires two matching sources of evidence. `thread/settings/updated` confirms the effective model, effort, and protocol tier, while the rollout `turn_context` confirms the model and effort used for the turn. Protocol `priority` is reported publicly as `fast`; protocol `default` is reported as `standard`.

## Fast path for Git operations

Rebases, merges, cherry-picks, reverts, and conflict resolution stay with the root. It checks the checkout and fetches remote refs before acting. Do not use `explore` to guess what might conflict; after Git reports a conflict, the root may ask it one focused question, once. The root makes the edit and does not repeat a stalled or failed request.

Stop and ask the operator if the checkout is dirty, another Git operation is in progress, or another worktree has the target branch checked out. Push and force-push permissions do not change. The full preflight and conflict procedure lives in [the skill](.agents/skills/sol-luna-orchestration/SKILL.md#fast-path-for-git-operations).

## Installation

Codex CLI `0.147.0` is the minimum supported version. The launchers use the experimental App Server protocol and the `thread/settings/update` behavior validated against that release. Verify newer releases with the included schema and live checks before relying on them.

Have these tools available before you start:

- Codex CLI, Git, and Node.js on `PATH`. CI uses Node.js 22.
- `npm` for the convenience commands and `npx` for Playwright MCP. The first Playwright launch needs registry access if the pinned package is not cached.
- A Codex login with access to the models listed above when running executors or live checks. Offline checks do not need a login.

**New writer assignments use automatic delivery by default.** After validation and integration, the controller commits the candidate and pushes it if the branch has a matching configured upstream. Use `--delivery manual` for a task that must not commit or push, or disable `automatic_delivery` in the [delivery configuration](#durable-assignments).

From this repository's checkout, run:

```text
npm run install:global
```

The installer checks for conflicts before changing files. Running it again with the same settings leaves the installation unchanged. It:

- links the canonical skill to `$HOME/.agents/skills/sol-luna-orchestration`;
- uses a junction on Windows and a directory symlink on macOS or Linux;
- configures the global root as Astra/high/Standard with low verbosity;
- configures the `playwright` MCP to run `npx --yes @playwright/mcp@0.0.80`;
- preserves unrelated Codex configuration and instructions;
- installs the Ultra SessionStart and PreToolUse hooks without changing an existing `hooks.json`;
- migrates validated Sol-Sol and Sol-Terra links and managed blocks;
- refuses unrelated destinations, malformed managed markers, and ambiguous TOML.

Repository-specific Codex instructions still take precedence over the global defaults.

### Migration and rollback

Before updating an installation, pause other sessions using the global skill and finish existing assignments. Do not migrate with active executors, unresolved locks, or unfinished assignments. The global link reads this checkout directly, so edits become visible before the installer runs.

The annotated tag `pre-astra-migration-2026-09-04` preserves the pre-migration code. Back up the installer-managed `config.toml`, active global instructions, and `sol-luna-orchestration/config.json` outside the repository under `$CODEX_HOME/checkpoints/pre-astra-migration-2026-09-04`, recording missing files and the skill link target. Do not include authentication files or credentials.

To roll back, first preserve any uncommitted migration diff and pause consuming sessions. With operator authorization, restore the checkpoint code and the backed-up global defaults and managed instruction block, preserving unrelated settings changed since the backup. If the checkout is already committed, revert the migration commit instead of rewriting published history. The code tag does not restore global configuration. Never restore, rewind, or delete durable state, history, locks, or generation counters; resolve pending work through the existing gate and control commands before changing versions.

## Platform support

| System | Global skill link | Offline CI | Live routing |
|---|---|---|---|
| Windows | Junction | Required on `windows-latest` | Pending |
| Linux | Directory symlink | Required on `ubuntu-latest` | Pending |
| macOS | Directory symlink | Required on `macos-latest` | Pending |

The required [GitHub Actions matrix](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations) runs on Node.js 22 with Codex CLI `0.147.0`. A weekly and manually triggered advisory matrix probes `@openai/codex@latest` without blocking `master`, because App Server compatibility can change in newer releases.

The offline smoke test does not start model turns or require authentication:

```text
npm run verify:platform
npm run verify:platform -- --expected-codex-version 0.147.0 --output <path-outside-the-repository>
```

It creates isolated temporary HOME and `CODEX_HOME` directories, checks strict configuration and generated App Server schemas, verifies portable process fingerprints, installs twice, verifies the native link type and target, and removes the temporary state. Its JSON result is written to stdout; diagnostics use stderr.

Live status remains `Pending` until that operating system has a successful artifact. Run live checks only from `master`, through the manual `live-cross-platform.yml` workflow, on dedicated self-hosted runners labeled `codex-live` plus `windows`, `linux`, or `macOS`.

Before enabling the workflow, configure the GitHub environment named `codex-live` with required reviewers. Each runner needs an isolated OS account, an existing Codex login, and the stdio Playwright MCP. The workflow does not copy personal tokens or use API-key secrets.

Windows can still report `codex-windows-sandbox-setup.exe: Access is denied` on machines where the sandbox helper cannot initialize. That platform remains pending when this occurs; the verification never reduces permissions or enables a bypass.

## Running an executor

Send the briefing through stdin. These read-only examples run from this repository's checkout; change `--cwd .` to inspect another repository. The direct Node command is the canonical interface.

PowerShell:

```powershell
"Find where executor profiles are defined. Report paths and responsibilities without changing files." | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile explore --cwd . --sandbox read-only --timeout-seconds 900
```

Bash on Linux or macOS:

```bash
printf '%s\n' 'Find where executor profiles are defined. Report paths and responsibilities without changing files.' | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile explore --cwd . --sandbox read-only --timeout-seconds 900
```

Both implementation profiles require explicit `workspace-write` and at least one permitted path. The examples below use `echo`, which works for these simple briefings in PowerShell and Bash. Replace the briefing and paths with your task; `src/feature` is an example path, not a directory in this repository. These examples use manual delivery, so they do not commit or push:

```text
echo "Update validation messages in src/feature to US English without changing behavior. Run the relevant tests." | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile implement-lite --cwd . --sandbox workspace-write --write-root src/feature --delivery manual
echo "Fix null input handling in src and add regression tests. Do not edit src/generated." | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile implement --cwd . --sandbox workspace-write --write-root src --forbid-root src/generated --delivery manual
```

Read-only profiles reject `workspace-write`. Write profiles do not enable it automatically. Every profile rejects `danger-full-access`, approval overrides, and bypass flags. Control plane v2 and result format v2 are the defaults; use `--control-plane v1` only for the legacy read-only interface.

`npm run executor -- --profile ...` is available for convenience, but the direct command provides the clearest option forwarding and exit-code behavior.

The launcher prints a colored route banner to stderr when the terminal supports color:

```text
◆ PLAYWRIGHT · GPT-5.6-LUNA · MAX · STANDARD · READ-ONLY
```

Machine-readable JSON remains the only stdout output. `NO_COLOR`, `TERM=dumb`, and `FORCE_COLOR` are honored.

## Durable assignments

An assignment is a saved task contract tied to a full Git base revision. It records the permitted paths, checks, artifacts, review and approval requirements, and delivery policy. It also records priority and any allowed symlink or submodule operations. The briefing stays separate from public status, and the records live outside the repository under Codex home.

The global installer creates `$CODEX_HOME/sol-luna-orchestration/config.json` with automatic delivery enabled:

```json
{
  "automatic_delivery": true
}
```

Automatic delivery is the default for new writer assignments, but it can be turned off. After root or Ultra validates and integrates a candidate, the controller commits only that candidate. If the checked-out branch has a configured upstream with the same name, the assignment records it and the controller performs a normal fast-forward push. Without a matching upstream, delivery stops after the local commit.

Set `automatic_delivery` to `false` to return to unstaged manual integration. An explicit `--delivery manual|commit|push` overrides the setting for one new assignment. Existing and resumed assignments keep their stored policy. Read-only and review profiles always remain manual.

Save an assignment without starting it, then inspect the remaining work. Replace the example briefing and paths as above. `reconcile` starts assignments whose scopes do not conflict with active work and resumes pending transitions; it follows each assignment's stored delivery policy:

```text
echo "Fix null input handling in src/feature and add regression tests." | npm run executor -- --profile implement --cwd . --sandbox workspace-write --write-root src/feature --delivery manual --enqueue-only
npm run control -- status --cwd .
npm run control -- next --cwd .
npm run control -- reconcile --cwd .
```

Every state change must name the current revision. A request based on an older revision is rejected; this is revision fencing.

An assignment moves through `queued`, `running`, `result_ready`, `claimed`, optional review and approval, `integration_pending`, and then delivery. Manual delivery uses `integrated`. Automatic delivery adds `commit_pending` and `committed`, plus `push_pending` and `published` when a push is required, before reaching `acknowledged`.

A Git failure moves the assignment to `delivery_blocked` and waits for an explicit retry. It does not loop. Blocked, failed, and recovery-required attempts can be archived and retried separately. Every mutation includes a unique action id, the expected state revision, and its authority. Exact replays are idempotent; altered replays and stale revisions fail closed.

The residual planner starts disjoint write scopes in parallel and retains active leases across blocked or failed attempts. It never uses capacity as a fan-out target and never falls back to a shared writable checkout.

## Worktrees, candidates, and review

Worktrees and sandboxing cover different risks, so both stay enabled. `workspace-write` limits the executor process. The detached worktree keeps Git changes away from the main checkout. Before publication, the controller verifies the actual changed paths, rejects executor commits or HEAD changes, checks symlink and submodule policy, runs declared commands without a shell, and copies only declared in-scope artifacts.

After validation, the controller creates an immutable hidden candidate ref through Git plumbing. The executor never stages or commits. The candidate id binds the base revision, tree diff, contract, checks, and artifact manifest. Reusing an attempt with different content is rejected. A new writer assignment resolves its delivery policy once from the global configuration unless the launcher receives an explicit override.

For commit delivery, the controller builds a temporary index from the current branch and applies only the validated candidate. It creates a candidate-bound commit, updates the checked-out branch with compare-and-swap semantics, and synchronizes only the candidate paths in the real index. Unrelated staged and unstaged work is preserved.

Automatic push discovery reads only the checked-out branch's configured upstream with the same name and stores it in the assignment. Explicit push delivery still requires a named configured remote and an existing branch. Before pushing, the controller checks that the delivery commit's parent exists remotely and verifies ancestry. It then publishes the exact commit without `--force` and verifies the remote result. Unrelated local parent commits are never published.

The deterministic plumbing commit does not execute repository commit hooks or create a signed commit. Put mandatory validation in `required_checks`; repositories that require interactive hooks or signed commits should keep delivery `manual`.

Root-driven review and integration use explicit state revisions. Replace `<id>`, `<n>`, and `<candidate-id>` with current values from status. These commands show individual transitions, not a script to run unchanged from top to bottom. Commit, push, and retry commands apply only when the assignment's policy and state require them:

```text
npm run control -- claim --cwd . --assignment-id <id> --revision <n>
npm run control -- request-review --cwd . --assignment-id <id> --revision <n>
echo "Review this candidate for correctness and missing tests. Do not change files." | npm run executor -- --profile review --cwd . --sandbox read-only --candidate-id <candidate-id>
npm run control -- approve --cwd . --assignment-id <id> --revision <n> --kind root
npm run control -- integrate --cwd . --assignment-id <id> --revision <n>
npm run control -- commit-delivery --cwd . --assignment-id <id> --revision <n>
npm run control -- push-delivery --cwd . --assignment-id <id> --revision <n>
npm run control -- retry-delivery --cwd . --assignment-id <id> --revision <n>
npm run control -- ack --cwd . --assignment-id <id> --revision <n>
```

An independent verdict is bound to the exact candidate id and revision. Optional operator approval is a separate authority. Before integration, the controller rechecks candidate integrity and path drift and refuses conflicts with local work.

After integration, `reconcile` can perform the declared commit, push, acknowledgment, and cleanup. A blocked delivery records a sanitized reason and waits for `retry-delivery`. Retrying the assignment is a separate operation that first archives the previous worktree. Acknowledged and abandoned workspaces can then be cleaned safely.

## Local control dashboard and simulator

```text
npm run dashboard -- --cwd .
npm run simulate -- --iterations 1000 --seed 73
```

The dashboard binds only to `127.0.0.1`, `localhost`, or `::1`. It uses a single-use URL token, an HttpOnly SameSite cookie, Host and Origin validation, CSRF protection, and a restrictive content security policy. It exposes the redacted projection, not briefings, raw events, or artifact contents, and permits only operator answers, approvals, and explicit delivery retries.

The deterministic simulator is pure: it changes neither Git nor durable state. It exercises successful candidates, commit and push delivery, delivery blocking and retry, zero-change readers, independent review, operator approval, blocked execution retry, recovery, stale action replay, stale candidate use, premature integration, and unauthorized actions.

## Result contract

```json
{
  "schema_version": 2,
  "assignment_id": "uuid",
  "attempt": 1,
  "status": "completed | blocked | failed",
  "profile": "explore | implement-lite | playwright | implement | review | null",
  "thread_id": "string | null",
  "model": "string | null",
  "reasoning_effort": "string | null",
  "service_tier": "fast | standard | null",
  "routing_verified": false,
  "sandbox_mode": "read-only | workspace-write",
  "base_revision": "full Git object id",
  "candidate": "object | null",
  "summary": "string",
  "changed_files": [],
  "artifacts": [],
  "operator_requests": [],
  "checks": [],
  "blockers": [],
  "warnings": []
}
```

The executor still supplies only task fields. The launcher adds observed routing metadata and the durable controller adds assignment, attempt, base revision, candidate, artifact, operator-request, and required-check evidence. `routing_verified` becomes true only when App Server settings confirm model, effort, and tier and rollout `turn_context` independently confirms model and effort.

The legacy v1 task payload remains available to compatible read-only callers. Ultra uses the shared routing fields and adds `mode: "ultra"`, `lock_id`, integer `generation`, and `executors`. The generation is allocated once per Ultra epoch and is included even in terminal failures after acquisition.

Exit codes are stable:

- `0`: completed with verified routing;
- `1`: blocked, failed, or Codex returned a task-level error;
- `2`: invalid invocation, capacity conflict, timeout, configuration, contract, MCP, or routing verification failure.

## Concurrency

A lease reserves an executor slot for a registered process. The launchers acquire leases atomically at both repository and machine scope, enforcing these limits:

- Luna: 10 active executors per repository and 10 across the PC;
- Astra: 4 active executors per repository and 4 across the PC;
- total machine capacity: 14 executors;
- Playwright: 2 across the PC, counted inside the Luna pool.

The serialized advanced pool is still named `sol` in status and durable records. New Astra executors use its four slots; historical Sol records continue to count against the same capacity. This compatibility key does not allow new Sol execution or change stored generations and history.

The root and Ultra process do not consume executor slots. Executors started by Ultra do. Reaching an executor pool limit fails immediately. Durable assignments may remain explicitly queued until `reconcile` can start them; the launcher does not create a second hidden queue.

These numbers are upper bounds, not a target. Parallel work should have independent evidence or ownership. Overlapping writes must remain sequential, and creating redundant executors usually costs more integration time than it saves.

Inspect active leases and capacity with:

```text
node .agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs status --cwd .
```

Dead leases are removed only after their registered process identity is confirmed stopped or reused. An identity that cannot be inspected fails closed. Corrupt authority state also fails closed.

## Playwright profile

Before Codex starts, the `playwright` profile checks that Playwright MCP is enabled, uses stdio, and is configured to run `npx --yes @playwright/mcp@0.0.80`. `npm run install:global` creates or repairs that configuration without changing unrelated MCP settings.

For this profile only, the launcher sets `mcp_servers.playwright.default_tools_approval_mode="approve"` in the App Server process. This lets browser actions authorized by the briefing run without an interactive prompt. It also adds `browser_run_code_unsafe` to that process's MCP deny-list. Neither override changes the global configuration.

Each run uses a unique temporary MCP working directory and passes `--isolated` and `--output-dir` for that location. This keeps ordinary relative screenshots and other MCP output outside the repository. The launcher removes the temporary directory in `finally`.

The session must emit an actual Playwright MCP tool call. A successful result includes `playwright_mcp:verified` in `checks`; the executor cannot add that verification itself.

Executor turns are non-interactive and start with App Server approval policy `never`. Command and file approvals are declined, permission grants return an empty grant, and MCP elicitations are declined using the response shape required by the installed App Server.

A non-blocking user-input request receives an empty answer and execution continues. A blocking, non-sensitive question is saved as an operator request. Once the answer is acknowledged and the assignment is retried, that answer becomes part of the next briefing. Sensitive input is never saved to durable state; the request fails closed.

Full interaction is allowed on localhost and explicitly named development or test environments. External sites are observation-only unless the briefing explicitly authorizes a named state-changing action and destination. Purchases, deletion, publishing, messaging, account or security changes, production mutation, and `browser_run_code_unsafe` are always prohibited.

## Exclusive Ultra takeover

Ultra temporarily replaces the root for one repository; it is not an executor profile. Run it only after a human has authorized the takeover and its reason. This read-only example sends a concrete briefing; replace it with the authorized task:

```text
echo "Review the repository concurrency design. Report risks and unresolved decisions without changing files." | node .agents/skills/sol-luna-orchestration/scripts/invoke-sol-ultra.mjs --cwd . --reason "Concurrency review needs an exclusive takeover" --confirm-exclusive-takeover --sandbox read-only
```

The lock blocks normal sessions and has no automatic expiry. Every Ultra acquisition receives a repository-persistent, monotonically increasing generation shared by that epoch. Ultra may delegate only through the verified profiles, which inherit both `CODEX_ORCHESTRATION_LOCK_ID` and `CODEX_ORCHESTRATION_GENERATION` and consume the normal capacity pools. State and result transitions revalidate both values, so a stale epoch cannot finish, abandon, release, or publish results into a newer epoch.

State v2 registers the Ultra launcher and App Server plus each executor launcher and App Server. Each registration uses a PID, process-start fingerprint, instance id, host, platform, and architecture. Recovery is fail-closed: it succeeds only when every registered identity is `dead` or `reused`; `same` and `unknown` identities reject recovery. Recovery never terminates processes.

A verified terminal result releases the lock. Timeout, interruption, process, contract, or routing failure leaves `recovery-required`. Check and recover it only through the gate:

```text
node .agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs status --cwd .
node .agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs history --cwd . --limit 50
node .agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs recover --cwd . --lock-id <exact-lock-id>
```

Version 1 state is never silently upgraded while active. The gate reports it as `legacy-unfenced`; after all legacy owners have stopped, recovery additionally requires `--confirm-legacy-recovery`. In a v1-only repository, the next Ultra acquisition starts generation 1.

History is append-only and stores sanitized coordination metadata rather than briefings, model responses, or raw errors. Retention targets 1,000 events and prunes only terminal generations; the active generation is protected and can temporarily keep the count above that target. History corruption is reported as a warning and is never used as lock authority.

There is no TTL, heartbeat, automatic recovery, shared-checkout write fallback, dependency fallback, or `shell: true` execution. Ultra cannot release while one of its durable assignments remains unfinished. Descendants not launched through the registered launcher/App Server paths cannot be identified portably. Fencing prevents stale orchestration transitions and result publication, but it cannot atomically cancel an arbitrary unregistered descendant that is already mutating a worktree.

## Verification

```text
npm test
npm run verify:platform
npm run verify:live -- --schema-only
npm run verify:live -- --playwright-only
npm run verify:live
```

The unit suite covers the control plane from routing through delivery. It tests JSON-RPC ordering and failures, profile routing, durable state transitions, action replay, resource leases, worktree isolation, immutable candidates, automatic-delivery precedence, manual integration, candidate-only commits, push delivery, delivery retry, required checks and artifacts, independent review, and operator gates. It also exercises dashboard security, deterministic fault simulation, tiers and terminal colors, capacity races, Ultra fencing, process identity, fail-closed recovery, history retention, version 1 migration, Playwright evidence, installer rollback, and platform-specific paths.

Choose the check that matches what you need to verify:

- `verify:platform` needs no login and starts no model turns. It checks compatibility, the current process fingerprint, and the App Server response contracts for approvals, permission grants, user input, and MCP elicitation.
- `verify:live -- --schema-only` runs one root turn against the production output schema. Despite its name, this option uses a model.
- `verify:live -- --playwright-only` runs one isolated localhost Playwright interaction without the other profiles.
- The full `verify:live` run checks the root and every profile against protocol and rollout evidence. Write tests use temporary repositories, and read-only checks must leave this repository unchanged.

Add `--output <path-outside-the-repository>` to save verification evidence.

The root probe first reads effective global settings through `config/read` in a temporary repository with no local configuration and no model or effort overrides. Only after those defaults match does it negotiate a separate root turn. Writer probes explicitly use manual delivery, including Ultra's delegated writer; publication tests use only temporary local remotes. Evidence from an earlier Sol run does not certify Astra. Platforms not rerun remain pending, and successful acceptance proves compatibility, not a particular cost saving.
