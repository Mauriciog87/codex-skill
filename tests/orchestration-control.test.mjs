import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  ControlCliError,
  executeControlCommand,
  parseControlArguments,
} from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-control.mjs";
import {
  createAction,
  createAssignment,
  dispatchAssignmentAction,
  readAssignment,
} from "../.agents/skills/sol-luna-orchestration/scripts/control-plane.mjs";
import {
  createAssignmentWorktree,
  createCandidate,
  inspectGitRepository,
  integrateCandidate,
  runGit,
} from "../.agents/skills/sol-luna-orchestration/scripts/git-workspace.mjs";

test("control CLI parses read-only and exact-revision mutation commands", () => {
  const baseDirectory = resolve("fixtures", "repository");
  assert.deepEqual(parseControlArguments(["next"], baseDirectory), {
    command: "next",
    cwd: baseDirectory,
    assignmentId: null,
    revision: null,
    authority: "root",
    kind: null,
    requestId: null,
    answer: null,
    reason: null,
    watch: false,
    intervalMs: 1000,
    host: "127.0.0.1",
    port: 0,
  });
  const approve = parseControlArguments([
    "approve",
    "--assignment-id",
    "assignment",
    "--revision",
    "7",
    "--kind",
    "operator",
    "--authority",
    "operator",
  ]);
  assert.equal(approve.revision, 7);
  assert.equal(approve.kind, "operator");
  assert.equal(approve.authority, "operator");
  const retryDelivery = parseControlArguments([
    "retry-delivery",
    "--assignment-id",
    "assignment",
    "--revision",
    "9",
  ]);
  assert.equal(retryDelivery.command, "retry-delivery");
  assert.equal(retryDelivery.revision, 9);
});

test("control CLI rejects mutations without an assignment revision", () => {
  for (const args of [
    ["claim"],
    ["claim", "--assignment-id", "assignment"],
    ["approve", "--assignment-id", "assignment", "--revision", "1"],
    ["retry-delivery", "--assignment-id", "assignment"],
    ["answer", "--assignment-id", "assignment", "--revision", "1"],
    ["dashboard", "--host", "0.0.0.0"],
  ]) {
    assert.throws(() => parseControlArguments(args), ControlCliError);
  }
});

test("reconcile automatically commits, pushes, acknowledges, and cleans validated delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "sol-luna-control-delivery-"));
  const repository = join(root, "repository");
  const remote = join(root, "remote.git");
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, "codex-home");
  try {
    await mkdir(join(repository, "src"), { recursive: true });
    await runGit(["init"], { cwd: repository });
    await runGit(["config", "core.autocrlf", "false"], { cwd: repository });
    await runGit(["config", "user.name", "Test"], { cwd: repository });
    await runGit(["config", "user.email", "test@localhost"], { cwd: repository });
    await writeFile(join(repository, "src", "value.txt"), "base\n", "utf8");
    await runGit(["add", "-A"], { cwd: repository });
    await runGit(["commit", "-m", "initial"], { cwd: repository });
    await runGit(["branch", "-M", "master"], { cwd: repository });
    await runGit(["init", "--bare", remote], { cwd: root });
    await runGit(["remote", "add", "origin", remote], { cwd: repository });
    await runGit(["push", "origin", "HEAD:refs/heads/master"], { cwd: repository });
    const repositoryInfo = await inspectGitRepository(repository);
    let record = await createAssignment({
      cwd: repository,
      briefing: "Publish the validated candidate.",
      request: {
        profile: "implement",
        base_revision: repositoryInfo.head,
        priority: "normal",
        allowed_write_roots: ["src"],
        forbidden_write_roots: [],
        required_checks: [],
        artifacts: [],
        review_policy: "root",
        operator_approval_required: false,
        delivery: {
          mode: "push",
          commit_message: "feat: publish validated candidate",
          remote: "origin",
          branch: "master",
        },
      },
    });
    const workspace = await createAssignmentWorktree(record);
    record = (
      await dispatchAssignmentAction(
        repository,
        createAction({ op: "start_assignment", authority: "root", record, payload: { workspace } }),
      )
    ).record;
    await writeFile(join(workspace.path, "src", "value.txt"), "candidate\n", "utf8");
    const created = await createCandidate(record, workspace.path, {
      reportedChangedFiles: ["src/value.txt"],
      checkResults: [],
    });
    record = (
      await dispatchAssignmentAction(
        repository,
        createAction({
          op: "publish_result",
          authority: "executor",
          record,
          payload: {
            result: {
              status: "completed",
              summary: "completed",
              changed_files: ["src/value.txt"],
              checks: [],
              blockers: [],
              warnings: [],
            },
            candidate: created.candidate,
            operator_requests: [],
          },
        }),
      )
    ).record;
    record = (
      await dispatchAssignmentAction(
        repository,
        createAction({ op: "claim_result", authority: "root", record }),
      )
    ).record;
    record = (
      await dispatchAssignmentAction(
        repository,
        createAction({
          op: "approve_candidate",
          authority: "root",
          record,
          payload: { candidate_id: created.candidate.candidate_id, kind: "root" },
        }),
      )
    ).record;
    record = (
      await dispatchAssignmentAction(
        repository,
        createAction({
          op: "integrate_candidate",
          authority: "root",
          record,
          payload: { candidate_id: created.candidate.candidate_id },
        }),
        { beforeTransition: async (current) => integrateCandidate(current, repository) },
      )
    ).record;
    assert.equal(record.state, "commit_pending");
    const reconcile = parseControlArguments(["reconcile", "--cwd", repository]);
    const result = await executeControlCommand(reconcile);
    record = await readAssignment(repository, record.assignment_id);
    assert.equal(record.state, "acknowledged");
    assert.equal(record.workspace.cleaned, true);
    assert.deepEqual(
      result.results.map((item) => item.op),
      ["commit_candidate", "push_candidate", "acknowledge_assignment", "cleanup_workspace"],
    );
    assert.equal(
      (await runGit(["ls-remote", "origin", "refs/heads/master"], { cwd: repository })).stdoutText.split(/\s/)[0],
      record.delivery.commit.commit_revision,
    );
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});
