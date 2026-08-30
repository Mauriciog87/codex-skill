import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssignment } from "../.agents/skills/sol-luna-orchestration/scripts/control-plane.mjs";
import { getRepositoryState } from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-state.mjs";
import {
  GitWorkspaceError,
  assertMainCheckoutCompatible,
  cleanupAssignmentWorktree,
  createAssignmentWorktree,
  createCandidate,
  inspectGitRepository,
  integrateCandidate,
  parsePorcelainV2,
  readWorkspaceStatus,
  runGit,
  runRequiredChecks,
} from "../.agents/skills/sol-luna-orchestration/scripts/git-workspace.mjs";

async function createRepositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), "sol-luna-git-workspace-"));
  const repository = join(root, "repository");
  const home = join(root, "home");
  await mkdir(join(repository, "src"), { recursive: true });
  await mkdir(home, { recursive: true });
  await runGit(["init"], { cwd: repository });
  await runGit(["config", "core.autocrlf", "false"], { cwd: repository });
  await writeFile(join(repository, "src", "value.txt"), "base\n", "utf8");
  await writeFile(join(repository, "outside.txt"), "outside\n", "utf8");
  await runGit(["add", "-A"], { cwd: repository });
  await runGit(
    ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "initial"],
    { cwd: repository },
  );
  const options = {
    environment: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex") },
    homeDirectory: home,
    platform: process.platform,
  };
  const repositoryInfo = await inspectGitRepository(repository, options);
  return { root, repository, home, options, repositoryInfo };
}

async function createWriterAssignment(fixture, overrides = {}) {
  return createAssignment({
    cwd: fixture.repository,
    briefing: "Modify the scoped file.",
    ...fixture.options,
    request: {
      profile: "implement",
      base_revision: fixture.repositoryInfo.head,
      priority: "normal",
      allowed_write_roots: ["src"],
      forbidden_write_roots: [],
      required_checks: [],
      artifacts: [],
      review_policy: "root",
      operator_approval_required: false,
      ...overrides,
    },
  });
}

test("porcelain v2 parser retains both sides of renames", () => {
  const input = Buffer.from(
    "1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb src/file.txt\0" +
      "2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 src/new.txt\0src/old.txt\0" +
      "? src/untracked.txt\0",
  );
  assert.deepEqual(parsePorcelainV2(input), [
    { kind: "ordinary", xy: ".M", path: "src/file.txt", original_path: null },
    { kind: "rename", xy: "R.", path: "src/new.txt", original_path: "src/old.txt" },
    { kind: "untracked", xy: "??", path: "src/untracked.txt", original_path: null },
  ]);
});

test("writer worktree isolates changes and candidate integration stays unstaged", async () => {
  const fixture = await createRepositoryFixture();
  let record;
  try {
    record = await createWriterAssignment(fixture);
    const workspace = await createAssignmentWorktree(record, fixture.options);
    record = { ...record, workspace };
    await writeFile(join(workspace.path, "src", "value.txt"), "candidate\n", "utf8");
    assert.equal(await readFile(join(fixture.repository, "src", "value.txt"), "utf8"), "base\n");
    const created = await createCandidate(record, workspace.path, {
      ...fixture.options,
      reportedChangedFiles: ["src/value.txt"],
      checkResults: [],
    });
    assert.ok(created.candidate.candidate_id.length === 64);
    assert.deepEqual(created.changedFiles, ["src/value.txt"]);
    record = { ...record, candidate: created.candidate };
    await writeFile(join(fixture.repository, "outside.txt"), "staged outside\n", "utf8");
    await runGit(["add", "outside.txt"], { cwd: fixture.repository });
    const integration = await integrateCandidate(record, fixture.repository, fixture.options);
    assert.equal(integration.applied_diff_sha256, created.candidate.diff_sha256);
    assert.equal(await readFile(join(fixture.repository, "src", "value.txt"), "utf8"), "candidate\n");
    const cached = await runGit(["diff", "--cached", "--quiet", "--", "src/value.txt"], {
      cwd: fixture.repository,
      allowFailure: true,
    });
    assert.equal(cached.exitCode, 0);
    const unrelatedCached = await runGit(["diff", "--cached", "--quiet", "--", "outside.txt"], {
      cwd: fixture.repository,
      allowFailure: true,
    });
    assert.equal(unrelatedCached.exitCode, 1);
    const repeated = await integrateCandidate(record, fixture.repository, fixture.options);
    assert.equal(repeated.idempotent, true);
    await cleanupAssignmentWorktree(record, fixture.options);
  } finally {
    await runGit(["reset", "--hard", "HEAD"], { cwd: fixture.repository, allowFailure: true });
    await runGit(["worktree", "prune"], { cwd: fixture.repository, allowFailure: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("dirty main paths inside scope block worktree creation while outside paths are reported", async () => {
  const fixture = await createRepositoryFixture();
  try {
    await writeFile(join(fixture.repository, "src", "value.txt"), "dirty\n", "utf8");
    await assert.rejects(
      assertMainCheckoutCompatible(fixture.repository, ["src"], fixture.options),
      /local changes inside the assignment scope/,
    );
    await runGit(["reset", "--hard", "HEAD"], { cwd: fixture.repository });
    await writeFile(join(fixture.repository, "outside.txt"), "dirty outside\n", "utf8");
    const compatibility = await assertMainCheckoutCompatible(fixture.repository, ["src"], fixture.options);
    assert.deepEqual(compatibility.excludedDirtyPaths, ["outside.txt"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("candidate publication rejects out-of-scope changes and changed_files mismatches", async () => {
  const fixture = await createRepositoryFixture();
  let record;
  try {
    record = await createWriterAssignment(fixture);
    const workspace = await createAssignmentWorktree(record, fixture.options);
    record = { ...record, workspace };
    await writeFile(join(workspace.path, "outside.txt"), "violation\n", "utf8");
    await assert.rejects(
      createCandidate(record, workspace.path, {
        ...fixture.options,
        reportedChangedFiles: ["outside.txt"],
      }),
      /outside the assignment contract/,
    );
    await runGit(["checkout", "--", "outside.txt"], { cwd: workspace.path });
    await writeFile(join(workspace.path, "src", "value.txt"), "candidate\n", "utf8");
    await assert.rejects(
      createCandidate(record, workspace.path, {
        ...fixture.options,
        reportedChangedFiles: [],
      }),
      (error) => error instanceof GitWorkspaceError && error.code === "changed-files-mismatch",
    );
    await cleanupAssignmentWorktree(record, fixture.options);
  } finally {
    await runGit(["worktree", "prune"], { cwd: fixture.repository, allowFailure: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("required checks run without a shell and declared artifacts are hashed and copied", async () => {
  const fixture = await createRepositoryFixture();
  let record;
  try {
    record = await createWriterAssignment(fixture, {
      required_checks: [{ id: "node-check", argv: [process.execPath, "-e", "process.exit(0)"], cwd: ".", timeout_seconds: 10 }],
      artifacts: [{ name: "report", path: "src/report.txt", kind: "file" }],
    });
    const workspace = await createAssignmentWorktree(record, fixture.options);
    record = { ...record, workspace };
    await writeFile(join(workspace.path, "src", "value.txt"), "candidate\n", "utf8");
    await writeFile(join(workspace.path, "src", "report.txt"), "evidence\n", "utf8");
    const checks = await runRequiredChecks(record, workspace.path, fixture.options);
    assert.equal(checks[0].exit_code, 0);
    const status = await readWorkspaceStatus(workspace.path, fixture.options);
    assert.equal(status.length, 2);
    const created = await createCandidate(record, workspace.path, {
      ...fixture.options,
      reportedChangedFiles: ["src/report.txt", "src/value.txt"],
      checkResults: checks,
    });
    assert.equal(created.artifacts.length, 1);
    assert.equal(await readFile(created.artifacts[0].stored_path, "utf8"), "evidence\n");
    await cleanupAssignmentWorktree(record, fixture.options);
  } finally {
    await runGit(["worktree", "prune"], { cwd: fixture.repository, allowFailure: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("candidate refs are idempotent for identical content and immutable for changed content", async () => {
  const fixture = await createRepositoryFixture();
  let record;
  try {
    record = await createWriterAssignment(fixture);
    const workspace = await createAssignmentWorktree(record, fixture.options);
    record = { ...record, workspace };
    const file = join(workspace.path, "src", "value.txt");
    await writeFile(file, "first candidate\n", "utf8");
    const first = await createCandidate(record, workspace.path, {
      ...fixture.options,
      reportedChangedFiles: ["src/value.txt"],
    });
    const repeated = await createCandidate(record, workspace.path, {
      ...fixture.options,
      reportedChangedFiles: ["src/value.txt"],
    });
    assert.equal(repeated.candidate.candidate_id, first.candidate.candidate_id);
    assert.equal(repeated.candidate.candidate_revision, first.candidate.candidate_revision);
    await writeFile(file, "different candidate\n", "utf8");
    await assert.rejects(
      createCandidate(record, workspace.path, {
        ...fixture.options,
        reportedChangedFiles: ["src/value.txt"],
      }),
      (error) => error instanceof GitWorkspaceError && error.code === "candidate-ref-exists",
    );
    await cleanupAssignmentWorktree(record, fixture.options);
  } finally {
    await runGit(["worktree", "prune"], { cwd: fixture.repository, allowFailure: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("worktree cleanup refuses unmanaged paths and treats null setup paths as empty", async () => {
  const fixture = await createRepositoryFixture();
  try {
    const record = await createWriterAssignment(fixture);
    assert.deepEqual(
      await cleanupAssignmentWorktree({ ...record, workspace: { path: null } }, fixture.options),
      { cleaned: false, reason: "no-worktree" },
    );
    await assert.rejects(
      cleanupAssignmentWorktree({ ...record, workspace: { path: fixture.repository } }, fixture.options),
      (error) => error instanceof GitWorkspaceError && error.code === "unmanaged-worktree",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("short Windows-safe worktree roots retain the full repository identity", async () => {
  const fixture = await createRepositoryFixture();
  try {
    const state = await getRepositoryState(fixture.repository, fixture.options);
    await mkdir(state.worktreesDirectory, { recursive: true });
    await writeFile(
      join(state.worktreesDirectory, "repository.json"),
      `${JSON.stringify({ schema_version: 1, repository_key: "f".repeat(64), repository: fixture.repository })}\n`,
      "utf8",
    );
    const record = await createWriterAssignment(fixture);
    await assert.rejects(
      createAssignmentWorktree(record, fixture.options),
      (error) => error instanceof GitWorkspaceError && error.code === "worktree-root-collision",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
