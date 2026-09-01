# Verified Sol-Luna orchestration for Codex

This repository adds a dependency-free orchestration layer to Codex. GPT-5.6 Sol owns planning and integration, while verified Sol and Luna profiles handle bounded assignments. Assignments survive interruptions, and writer tasks run in isolated Git worktrees. Before accepting a candidate, the controller verifies the effective model, reasoning effort, service tier, and every configured gate. It can then commit or push that exact candidate.

The launchers talk to the [experimental Codex App Server](https://developers.openai.com/codex/app-server) over local stdio JSON-RPC instead of using native subagent routing. App Server applies and reports each route explicitly, while native multi-agent execution stays disabled. There is no legacy fallback. An incompatible protocol fails closed with exit code `2`.

## Roles

| Role | Model | Effort | Tier | Sandbox | Workspace | Best use |
|---|---|---|---|---|---|---|
| Root | Sol | xhigh | Standard | Current session | Main checkout | Planning, delegation, integration, final validation |
| `explore` | Luna | max | Fast | Read-only | Shared checkout | Repository discovery, documentation, contract tracing |
| `implement-lite` | Luna | max | Fast | Workspace write | Isolated worktree | Small, low-risk, tightly bounded edits |
| `playwright` | Luna | max | Standard | Read-only repository | Shared checkout | Browser inspection and authorized test interaction |
| `implement` | Sol | high | Standard | Workspace write | Isolated worktree | Changes that need stronger engineering judgment |
| `review` | Sol | high | Standard | Read-only | Exact candidate worktree when requested | Independent plan and code review |
| Ultra | Sol | ultra | Standard | Explicit takeover sandbox | Main checkout | Exceptional architecture, security, or concurrency decisions |

Every role uses `model_verbosity = "low"`. Fast profiles force `features.fast_mode = true`, while Standard roles force it to `false`. Reasoning effort and output verbosity are independent settings.

Routing requires two matching sources of evidence. `thread/settings/updated` confirms the effective model, effort, and protocol tier, while the rollout `turn_context` confirms the model and effort used for the turn. Protocol `priority` is reported publicly as `fast`; protocol `default` is reported as `standard`.

## Installation

Codex CLI `0.147.0` is the minimum supported version. The launchers rely on the experimental App Server protocol and the `thread/settings/update` behavior validated against that release. The only other requirement is the Node.js runtime bundled with Codex. Newer Codex releases are accepted only after they pass the included schema and live verification.

```text
npm run install:global
```

The installer is idempotent and performs a complete preflight before changing anything. It:

- links the canonical skill to `$HOME/.agents/skills/sol-luna-orchestration`;
- uses a junction on Windows and a directory symlink on macOS or Linux;
- configures the global root as Sol/xhigh/Standard with low verbosity;
- installs and pins the `playwright` MCP to `npx --yes @playwright/mcp@0.0.80`;
- preserves unrelated Codex configuration and instructions;
- installs the Ultra SessionStart and PreToolUse hooks without changing an existing `hooks.json`;
- migrates validated Sol-Sol and Sol-Terra links and managed blocks;
- refuses unrelated destinations, malformed managed markers, and ambiguous TOML.

Repository-specific Codex instructions still take precedence over the global defaults.

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

The direct Node command is the canonical interface:

```text
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile explore --cwd . --sandbox read-only --timeout-seconds 900
```

Use `workspace-write` explicitly and declare at least one permitted path for either implementation profile:

```text
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile implement-lite --cwd . --sandbox workspace-write --write-root src/feature
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs --profile implement --cwd . --sandbox workspace-write --write-root src --forbid-root src/generated
```

Read-only profiles reject `workspace-write`. Write profiles do not enable it automatically. Every profile rejects `danger-full-access`, approval overrides, and bypass flags. Control plane v2 and result format v2 are the defaults; use `--control-plane v1` only for the legacy read-only interface.

`npm run executor -- --profile ...` is available for convenience, but the direct command provides the clearest option forwarding and exit-code behavior.

The launcher prints a colored route banner to stderr when the terminal supports color:

```text
◆ PLAYWRIGHT · GPT-5.6-LUNA · MAX · STANDARD · READ-ONLY
```

Machine-readable JSON remains the only stdout output. `NO_COLOR`, `TERM=dumb`, and `FORCE_COLOR` are honored.

## Durable assignments

Each assignment keeps its briefing separate from public status and binds execution to a full Git base revision. The contract records priority, allowed and forbidden write roots, required checks, declared artifacts, review policy, operator approval, explicit symlink or submodule capabilities, and a `manual`, `commit`, or `push` delivery policy. State lives outside the repository under Codex home.

The global installer creates `$CODEX_HOME/sol-luna-orchestration/config.json` with automatic delivery enabled:

```json
{
  "automatic_delivery": true
}
```

Automatic delivery is the default for new writer assignments, but it can be turned off. After root or Ultra validates and integrates a candidate, the controller commits only that candidate. If the checked-out branch has a configured upstream with the same name, the assignment records it and the controller performs a normal fast-forward push. Without a matching upstream, delivery stops after the local commit.

Set `automatic_delivery` to `false` to return to unstaged manual integration. An explicit `--delivery manual|commit|push` overrides the setting for one new assignment. Existing and resumed assignments keep their stored policy. Read-only and review profiles always remain manual.

Persist work without starting it, inspect the residual plan, and run every currently safe assignment:

```text
briefing | npm run executor -- --profile implement --cwd . --sandbox workspace-write --write-root src/feature --enqueue-only
briefing | npm run executor -- --profile implement --cwd . --sandbox workspace-write --write-root src/feature --delivery push --commit-message "feat: finish feature" --push-remote origin --push-branch master --enqueue-only
npm run control -- status --cwd .
npm run control -- next --cwd .
npm run control -- reconcile --cwd .
```

Every state change is revision-fenced. An assignment moves through `queued`, `running`, `result_ready`, `claimed`, optional review and approval, `integration_pending`, and then delivery. Manual delivery uses `integrated`. Automatic delivery adds `commit_pending` and `committed`, plus `push_pending` and `published` when a push is required, before reaching `acknowledged`.

A Git failure moves the assignment to `delivery_blocked` and waits for an explicit retry. It does not loop. Blocked, failed, and recovery-required attempts can be archived and retried separately. Every mutation includes a unique action id, the expected state revision, and its authority. Exact replays are idempotent; altered replays and stale revisions fail closed.

The residual planner starts disjoint write scopes in parallel and retains active leases across blocked or failed attempts. It never uses capacity as a fan-out target and never falls back to a shared writable checkout.

## Worktrees, candidates, and review

Worktrees and sandboxing cover different risks, so both stay enabled. `workspace-write` limits the executor process. The detached worktree keeps Git changes away from the main checkout. Before publication, the controller verifies the actual changed paths, rejects executor commits or HEAD changes, checks symlink and submodule policy, runs declared commands without a shell, and copies only declared in-scope artifacts.

After validation, the controller creates an immutable hidden candidate ref through Git plumbing. The executor never stages or commits. The candidate id binds the base revision, tree diff, contract, checks, and artifact manifest. Reusing an attempt with different content is rejected. A new writer assignment resolves its delivery policy once from the global configuration unless the launcher receives an explicit override.

For commit delivery, the controller builds a temporary index from the current branch and applies only the validated candidate. It creates a candidate-bound commit, updates the checked-out branch with compare-and-swap semantics, and synchronizes only the candidate paths in the real index. Unrelated staged and unstaged work is preserved.

Automatic push discovery reads only the checked-out branch's configured upstream with the same name and stores it in the assignment. Explicit push delivery still requires a named configured remote and an existing branch. Before pushing, the controller checks that the delivery commit's parent exists remotely and verifies ancestry. It then publishes the exact commit without `--force` and verifies the remote result. Unrelated local parent commits are never published.

The deterministic plumbing commit does not execute repository commit hooks or create a signed commit. Put mandatory validation in `required_checks`; repositories that require interactive hooks or signed commits should keep delivery `manual`.

Root-driven review and integration use explicit state revisions:

```text
npm run control -- claim --cwd . --assignment-id <id> --revision <n>
npm run control -- request-review --cwd . --assignment-id <id> --revision <n>
review briefing | npm run executor -- --profile review --cwd . --sandbox read-only --candidate-id <candidate-id>
npm run control -- approve --cwd . --assignment-id <id> --revision <n> --kind root
npm run control -- integrate --cwd . --assignment-id <id> --revision <n>
npm run control -- commit-delivery --cwd . --assignment-id <id> --revision <n>
npm run control -- push-delivery --cwd . --assignment-id <id> --revision <n>
npm run control -- retry-delivery --cwd . --assignment-id <id> --revision <n>
npm run control -- ack --cwd . --assignment-id <id> --revision <n>
```

An independent verdict is bound to the exact candidate id and revision. Optional operator approval is a separate authority. Before integration, the controller rechecks candidate integrity and path drift and refuses conflicts with local work.

After integration, `reconcile` can perform the declared commit, push, acknowledgement, and cleanup. A blocked delivery records a sanitized reason and waits for `retry-delivery`. Retrying the assignment is a separate operation that first archives the previous worktree. Acknowledged and abandoned workspaces can then be cleaned safely.

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

Capacity is enforced with atomic leases at repository and machine scope:

- Luna: 10 active executors per repository and 10 across the PC;
- Sol: 4 active executors per repository and 4 across the PC;
- total machine capacity: 14 executors;
- Playwright: 2 across the PC, counted inside the Luna pool.

The root and Ultra process do not consume executor slots. Executors started by Ultra do. Reaching an executor pool limit fails immediately. Durable assignments may remain explicitly queued until `reconcile` can start them; the launcher does not create a second hidden queue.

These numbers are upper bounds, not a target. Parallel work should have independent evidence or ownership. Overlapping writes must remain sequential, and creating redundant executors usually costs more integration time than it saves.

Inspect active leases and capacity with:

```text
node .agents/skills/sol-luna-orchestration/scripts/orchestration-gate.mjs status --cwd .
```

Dead leases are removed only after their registered process identity is confirmed stopped or reused. An identity that cannot be inspected fails closed. Corrupt authority state also fails closed.

## Playwright profile

The `playwright` profile verifies that the `playwright` MCP is installed, enabled, configured over stdio, and pinned to `npx --yes @playwright/mcp@0.0.80` before Codex starts. `npm run install:global` installs or repairs that exact configuration while preserving unrelated MCP settings. For this profile only, the launcher gives the App Server process `mcp_servers.playwright.default_tools_approval_mode="approve"`, so briefing-authorized browser actions can run non-interactively, and adds `browser_run_code_unsafe` to that process's MCP deny-list. These overrides are not written to global configuration. Each run gives the MCP process a unique temporary working directory and extends the pinned arguments with its official `--isolated` and `--output-dir` options pointing to the same location. The launcher removes that directory in `finally`, so implicit outputs and explicit relative screenshot names cannot create artifacts in the repository.

The session must emit an actual Playwright MCP tool call. A successful result includes `playwright_mcp:verified` in `checks`; the executor cannot add that verification itself.

Executor turns are non-interactive and start with App Server approval policy `never`. Command and file approvals are declined, permission grants return an empty grant, and MCP elicitations are declined using the response shape required by the installed App Server. A non-blocking user-input request receives an empty answer and execution continues. A blocking, non-sensitive question becomes a durable operator request; after the answer is acknowledged and the assignment is retried, the answer is included in the next briefing. Sensitive input is never written to durable state and fails closed.

Full interaction is allowed on localhost and explicitly named development or test environments. External sites are observation-only unless the briefing explicitly authorizes a named state-changing action and destination. Purchases, deletion, publishing, messaging, account or security changes, production mutation, and `browser_run_code_unsafe` are always prohibited.

## Exclusive Ultra takeover

Ultra is not an executor profile. It temporarily replaces the root for one repository and requires both a reason and explicit human confirmation:

```text
briefing | node .agents/skills/sol-luna-orchestration/scripts/invoke-sol-ultra.mjs --cwd . --reason "Named exceptional decision" --confirm-exclusive-takeover --sandbox read-only
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

`verify:platform` is the authentication-free compatibility gate and includes a live fingerprint check for the current process. It also verifies the exact App Server response contracts used for approvals, permission grants, user input, and MCP elicitation. `verify:live -- --schema-only` runs one root turn against the production output schema. `verify:live -- --playwright-only` runs one isolated localhost Playwright interaction without invoking the other profiles. The full live verification checks the root and every profile against protocol and rollout evidence, uses temporary repositories for write tests, and confirms that read-only checks leave this repository unchanged. Add `--output <path-outside-the-repository>` when an evidence artifact is required.
