import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createAction, createAssignment, dispatchAssignmentAction, readAssignment } from "../.agents/skills/sol-luna-orchestration/scripts/control-plane.mjs";
import { executeControlCommand } from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-control.mjs";
import { acquireUltraLock, getOrchestrationStatus, getRepositoryKey, getRepositoryState } from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-state.mjs";
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
  runProcess,
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

test("linked worktrees share their main repository coordination namespace", async () => {
  const fixture = await createRepositoryFixture();
  try {
    const record = await createWriterAssignment(fixture);
    const workspace = await createAssignmentWorktree(record, fixture.options);
    const main = await getRepositoryState(fixture.repository, fixture.options);
    const linked = await getRepositoryState(workspace.path, fixture.options);
    assert.equal(linked.key, main.key);
    assert.equal(linked.repository, main.repository);
    assert.equal(linked.lockPath, main.lockPath);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("legacy worktree assignments can be archived and cleaned through their exact identifiers", async () => {
  const fixture = await createRepositoryFixture();
  try {
    let record = await createWriterAssignment(fixture);
    const workspace = await createAssignmentWorktree(record, fixture.options);
    const main = await getRepositoryState(fixture.repository, fixture.options);
    const linked = join(fixture.root, "legacy-checkout");
    await runGit(["worktree", "add", "--detach", linked, record.base_revision], { cwd: fixture.repository });
    const repository = await realpath(linked);
    const key = getRepositoryKey(repository);
    const legacyDirectory = join(dirname(main.stateDirectory), key);
    const legacyWorktrees = join(dirname(main.worktreesDirectory), key.slice(0, 16));
    const path = join(legacyWorktrees, `work-${record.assignment_id.replaceAll("-", "").slice(0, 16)}-1`);
    await mkdir(join(legacyDirectory, "assignments"), { recursive: true });
    await mkdir(legacyWorktrees, { recursive: true });
    await runGit(["worktree", "move", workspace.path, path], { cwd: fixture.repository });
    await writeFile(join(legacyWorktrees, "repository.json"), JSON.stringify({ schema_version: 1, repository, repository_key: key }));
    await writeFile(join(legacyDirectory, "repository-state.json"), JSON.stringify({ version: 2, repository, repository_key: key, current_generation: 7, history_sequence: 0, updated_at: new Date().toISOString() }));
    const assignmentDirectory = join(legacyDirectory, "assignments", record.assignment_id);
    await rename(join(main.assignmentsDirectory, record.assignment_id), assignmentDirectory);
    record = { ...record, repository, repository_key: key, state: "failed", workspace: { ...workspace, path } };
    await writeFile(join(assignmentDirectory, "record.json"), JSON.stringify(record));
    const before = await getOrchestrationStatus(fixture.repository, fixture.options);
    assert.ok(before.legacy_namespaces.some((entry) => entry.pending_assignment_ids.includes(record.assignment_id)));
    const command = (name, revision, extra = []) => runProcess(process.execPath, [
      join(import.meta.dirname, "../.agents/skills/sol-luna-orchestration/scripts/orchestration-control.mjs"),
      name, "--cwd", fixture.repository, "--assignment-id", record.assignment_id,
      "--revision", String(revision), "--authority", "root", ...extra,
    ], { ...fixture.options, cwd: fixture.repository, allowFailure: true });
    const abandoned = await command("abandon", record.state_revision, ["--reason", "Resolve legacy assignment"]);
    assert.equal(abandoned.exitCode, 0, abandoned.stdout.toString() + abandoned.stderr.toString());
    record = await readAssignment(fixture.repository, record.assignment_id, fixture.options);
    assert.equal(record.state, "abandoned");
    assert.equal(await realpath(dirname(record.workspace.archive_path)), await realpath(legacyWorktrees));
    const cleaned = await command("cleanup", record.state_revision);
    assert.equal(cleaned.exitCode, 0, cleaned.stdout.toString() + cleaned.stderr.toString());
    assert.equal((await readAssignment(fixture.repository, record.assignment_id, fixture.options)).workspace.cleaned, true);
    assert.ok((await getOrchestrationStatus(fixture.repository, fixture.options)).legacy_namespaces.every((entry) => !entry.blocked));
    await access(join(assignmentDirectory, "record.json"));
    await runGit(["worktree", "remove", linked], { cwd: fixture.repository });
    assert.equal((await readAssignment(fixture.repository, record.assignment_id, fixture.options)).state, "abandoned");
    const next = await acquireUltraLock({ cwd: fixture.repository, reason: "After legacy recovery", sandboxMode: "read-only", ...fixture.options });
    assert.equal(next.generation, 8);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("large candidate patches integrate every byte instead of a truncated suffix", async () => {
  const fixture = await createRepositoryFixture();
  try {
    let record = await createWriterAssignment(fixture);
    const workspace = await createAssignmentWorktree(record, fixture.options);
    record = { ...record, workspace };
    const large = "candidate line\n".repeat(30_000);
    await writeFile(join(workspace.path, "src", "value.txt"), large);
    await writeFile(join(workspace.path, "src", "z-small.txt"), "small\n");
    const created = await createCandidate(record, workspace.path, { ...fixture.options, reportedChangedFiles: ["src/value.txt", "src/z-small.txt"], checkResults: [] });
    record = { ...record, candidate: created.candidate };
    await integrateCandidate(record, fixture.repository, fixture.options);
    const actual = await readFile(join(fixture.repository, "src", "value.txt"));
    assert.equal(actual.length, Buffer.byteLength(large));
    assert.equal(createHash("sha256").update(actual).digest("hex"), createHash("sha256").update(large).digest("hex"));
    assert.equal(await readFile(join(fixture.repository, "src", "z-small.txt"), "utf8"), "small\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("legacy publication-only delivery can complete without creating another commit", async () => {
  const fixture = await createRepositoryFixture();
  try {
    const record = await prepareIntegratedCandidate(fixture, { mode: "commit", commit_message: "Publish once", remote: null, branch: null });
    const delivered = await commitIntegratedCandidate(record, fixture.repository, fixture.options);
    await runGit(["update-ref", "refs/heads/master", record.integration.target_revision_before], { cwd: fixture.repository });
    await runGit(["reset", record.integration.target_revision_before, "--", ...record.candidate.changed_paths], { cwd: fixture.repository });
    const retried = await commitIntegratedCandidate(record, fixture.repository, fixture.options);
    assert.equal(retried.commit_revision, delivered.commit_revision);
    assert.equal((await runGit(["rev-parse", "HEAD"], { cwd: fixture.repository })).stdoutText.trim(), delivered.commit_revision);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Git output overflow rejects only after the child has closed", async () => {
  let closed = false;
  const promise = runGit(["diff"], { maxOutputBytes: 1024, spawnImplementation: () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = () => queueMicrotask(() => { closed = true; child.emit("close", 1, "SIGTERM"); });
    queueMicrotask(() => child.stdout.emit("data", Buffer.alloc(1025)));
    return child;
  } });
  await assert.rejects(promise, (error) => error.code === "process-output-limit");
  assert.equal(closed, true);
});

test("Git data keeps the complete boundary-sized output while diagnostics stay bounded", async () => {
  const spawnImplementation = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.alloc(200_000, 65));
      child.stderr.emit("data", Buffer.alloc(200_000, 66));
      child.emit("close", 0, null);
    });
    return child;
  };
  const data = await runGit(["diff"], { maxOutputBytes: 200_000, spawnImplementation });
  assert.equal(data.stdout.length, 200_000);
  assert.equal(data.stderr.length, 131_072);
  const diagnostics = await runProcess("check", [], { spawnImplementation });
  assert.equal(diagnostics.stdout.length, 131_072);
});

test("failed ref transactions leave both branch and publication unchanged", async () => {
  const fixture = await createRepositoryFixture();
  try {
    const record = await prepareIntegratedCandidate(fixture, { mode: "commit", commit_message: "Atomic delivery", remote: null, branch: null });
    const publication = `refs/codex-orchestration/deliveries/${record.assignment_id}/${record.attempt}`;
    await assert.rejects(commitIntegratedCandidate(record, fixture.repository, {
      ...fixture.options,
      spawnImplementation: (command, args, options) => {
        const child = spawn(command, args, options);
        if (args.includes("update-ref") && args.includes("--stdin")) {
          const end = child.stdin.end.bind(child.stdin);
          child.stdin.end = (input) => end(String(input).replace(` ${record.integration.target_revision_before}\n`, ` ${"f".repeat(40)}\n`));
        }
        return child;
      },
    }), (error) => error.code === "publication-branch-diverged");
    assert.equal((await runGit(["rev-parse", "HEAD"], { cwd: fixture.repository })).stdoutText.trim(), record.integration.target_revision_before);
    assert.equal((await runGit(["rev-parse", "--verify", publication], { cwd: fixture.repository, allowFailure: true })).exitCode !== 0, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("publication retry preserves new staging and reconstructs a missing publication ref", async () => {
  const fixture = await createRepositoryFixture();
  try {
    const record = await prepareIntegratedCandidate(fixture, { mode: "commit", commit_message: "Preserve staging", remote: null, branch: null });
    const delivered = await commitIntegratedCandidate(record, fixture.repository, fixture.options);
    await writeFile(join(fixture.repository, "src", "value.txt"), "new staged work\n");
    await runGit(["add", "src/value.txt"], { cwd: fixture.repository });
    await assert.rejects(commitIntegratedCandidate(record, fixture.repository, fixture.options), (error) => error.code === "delivery-index-dirty");
    assert.equal((await runGit(["show", ":src/value.txt"], { cwd: fixture.repository })).stdoutText, "new staged work\n");
    await writeFile(join(fixture.repository, "src", "value.txt"), "candidate\n");
    await runGit(["add", "src/value.txt"], { cwd: fixture.repository });
    await runGit(["update-ref", "-d", delivered.publication_ref, delivered.commit_revision], { cwd: fixture.repository });
    const repeated = await commitIntegratedCandidate(record, fixture.repository, fixture.options);
    assert.equal(repeated.commit_revision, delivered.commit_revision);
    assert.equal((await runGit(["rev-parse", delivered.publication_ref], { cwd: fixture.repository })).stdoutText.trim(), delivered.commit_revision);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("invalid CLI integration and cleanup leave Git and the controlled workspace untouched", async () => {
  const fixture = await createRepositoryFixture();
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = fixture.options.environment.CODEX_HOME;
  try {
    let record = await createWriterAssignment(fixture);
    const workspace = await createAssignmentWorktree(record, fixture.options);
    record = (await dispatchAssignmentAction(fixture.repository, createAction({ op: "start_assignment", authority: "root", record, payload: { workspace } }), fixture.options)).record;
    await assert.rejects(executeControlCommand({ command: "cleanup", cwd: fixture.repository, assignmentId: record.assignment_id, revision: record.state_revision, authority: "root" }), /cannot|state/i);
    await access(workspace.path);
    assert.equal((await readAssignment(fixture.repository, record.assignment_id, fixture.options)).state, "running");
    await writeFile(join(workspace.path, "src", "value.txt"), "unapproved\n");
    const created = await createCandidate(record, workspace.path, { ...fixture.options, reportedChangedFiles: ["src/value.txt"], checkResults: [] });
    record = (await dispatchAssignmentAction(fixture.repository, createAction({ op: "publish_result", authority: "executor", record, payload: {
      result: { status: "completed", summary: "Candidate", changed_files: ["src/value.txt"], checks: [], blockers: [], warnings: [] }, candidate: created.candidate, operator_requests: [],
    } }), fixture.options)).record;
    await assert.rejects(executeControlCommand({ command: "integrate", cwd: fixture.repository, assignmentId: record.assignment_id, revision: record.state_revision, authority: "root" }), /cannot run/);
    assert.equal(await readFile(join(fixture.repository, "src", "value.txt"), "utf8"), "base\n");
    assert.equal((await runGit(["status", "--porcelain"], { cwd: fixture.repository })).stdoutText, "");
    assert.equal((await readAssignment(fixture.repository, record.assignment_id, fixture.options)).state, "result_ready");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("candidate verification covers binary additions, renames, deletion and executable mode", async () => {
  const fixture = await createRepositoryFixture();
  try {
    let record = await createWriterAssignment(fixture);
    const workspace = await createAssignmentWorktree(record, fixture.options);
    record = { ...record, workspace };
    await rename(join(workspace.path, "src", "value.txt"), join(workspace.path, "src", "moved.txt"));
    const binary = Buffer.from([0, 255, 128, 13, 10, 0, 1]);
    await writeFile(join(workspace.path, "src", "binary.dat"), binary);
    if (process.platform !== "win32") await chmod(join(workspace.path, "src", "moved.txt"), 0o755);
    const created = await createCandidate(record, workspace.path, { ...fixture.options, reportedChangedFiles: ["src/value.txt", "src/moved.txt", "src/binary.dat"], checkResults: [] });
    record = { ...record, candidate: created.candidate };
    await integrateCandidate(record, fixture.repository, fixture.options);
    assert.deepEqual(await readFile(join(fixture.repository, "src", "binary.dat")), binary);
    assert.equal(await readFile(join(fixture.repository, "src", "moved.txt"), "utf8"), "base\n");
    await assert.rejects(access(join(fixture.repository, "src", "value.txt")), { code: "ENOENT" });
    assert.equal((await integrateCandidate(record, fixture.repository, fixture.options)).idempotent, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a partially applied candidate is rejected even when Git reports success", async () => {
  const fixture = await createRepositoryFixture();
  try {
    let record = await createWriterAssignment(fixture);
    const workspace = await createAssignmentWorktree(record, fixture.options);
    record = { ...record, workspace };
    await writeFile(join(workspace.path, "src", "value.txt"), "candidate\n");
    await writeFile(join(workspace.path, "src", "z-small.txt"), "small\n");
    const created = await createCandidate(record, workspace.path, { ...fixture.options, reportedChangedFiles: ["src/value.txt", "src/z-small.txt"], checkResults: [] });
    record = { ...record, candidate: created.candidate };
    await assert.rejects(integrateCandidate(record, fixture.repository, {
      ...fixture.options,
      spawnImplementation: (command, args, options) => {
        const child = spawn(command, args, options);
        if (args.includes("apply") && !args.includes("--check")) {
          const end = child.stdin.end.bind(child.stdin);
          child.stdin.end = (input) => end(input.subarray(input.indexOf("diff --git a/src/z-small.txt")));
        }
        return child;
      },
    }), (error) => error.code === "candidate-workspace-mismatch");
    assert.equal(await readFile(join(fixture.repository, "src", "value.txt"), "utf8"), "base\n");
    await assert.rejects(integrateCandidate(record, fixture.repository, fixture.options), (error) => error.code === "integration-dirty-path");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
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
