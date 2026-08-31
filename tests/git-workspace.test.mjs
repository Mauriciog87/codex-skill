import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createAssignment } from "../.agents/skills/sol-luna-orchestration/scripts/control-plane.mjs";
import { getRepositoryState } from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-state.mjs";
import {
  GitWorkspaceError,
  archiveAssignmentWorktree,
  assertMainCheckoutCompatible,
  cleanupAssignmentWorktree,
  commitIntegratedCandidate,
  createAssignmentWorktree,
  createCandidate,
  inspectGitRepository,
  integrateCandidate,
  gitArgumentsForPlatform,
  parsePorcelainV2,
  pushCommittedCandidate,
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
  await runGit(["branch", "-M", "master"], { cwd: repository });
  await runGit(["config", "user.name", "Test"], { cwd: repository });
  await runGit(["config", "user.email", "test@localhost"], { cwd: repository });
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

async function prepareIntegratedCandidate(fixture, delivery) {
  let record = await createWriterAssignment(fixture, { delivery });
  const workspace = await createAssignmentWorktree(record, fixture.options);
  record = { ...record, workspace };
  await writeFile(join(workspace.path, "src", "value.txt"), "candidate\n", "utf8");
  const created = await createCandidate(record, workspace.path, {
    ...fixture.options,
    reportedChangedFiles: ["src/value.txt"],
    checkResults: [],
  });
  record = { ...record, candidate: created.candidate };
  const integration = await integrateCandidate(record, fixture.repository, fixture.options);
  return {
    ...record,
    state: "commit_pending",
    integration: {
      candidate_id: created.candidate.candidate_id,
      target_revision_before: integration.target_revision_before,
      applied_diff_sha256: integration.applied_diff_sha256,
    },
  };
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

test("Git enables long paths per Windows command without changing other platforms", () => {
  const args = ["worktree", "list", "--porcelain", "-z"];
  assert.deepEqual(
    gitArgumentsForPlatform(args, "win32"),
    ["-c", "core.longpaths=true", ...args],
  );
  assert.deepEqual(gitArgumentsForPlatform(args, "linux"), args);
  assert.deepEqual(gitArgumentsForPlatform(args, "darwin"), args);
});

test("runGit derives its long-path override from the host instead of caller options", async () => {
  let invokedArgs = null;
  await runGit(["status", "--short"], {
    platform: process.platform === "win32" ? "linux" : "win32",
    spawnImplementation: (executable, args) => {
      assert.equal(executable, "git");
      invokedArgs = args;
      const child = new EventEmitter();
      child.stdin = { end: () => {} };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  });
  assert.deepEqual(
    invokedArgs,
    gitArgumentsForPlatform(["status", "--short"], process.platform),
  );
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

test("worktree cleanup accepts canonical paths beneath an aliased state root", async () => {
  const fixture = await createRepositoryFixture();
  try {
    const aliasedHome = join(fixture.root, "aliased-home");
    await symlink(fixture.home, aliasedHome, process.platform === "win32" ? "junction" : "dir");
    const aliasedOptions = {
      ...fixture.options,
      environment: {
        ...fixture.options.environment,
        HOME: aliasedHome,
        CODEX_HOME: join(aliasedHome, ".codex"),
      },
      homeDirectory: aliasedHome,
    };
    const record = await createWriterAssignment({ ...fixture, options: aliasedOptions });
    const workspace = await createAssignmentWorktree(record, aliasedOptions);
    const cleanup = await cleanupAssignmentWorktree({ ...record, workspace }, aliasedOptions);
    assert.equal(cleanup.cleaned, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("worktree archive and cleanup are idempotent with paths longer than 260 characters", async () => {
  const fixture = await createRepositoryFixture();
  try {
    await runGit(["config", "--local", "core.longpaths", "false"], {
      ...fixture.options,
      cwd: fixture.repository,
    });
    const record = await createWriterAssignment(fixture);
    const workspace = await createAssignmentWorktree(record, fixture.options);
    const activeRecord = { ...record, workspace };
    let deepDirectory = workspace.path;
    for (let index = 0; index < 6; index += 1) {
      deepDirectory = join(deepDirectory, `${String(index)}-${"nested".repeat(8)}`);
    }
    await mkdir(deepDirectory, { recursive: true });
    const deepFile = join(deepDirectory, "value.txt");
    await writeFile(deepFile, "long path\n", "utf8");
    assert.ok(deepFile.length > 260, `Expected a path longer than 260 characters, received ${deepFile.length}.`);

    const archivedPath = await archiveAssignmentWorktree(activeRecord, fixture.options);
    assert.ok(archivedPath.length <= workspace.path.length);
    assert.match(archivedPath, /[\\/]a-[^\\/]+$/);
    assert.equal(
      await archiveAssignmentWorktree(activeRecord, fixture.options),
      archivedPath,
    );

    const archivedRecord = {
      ...activeRecord,
      workspace: { ...workspace, archive_path: archivedPath, archived: true },
    };
    assert.equal((await cleanupAssignmentWorktree(archivedRecord, fixture.options)).cleaned, true);
    assert.equal((await cleanupAssignmentWorktree(archivedRecord, fixture.options)).cleaned, true);
    await assert.rejects(access(archivedPath), { code: "ENOENT" });
    const configured = await runGit(["config", "--local", "--get", "core.longpaths"], {
      ...fixture.options,
      cwd: fixture.repository,
    });
    assert.equal(configured.stdoutText.trim(), "false");
  } finally {
    await runGit(["worktree", "prune", "--expire", "now"], {
      cwd: fixture.repository,
      allowFailure: true,
    });
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("archive recovery supports legacy destinations and rejects conflicting paths", async () => {
  const fixture = await createRepositoryFixture();
  try {
    const legacyRecord = await createWriterAssignment(fixture);
    const legacyWorkspace = await createAssignmentWorktree(legacyRecord, fixture.options);
    const state = await getRepositoryState(fixture.repository, fixture.options);
    const legacyPath = join(
      state.worktreesDirectory,
      "archive",
      `archive-${legacyRecord.assignment_id.replaceAll("-", "").slice(0, 16)}-${legacyRecord.attempt}`,
    );
    await mkdir(dirname(legacyPath), { recursive: true });
    await runGit(["worktree", "move", legacyWorkspace.path, legacyPath], {
      ...fixture.options,
      cwd: fixture.repository,
    });
    const recognizedLegacyPath = await archiveAssignmentWorktree(
      { ...legacyRecord, workspace: legacyWorkspace },
      fixture.options,
    );
    assert.equal(recognizedLegacyPath, await realpath(legacyPath));
    const archivedLegacyRecord = {
      ...legacyRecord,
      workspace: {
        ...legacyWorkspace,
        archive_path: recognizedLegacyPath,
        archived: true,
      },
    };
    assert.equal((await cleanupAssignmentWorktree(archivedLegacyRecord, fixture.options)).cleaned, true);
    assert.equal((await cleanupAssignmentWorktree(archivedLegacyRecord, fixture.options)).cleaned, true);

    const conflictRecord = await createWriterAssignment(fixture);
    const conflictWorkspace = await createAssignmentWorktree(conflictRecord, fixture.options);
    const shortPath = join(
      state.worktreesDirectory,
      `a-${conflictRecord.assignment_id.replaceAll("-", "").slice(0, 16)}-${conflictRecord.attempt}`,
    );
    await mkdir(shortPath, { recursive: true });
    await assert.rejects(
      archiveAssignmentWorktree(
        { ...conflictRecord, workspace: conflictWorkspace },
        fixture.options,
      ),
      (error) => error instanceof GitWorkspaceError && error.code === "worktree-archive-conflict",
    );
    await cleanupAssignmentWorktree(
      { ...conflictRecord, workspace: conflictWorkspace },
      fixture.options,
    );
    const legacyConflictPath = join(
      state.worktreesDirectory,
      "archive",
      `archive-${conflictRecord.assignment_id.replaceAll("-", "").slice(0, 16)}-${conflictRecord.attempt}`,
    );
    await mkdir(legacyConflictPath, { recursive: true });
    await assert.rejects(
      archiveAssignmentWorktree(
        { ...conflictRecord, workspace: conflictWorkspace },
        fixture.options,
      ),
      (error) => error instanceof GitWorkspaceError && error.code === "worktree-archive-conflict",
    );
  } finally {
    await runGit(["worktree", "prune", "--expire", "now"], {
      cwd: fixture.repository,
      allowFailure: true,
    });
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

test("automatic delivery commits only the candidate paths and preserves unrelated staged work", async () => {
  const fixture = await createRepositoryFixture();
  try {
    const remote = join(fixture.root, "remote.git");
    await runGit(["init", "--bare", remote], { cwd: fixture.root });
    await runGit(["remote", "add", "origin", remote], { cwd: fixture.repository });
    await runGit(["push", "origin", "HEAD:refs/heads/master"], { cwd: fixture.repository });
    let record = await prepareIntegratedCandidate(fixture, {
      mode: "push",
      commit_message: "feat: publish validated candidate",
      remote: "origin",
      branch: "master",
    });
    await writeFile(join(fixture.repository, "outside.txt"), "staged outside\n", "utf8");
    await runGit(["add", "outside.txt"], { cwd: fixture.repository });
    const committed = await commitIntegratedCandidate(record, fixture.repository, fixture.options);
    assert.equal(committed.parent_revision, fixture.repositoryInfo.head);
    assert.equal(committed.branch_ref, "refs/heads/master");
    assert.equal(
      (await runGit(["show", `${committed.commit_revision}:outside.txt`], { cwd: fixture.repository })).stdoutText,
      "outside\n",
    );
    assert.equal(
      (await runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", committed.commit_revision], {
        cwd: fixture.repository,
      })).stdoutText.trim(),
      "src/value.txt",
    );
    assert.equal(
      (await runGit(["diff", "--cached", "--quiet", "--", "outside.txt"], {
        cwd: fixture.repository,
        allowFailure: true,
      })).exitCode,
      1,
    );
    assert.equal(
      (await runGit(["diff", "--quiet", "--", "src/value.txt"], {
        cwd: fixture.repository,
        allowFailure: true,
      })).exitCode,
      0,
    );
    const repeatedCommit = await commitIntegratedCandidate(record, fixture.repository, fixture.options);
    assert.equal(repeatedCommit.commit_revision, committed.commit_revision);
    assert.equal(repeatedCommit.idempotent, true);
    record = { ...record, state: "push_pending", delivery: { ...record.delivery, commit: committed } };
    const pushed = await pushCommittedCandidate(record, fixture.repository, fixture.options);
    assert.equal(pushed.remote_revision_after, committed.commit_revision);
    const repeatedPush = await pushCommittedCandidate(record, fixture.repository, fixture.options);
    assert.equal(repeatedPush.idempotent, true);
    assert.equal(
      (await runGit(["ls-remote", "origin", "refs/heads/master"], { cwd: fixture.repository })).stdoutText.split(/\s/)[0],
      committed.commit_revision,
    );
  } finally {
    await runGit(["worktree", "prune"], { cwd: fixture.repository, allowFailure: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("automatic commit delivers validated additions and deletions", async () => {
  const fixture = await createRepositoryFixture();
  try {
    let record = await createWriterAssignment(fixture, {
      delivery: {
        mode: "commit",
        commit_message: "feat: replace validated file",
      },
    });
    const workspace = await createAssignmentWorktree(record, fixture.options);
    record = { ...record, workspace };
    await unlink(join(workspace.path, "src", "value.txt"));
    await writeFile(join(workspace.path, "src", "replacement.txt"), "replacement\n", "utf8");
    const created = await createCandidate(record, workspace.path, {
      ...fixture.options,
      reportedChangedFiles: ["src/replacement.txt", "src/value.txt"],
      checkResults: [],
    });
    record = { ...record, candidate: created.candidate };
    const integration = await integrateCandidate(record, fixture.repository, fixture.options);
    record = {
      ...record,
      state: "commit_pending",
      integration: {
        candidate_id: created.candidate.candidate_id,
        target_revision_before: integration.target_revision_before,
        applied_diff_sha256: integration.applied_diff_sha256,
      },
    };
    await writeFile(join(fixture.repository, "src", "replacement.txt"), "tampered\n", "utf8");
    await assert.rejects(
      commitIntegratedCandidate(record, fixture.repository, fixture.options),
      (error) => error instanceof GitWorkspaceError && error.code === "delivery-path-dirty",
    );
    await writeFile(join(fixture.repository, "src", "replacement.txt"), "replacement\n", "utf8");
    await writeFile(join(fixture.repository, "src", "value.txt"), "reappeared\n", "utf8");
    await assert.rejects(
      commitIntegratedCandidate(record, fixture.repository, fixture.options),
      (error) => error instanceof GitWorkspaceError && error.code === "delivery-path-dirty",
    );
    await unlink(join(fixture.repository, "src", "value.txt"));
    const committed = await commitIntegratedCandidate(record, fixture.repository, fixture.options);
    assert.equal(
      (await runGit(["show", `${committed.commit_revision}:src/replacement.txt`], {
        cwd: fixture.repository,
      })).stdoutText,
      "replacement\n",
    );
    assert.notEqual(
      (await runGit(["cat-file", "-e", `${committed.commit_revision}:src/value.txt`], {
        cwd: fixture.repository,
        allowFailure: true,
      })).exitCode,
      0,
    );
    assert.equal(
      (await runGit(["status", "--porcelain=v1", "--", "src"], { cwd: fixture.repository })).stdoutText,
      "",
    );
  } finally {
    await runGit(["worktree", "prune"], { cwd: fixture.repository, allowFailure: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("automatic push refuses to publish unrelated local parent commits", async () => {
  const fixture = await createRepositoryFixture();
  try {
    const remote = join(fixture.root, "remote.git");
    await runGit(["init", "--bare", remote], { cwd: fixture.root });
    await runGit(["remote", "add", "origin", remote], { cwd: fixture.repository });
    await runGit(["push", "origin", "HEAD:refs/heads/master"], { cwd: fixture.repository });
    let record = await prepareIntegratedCandidate(fixture, {
      mode: "push",
      commit_message: "feat: publish validated candidate",
      remote: "origin",
      branch: "master",
    });
    await writeFile(join(fixture.repository, "outside.txt"), "unpublished parent\n", "utf8");
    await runGit(["add", "outside.txt"], { cwd: fixture.repository });
    await runGit(["commit", "-m", "unpublished parent"], { cwd: fixture.repository });
    const committed = await commitIntegratedCandidate(record, fixture.repository, fixture.options);
    record = { ...record, state: "push_pending", delivery: { ...record.delivery, commit: committed } };
    await assert.rejects(
      pushCommittedCandidate(record, fixture.repository, fixture.options),
      (error) => error instanceof GitWorkspaceError && error.code === "push-parent-not-published",
    );
  } finally {
    await runGit(["worktree", "prune"], { cwd: fixture.repository, allowFailure: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("automatic push fails closed when the remote branch diverged", async () => {
  const fixture = await createRepositoryFixture();
  try {
    const remote = join(fixture.root, "remote.git");
    const other = join(fixture.root, "other");
    await runGit(["init", "--bare", remote], { cwd: fixture.root });
    await runGit(["remote", "add", "origin", remote], { cwd: fixture.repository });
    await runGit(["push", "origin", "HEAD:refs/heads/master"], { cwd: fixture.repository });
    await runGit(["clone", remote, other], { cwd: fixture.root });
    await runGit(["config", "user.name", "Other"], { cwd: other });
    await runGit(["config", "user.email", "other@localhost"], { cwd: other });
    let record = await prepareIntegratedCandidate(fixture, {
      mode: "push",
      commit_message: "feat: publish validated candidate",
      remote: "origin",
      branch: "master",
    });
    const committed = await commitIntegratedCandidate(record, fixture.repository, fixture.options);
    await writeFile(join(other, "outside.txt"), "remote divergence\n", "utf8");
    await runGit(["add", "outside.txt"], { cwd: other });
    await runGit(["commit", "-m", "remote divergence"], { cwd: other });
    await runGit(["push", "origin", "HEAD:refs/heads/master"], { cwd: other });
    record = { ...record, state: "push_pending", delivery: { ...record.delivery, commit: committed } };
    await assert.rejects(
      pushCommittedCandidate(record, fixture.repository, fixture.options),
      (error) => error instanceof GitWorkspaceError && error.code === "push-non-fast-forward",
    );
  } finally {
    await runGit(["worktree", "prune"], { cwd: fixture.repository, allowFailure: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
});
