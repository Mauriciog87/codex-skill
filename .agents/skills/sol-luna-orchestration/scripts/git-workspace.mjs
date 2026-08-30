import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  canonicalJson,
  normalizeRepositoryPath,
  pathWithinRoots,
  resolveContainedPath,
  sha256,
} from "./control-plane.mjs";
import {
  atomicCreate,
  getEntry,
  getRepositoryState,
  readJson,
} from "./orchestration-state.mjs";

const MAX_PROCESS_OUTPUT = 131_072;

function worktreeName(record, prefix = "work") {
  return `${prefix}-${record.assignment_id.replaceAll("-", "").slice(0, 16)}-${record.attempt}`;
}

async function ensureWorktreesDirectory(state) {
  await mkdir(state.worktreesDirectory, { recursive: true });
  const entry = await getEntry(state.worktreesDirectory);
  if (entry === null || !entry.isDirectory() || entry.isSymbolicLink()) {
    throw new GitWorkspaceError("Worktree state root is not a concrete directory.", "invalid-worktree-root");
  }
  const markerPath = join(state.worktreesDirectory, "repository.json");
  if ((await getEntry(markerPath)) === null) {
    try {
      await atomicCreate(markerPath, {
        schema_version: 1,
        repository_key: state.key,
        repository: state.repository,
      });
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
  }
  const marker = await readJson(markerPath, "Worktree repository marker");
  if (
    marker.schema_version !== 1 ||
    marker.repository_key !== state.key ||
    resolve(marker.repository) !== resolve(state.repository)
  ) {
    throw new GitWorkspaceError("Worktree state root belongs to another repository.", "worktree-root-collision");
  }
}

export class GitWorkspaceError extends Error {
  constructor(message, code = "git-workspace-error", details = {}) {
    super(message);
    this.name = "GitWorkspaceError";
    this.code = code;
    this.details = details;
  }
}

function appendLimited(current, chunk) {
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= MAX_PROCESS_OUTPUT
    ? combined
    : combined.subarray(combined.length - MAX_PROCESS_OUTPUT);
}

export function runProcess(executable, args, {
  cwd,
  environment = process.env,
  input = null,
  timeoutMs = 900_000,
  spawnImplementation = spawn,
} = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawnImplementation(executable, args, {
        cwd,
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      rejectPromise(new GitWorkspaceError(`Unable to start ${executable}: ${error.message}`, "process-start-failed"));
      return;
    }
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => rejectPromise(new GitWorkspaceError(`${executable} timed out.`, "process-timeout")));
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, Buffer.from(chunk));
    });
    child.once("error", (error) => {
      finish(() => rejectPromise(new GitWorkspaceError(`${executable} failed to start: ${error.message}`, "process-start-failed")));
    });
    child.once("close", (code, signal) => {
      finish(() => resolvePromise({
        exitCode: Number.isInteger(code) ? code : 1,
        signal: signal ?? null,
        stdout,
        stderr,
      }));
    });
    if (input === null) {
      child.stdin.end();
    } else {
      child.stdin.end(input);
    }
  });
}

export async function runGit(args, options = {}) {
  const result = await runProcess("git", args, options);
  if (result.exitCode !== 0 && options.allowFailure !== true) {
    const detail = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim();
    throw new GitWorkspaceError(
      `git ${args[0]} failed${detail ? `: ${detail}` : "."}`,
      "git-command-failed",
      { args: [...args], exitCode: result.exitCode },
    );
  }
  return {
    ...result,
    stdoutText: result.stdout.toString("utf8"),
    stderrText: result.stderr.toString("utf8"),
  };
}

export async function inspectGitRepository(cwd, options = {}) {
  const repository = (await runGit(["rev-parse", "--show-toplevel"], { ...options, cwd })).stdoutText.trim();
  const headResult = await runGit(["rev-parse", "--verify", "HEAD"], {
    ...options,
    cwd: repository,
    allowFailure: true,
  });
  if (headResult.exitCode !== 0) {
    throw new GitWorkspaceError("Workspace-write execution requires a repository with an initial commit.", "unborn-repository");
  }
  const head = headResult.stdoutText.trim().toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) {
    throw new GitWorkspaceError("Git returned an invalid HEAD object id.", "invalid-git-state");
  }
  return { repository: resolve(repository), head };
}

export function parsePorcelainV2(buffer) {
  const fields = buffer.toString("utf8").split("\0");
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length === 0) {
      continue;
    }
    if (field.startsWith("? ")) {
      entries.push({ kind: "untracked", xy: "??", path: normalizeRepositoryPath(field.slice(2)), original_path: null });
      continue;
    }
    if (field.startsWith("! ")) {
      continue;
    }
    const parts = field.split(" ");
    if (parts[0] === "1") {
      entries.push({
        kind: "ordinary",
        xy: parts[1],
        path: normalizeRepositoryPath(parts.slice(8).join(" ")),
        original_path: null,
      });
      continue;
    }
    if (parts[0] === "2") {
      const originalPath = fields[index + 1];
      index += 1;
      entries.push({
        kind: "rename",
        xy: parts[1],
        path: normalizeRepositoryPath(parts.slice(9).join(" ")),
        original_path: normalizeRepositoryPath(originalPath),
      });
      continue;
    }
    if (parts[0] === "u") {
      entries.push({
        kind: "unmerged",
        xy: parts[1],
        path: normalizeRepositoryPath(parts.slice(10).join(" ")),
        original_path: null,
      });
      continue;
    }
    throw new GitWorkspaceError(`Unsupported Git status record: ${field}`, "invalid-git-state");
  }
  return entries;
}

export async function readWorkspaceStatus(cwd, options = {}) {
  const result = await runGit(
    ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    { ...options, cwd },
  );
  return parsePorcelainV2(result.stdout);
}

export function changedPaths(entries) {
  return [...new Set(entries.flatMap((entry) => [entry.original_path, entry.path]).filter(Boolean))].sort();
}

function pathsOverlapScope(paths, roots, platform = process.platform) {
  return paths.filter((path) => pathWithinRoots(path, roots, [], platform));
}

export async function assertMainCheckoutCompatible(repository, allowedWriteRoots, options = {}) {
  const entries = await readWorkspaceStatus(repository, options);
  const paths = changedPaths(entries);
  const overlapping = pathsOverlapScope(paths, allowedWriteRoots, options.platform ?? process.platform);
  if (overlapping.length > 0) {
    throw new GitWorkspaceError(
      `The main checkout has local changes inside the assignment scope: ${overlapping.join(", ")}.`,
      "dirty-scope",
      { overlapping },
    );
  }
  return { excludedDirtyPaths: paths };
}

async function createDetachedWorktree(repository, revision, path, options = {}) {
  if ((await getEntry(path)) !== null) {
    throw new GitWorkspaceError(`Worktree path already exists: ${path}`, "worktree-exists");
  }
  await mkdir(dirname(path), { recursive: true });
  try {
    await runGit(["worktree", "add", "--detach", path, revision], { ...options, cwd: repository });
    const actual = (await runGit(["rev-parse", "HEAD"], { ...options, cwd: path })).stdoutText.trim().toLowerCase();
    if (actual !== revision.toLowerCase()) {
      throw new GitWorkspaceError("Created worktree does not match the requested revision.", "worktree-revision-mismatch");
    }
    return await realpath(path);
  } catch (error) {
    await runGit(["worktree", "remove", "--force", path], { ...options, cwd: repository, allowFailure: true });
    if ((await getEntry(path)) !== null) {
      await rm(path, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function createAssignmentWorktree(record, options = {}) {
  if (!record.writer || record.workspace_strategy !== "isolated-worktree") {
    throw new GitWorkspaceError("Assignment does not permit a writer worktree.", "invalid-workspace-strategy");
  }
  const repositoryInfo = await inspectGitRepository(record.repository, options);
  if (repositoryInfo.head !== record.base_revision) {
    throw new GitWorkspaceError(
      `Repository HEAD moved from assignment base ${record.base_revision} to ${repositoryInfo.head}.`,
      "base-revision-moved",
    );
  }
  const compatibility = await assertMainCheckoutCompatible(
    repositoryInfo.repository,
    record.allowed_write_roots,
    options,
  );
  const state = await getRepositoryState(record.repository, options);
  await ensureWorktreesDirectory(state);
  const path = join(state.worktreesDirectory, worktreeName(record));
  const canonicalPath = await createDetachedWorktree(
    repositoryInfo.repository,
    record.base_revision,
    path,
    options,
  );
  return {
    path: canonicalPath,
    base_revision: record.base_revision,
    detached: true,
    archived: false,
    cleaned: false,
    excluded_dirty_paths: compatibility.excludedDirtyPaths,
    created_at: new Date().toISOString(),
  };
}

export async function createCandidateReviewWorktree(record, options = {}) {
  if (record.candidate === null) {
    throw new GitWorkspaceError("Candidate review requires a published candidate.", "candidate-not-found");
  }
  const state = await getRepositoryState(record.repository, options);
  await ensureWorktreesDirectory(state);
  const path = join(
    state.worktreesDirectory,
    "reviews",
    `${worktreeName(record, "review")}-${randomUUID().replaceAll("-", "").slice(0, 8)}`,
  );
  const canonicalPath = await createDetachedWorktree(
    record.repository,
    record.candidate.candidate_revision,
    path,
    options,
  );
  return {
    path: canonicalPath,
    candidate_id: record.candidate.candidate_id,
    candidate_revision: record.candidate.candidate_revision,
    detached: true,
    temporary: true,
  };
}

function normalizedPath(value, platform = process.platform) {
  const normalized = normalizeRepositoryPath(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizedSet(values, platform = process.platform) {
  return new Set(values.map((value) => normalizedPath(value, platform)));
}

async function pathGitMode(cwd, revision, path, options = {}) {
  const result = await runGit(["ls-tree", revision, "--", path], {
    ...options,
    cwd,
    allowFailure: true,
  });
  if (result.exitCode !== 0 || result.stdoutText.trim().length === 0) {
    return null;
  }
  return result.stdoutText.trim().split(/\s+/)[0] ?? null;
}

async function validateChangedPath(record, workspacePath, path, options = {}) {
  if (!pathWithinRoots(
    path,
    record.allowed_write_roots,
    record.forbidden_write_roots,
    options.platform ?? process.platform,
  )) {
    throw new GitWorkspaceError(`Changed path is outside the assignment contract: ${path}`, "write-scope-violation");
  }
  const absolutePath = resolveContainedPath(workspacePath, path);
  const entry = await getEntry(absolutePath);
  const currentMode = entry?.isSymbolicLink() === true ? "120000" : null;
  const baseMode = await pathGitMode(workspacePath, record.base_revision, path, options);
  if (!record.allow_symlinks && (currentMode === "120000" || baseMode === "120000")) {
    throw new GitWorkspaceError(`Symlink changes require explicit capability: ${path}`, "symlink-violation");
  }
  if (!record.allow_submodules && baseMode === "160000") {
    throw new GitWorkspaceError(`Submodule changes require explicit capability: ${path}`, "submodule-violation");
  }
}

export async function runRequiredChecks(record, workspacePath, options = {}) {
  const results = [];
  for (const check of record.required_checks) {
    const cwd = resolveContainedPath(workspacePath, check.cwd);
    const result = await runProcess(check.argv[0], check.argv.slice(1), {
      ...options,
      cwd,
      timeoutMs: check.timeout_seconds * 1000,
    });
    const evidence = {
      id: check.id,
      argv: [...check.argv],
      cwd: check.cwd,
      exit_code: result.exitCode,
      stdout_sha256: sha256(result.stdout),
      stderr_sha256: sha256(result.stderr),
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    };
    results.push(evidence);
    if (result.exitCode !== 0) {
      throw new GitWorkspaceError(`Required check failed: ${check.id}`, "required-check-failed", { checks: results });
    }
  }
  return results;
}

async function collectArtifactEntries(root, current = root, prefix = "") {
  const entries = [];
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolutePath = join(current, entry.name);
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new GitWorkspaceError(`Artifact contains a symlink: ${relativePath}`, "artifact-symlink");
    }
    if (entry.isDirectory()) {
      entries.push(...await collectArtifactEntries(root, absolutePath, relativePath));
    } else if (entry.isFile()) {
      const content = await readFile(absolutePath);
      entries.push({ path: relativePath, size: content.length, sha256: sha256(content) });
    } else {
      throw new GitWorkspaceError(`Artifact contains an unsupported entry: ${relativePath}`, "artifact-entry");
    }
  }
  return entries;
}

async function inspectArtifact(workspacePath, specification) {
  const sourcePath = resolveContainedPath(workspacePath, specification.path);
  const entry = await lstat(sourcePath).catch((error) => {
    if (error.code === "ENOENT") {
      throw new GitWorkspaceError(`Declared artifact is missing: ${specification.path}`, "artifact-missing");
    }
    throw error;
  });
  if (entry.isSymbolicLink()) {
    throw new GitWorkspaceError(`Declared artifact is a symlink: ${specification.path}`, "artifact-symlink");
  }
  const canonicalRoot = await realpath(workspacePath);
  const canonicalSource = await realpath(sourcePath);
  const canonicalRelative = relative(canonicalRoot, canonicalSource);
  if (
    isAbsolute(canonicalRelative) ||
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new GitWorkspaceError(`Declared artifact escapes through a symlink: ${specification.path}`, "artifact-symlink");
  }
  if (specification.kind === "file" && !entry.isFile()) {
    throw new GitWorkspaceError(`Declared file artifact is not a file: ${specification.path}`, "artifact-kind");
  }
  if (specification.kind === "directory" && !entry.isDirectory()) {
    throw new GitWorkspaceError(`Declared directory artifact is not a directory: ${specification.path}`, "artifact-kind");
  }
  if (entry.isFile()) {
    const content = await readFile(sourcePath);
    return {
      specification,
      sourcePath,
      manifest: {
        name: specification.name,
        path: specification.path,
        kind: "file",
        size: content.length,
        sha256: sha256(content),
      },
    };
  }
  const entries = await collectArtifactEntries(sourcePath);
  return {
    specification,
    sourcePath,
    manifest: {
      name: specification.name,
      path: specification.path,
      kind: "directory",
      entries,
      sha256: sha256(canonicalJson(entries)),
    },
  };
}

async function persistArtifacts(record, workspacePath, candidateId, inspected, options = {}) {
  if (inspected.length === 0) {
    return [];
  }
  const state = await getRepositoryState(record.repository, options);
  const destination = join(state.artifactsDirectory, candidateId);
  if ((await getEntry(destination)) !== null) {
    throw new GitWorkspaceError(`Artifact destination already exists: ${candidateId}`, "artifact-exists");
  }
  await mkdir(destination, { recursive: true });
  try {
    for (const artifact of inspected) {
      await cp(artifact.sourcePath, join(destination, artifact.specification.name), {
        recursive: artifact.specification.kind === "directory",
        dereference: false,
        errorOnExist: true,
        force: false,
      });
    }
    return inspected.map((artifact) => ({
      ...artifact.manifest,
      stored_path: join(destination, artifact.specification.name),
    }));
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export async function createCandidate(record, workspacePath, {
  reportedChangedFiles = [],
  checkResults = [],
  environment = process.env,
  ...options
} = {}) {
  const actualHead = (await runGit(["rev-parse", "HEAD"], { ...options, cwd: workspacePath })).stdoutText.trim().toLowerCase();
  if (actualHead !== record.base_revision) {
    throw new GitWorkspaceError("Executor changed worktree HEAD or created a commit.", "executor-commit-violation");
  }
  const status = await readWorkspaceStatus(workspacePath, options);
  if (status.some((entry) => entry.kind === "unmerged")) {
    throw new GitWorkspaceError("Executor left unmerged Git entries.", "unmerged-worktree");
  }
  const paths = changedPaths(status);
  for (const path of paths) {
    await validateChangedPath(record, workspacePath, path, options);
  }
  const reported = normalizedSet(reportedChangedFiles, options.platform ?? process.platform);
  const actual = normalizedSet(paths, options.platform ?? process.platform);
  if (reported.size !== actual.size || [...reported].some((path) => !actual.has(path))) {
    throw new GitWorkspaceError(
      "Executor changed_files does not match the Git worktree.",
      "changed-files-mismatch",
      { actual: paths, reported: [...reportedChangedFiles] },
    );
  }
  if (paths.length === 0) {
    return { candidate: null, changedFiles: [], artifacts: [], checkResults };
  }
  const state = await getRepositoryState(record.repository, options);
  await ensureWorktreesDirectory(state);
  const temporaryIndex = join(
    state.worktreesDirectory,
    `.index-${record.assignment_id.replaceAll("-", "").slice(0, 12)}-${record.attempt}-${randomUUID().replaceAll("-", "").slice(0, 8)}`,
  );
  const gitEnvironment = { ...environment, GIT_INDEX_FILE: temporaryIndex };
  let candidateRevision;
  try {
    await runGit(["read-tree", record.base_revision], { ...options, cwd: workspacePath, environment: gitEnvironment });
    await runGit(["add", "-A", "--", "."], { ...options, cwd: workspacePath, environment: gitEnvironment });
    const tree = (await runGit(["write-tree"], { ...options, cwd: workspacePath, environment: gitEnvironment })).stdoutText.trim();
    for (const path of paths) {
      const candidateMode = await pathGitMode(workspacePath, tree, path, options);
      if (!record.allow_symlinks && candidateMode === "120000") {
        throw new GitWorkspaceError(`Symlink changes require explicit capability: ${path}`, "symlink-violation");
      }
      if (!record.allow_submodules && candidateMode === "160000") {
        throw new GitWorkspaceError(`Submodule changes require explicit capability: ${path}`, "submodule-violation");
      }
    }
    const baseTree = (await runGit(["rev-parse", `${record.base_revision}^{tree}`], { ...options, cwd: workspacePath })).stdoutText.trim();
    if (tree === baseTree) {
      return { candidate: null, changedFiles: [], artifacts: [], checkResults };
    }
    const identityEnvironment = {
      ...gitEnvironment,
      GIT_AUTHOR_NAME: "Codex Orchestration",
      GIT_AUTHOR_EMAIL: "codex-orchestration@localhost",
      GIT_COMMITTER_NAME: "Codex Orchestration",
      GIT_COMMITTER_EMAIL: "codex-orchestration@localhost",
      GIT_AUTHOR_DATE: record.created_at,
      GIT_COMMITTER_DATE: record.created_at,
    };
    candidateRevision = (
      await runGit(["commit-tree", tree, "-p", record.base_revision], {
        ...options,
        cwd: workspacePath,
        environment: identityEnvironment,
        input: `Codex candidate ${record.assignment_id} attempt ${record.attempt}\n`,
      })
    ).stdoutText.trim().toLowerCase();
    const ref = `refs/codex-orchestration/candidates/${record.assignment_id}/${record.attempt}`;
    const refUpdate = await runGit(
      ["update-ref", ref, candidateRevision, "0".repeat(candidateRevision.length)],
      { ...options, cwd: record.repository, allowFailure: true },
    );
    if (refUpdate.exitCode !== 0) {
      const existing = await runGit(["rev-parse", "--verify", ref], {
        ...options,
        cwd: record.repository,
        allowFailure: true,
      });
      if (existing.exitCode !== 0 || existing.stdoutText.trim().toLowerCase() !== candidateRevision) {
        throw new GitWorkspaceError("Candidate ref already belongs to different content.", "candidate-ref-exists");
      }
    }
    const patch = await runGit(
      ["diff", "--binary", "--full-index", record.base_revision, candidateRevision],
      { ...options, cwd: record.repository },
    );
    const inspectedArtifacts = [];
    for (const artifact of record.artifacts) {
      inspectedArtifacts.push(await inspectArtifact(workspacePath, artifact));
    }
    const artifactDigest = sha256(canonicalJson(inspectedArtifacts.map((item) => item.manifest)));
    const contractDigest = sha256(canonicalJson({
      allowed_write_roots: record.allowed_write_roots,
      forbidden_write_roots: record.forbidden_write_roots,
      required_checks: record.required_checks,
      artifacts: record.artifacts,
      review_policy: record.review_policy,
      operator_approval_required: record.operator_approval_required,
      allow_symlinks: record.allow_symlinks,
      allow_submodules: record.allow_submodules,
      delivery: {
        mode: record.delivery.mode,
        commit_message: record.delivery.commit_message,
        remote: record.delivery.remote,
        branch: record.delivery.branch,
      },
    }));
    const diffDigest = sha256(patch.stdout);
    const candidateId = sha256(canonicalJson({
      repository_key: record.repository_key,
      assignment_id: record.assignment_id,
      attempt: record.attempt,
      base_revision: record.base_revision,
      candidate_revision: candidateRevision,
      diff_sha256: diffDigest,
      contract_sha256: contractDigest,
      artifact_manifest_sha256: artifactDigest,
    }));
    const artifacts = await persistArtifacts(record, workspacePath, candidateId, inspectedArtifacts, options);
    return {
      changedFiles: paths,
      artifacts,
      checkResults,
      candidate: {
        candidate_id: candidateId,
        candidate_revision: candidateRevision,
        candidate_ref: ref,
        base_revision: record.base_revision,
        diff_sha256: diffDigest,
        contract_sha256: contractDigest,
        artifact_manifest_sha256: artifactDigest,
        verification_sha256: sha256(canonicalJson(checkResults)),
        changed_paths: paths,
        artifacts,
        created_at: new Date().toISOString(),
      },
    };
  } finally {
    await rm(temporaryIndex, { force: true });
  }
}

export async function integrateCandidate(record, targetCwd, options = {}) {
  if (record.candidate === null) {
    throw new GitWorkspaceError("Assignment does not have a candidate.", "candidate-not-found");
  }
  const target = await inspectGitRepository(targetCwd, options);
  if (resolve(target.repository) !== resolve(record.repository)) {
    throw new GitWorkspaceError("Integration target belongs to another repository.", "repository-mismatch");
  }
  const targetStatus = await readWorkspaceStatus(target.repository, options);
  const dirty = changedPaths(targetStatus).filter((path) =>
    record.candidate.changed_paths.some((candidatePath) =>
      normalizeRepositoryPath(path) === normalizeRepositoryPath(candidatePath)
    )
  );
  if (dirty.length > 0) {
    const alreadyApplied = await runGit(
      ["diff", "--quiet", record.candidate.candidate_revision, "--", ...record.candidate.changed_paths],
      { ...options, cwd: target.repository, allowFailure: true },
    );
    const alreadyStaged = await runGit(["diff", "--cached", "--quiet", "--", ...record.candidate.changed_paths], {
      ...options,
      cwd: target.repository,
      allowFailure: true,
    });
    if (alreadyApplied.exitCode === 0 && alreadyStaged.exitCode === 0) {
      return {
        candidate_id: record.candidate.candidate_id,
        target_revision_before: target.head,
        applied_diff_sha256: record.candidate.diff_sha256,
        idempotent: true,
      };
    }
    throw new GitWorkspaceError(
      `Integration paths have local changes: ${dirty.join(", ")}.`,
      "integration-dirty-path",
      { dirty },
    );
  }
  for (const path of record.candidate.changed_paths) {
    const changed = await runGit(
      ["diff", "--quiet", record.base_revision, target.head, "--", path],
      { ...options, cwd: target.repository, allowFailure: true },
    );
    if (![0, 1].includes(changed.exitCode)) {
      throw new GitWorkspaceError(`Unable to compare integration path: ${path}`, "integration-compare-failed");
    }
    if (changed.exitCode === 1) {
      throw new GitWorkspaceError(`Integration path changed since assignment base: ${path}`, "integration-stale-path");
    }
  }
  const patch = await runGit(
    ["diff", "--binary", "--full-index", record.base_revision, record.candidate.candidate_revision],
    { ...options, cwd: target.repository },
  );
  const patchDigest = sha256(patch.stdout);
  if (patchDigest !== record.candidate.diff_sha256) {
    throw new GitWorkspaceError("Candidate diff no longer matches its identity.", "candidate-integrity-failed");
  }
  await runGit(["apply", "--check", "--binary", "-"], {
    ...options,
    cwd: target.repository,
    input: patch.stdout,
  });
  await runGit(["apply", "--binary", "-"], {
    ...options,
    cwd: target.repository,
    input: patch.stdout,
  });
  const staged = await runGit(["diff", "--cached", "--quiet", "--", ...record.candidate.changed_paths], {
    ...options,
    cwd: target.repository,
    allowFailure: true,
  });
  if (staged.exitCode !== 0) {
    throw new GitWorkspaceError("Candidate integration unexpectedly staged changes.", "integration-staged");
  }
  return {
    candidate_id: record.candidate.candidate_id,
    target_revision_before: target.head,
    applied_diff_sha256: patchDigest,
  };
}

function deliveryPublicationRef(record) {
  return `refs/codex-orchestration/deliveries/${record.assignment_id}/${record.attempt}`;
}

function normalizedPathsEqual(first, second, platform = process.platform) {
  const left = normalizedSet(first, platform);
  const right = normalizedSet(second, platform);
  return left.size === right.size && [...left].every((path) => right.has(path));
}

function parseNullSeparatedPaths(buffer) {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0)
    .map(normalizeRepositoryPath)
    .sort();
}

async function currentBranchRef(repository, options) {
  const result = await runGit(["symbolic-ref", "-q", "HEAD"], {
    ...options,
    cwd: repository,
    allowFailure: true,
  });
  const branchRef = result.stdoutText.trim();
  if (result.exitCode !== 0 || !branchRef.startsWith("refs/heads/")) {
    throw new GitWorkspaceError("Automatic delivery requires a checked-out local branch.", "delivery-detached-head");
  }
  const valid = await runGit(["check-ref-format", branchRef], {
    ...options,
    cwd: repository,
    allowFailure: true,
  });
  if (valid.exitCode !== 0) {
    throw new GitWorkspaceError("Automatic delivery branch is invalid.", "delivery-branch-invalid");
  }
  return branchRef;
}

async function assertConfiguredPushDestination(record, repository, branchRef, options) {
  if (record.delivery.mode !== "push") {
    return;
  }
  if (branchRef !== `refs/heads/${record.delivery.branch}`) {
    throw new GitWorkspaceError(
      `Checked-out branch does not match delivery branch ${record.delivery.branch}.`,
      "delivery-branch-mismatch",
    );
  }
  const environment = {
    ...(options.environment ?? process.env),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
  const configured = await runGit(["remote", "get-url", "--push", record.delivery.remote], {
    ...options,
    cwd: repository,
    environment,
    allowFailure: true,
  });
  if (configured.exitCode !== 0 || configured.stdoutText.trim().length === 0) {
    throw new GitWorkspaceError("Automatic delivery remote is not configured for push.", "delivery-remote-invalid");
  }
}

async function inspectPublicationCommit(record, revision, branchRef, options) {
  const repository = record.repository;
  const type = await runGit(["cat-file", "-t", revision], {
    ...options,
    cwd: repository,
    allowFailure: true,
  });
  if (type.exitCode !== 0 || type.stdoutText.trim() !== "commit") {
    throw new GitWorkspaceError("Delivery publication ref is not a commit.", "publication-ref-invalid");
  }
  const message = (await runGit(["show", "-s", "--format=%B", revision], {
    ...options,
    cwd: repository,
  })).stdoutText.split(/\r?\n/);
  if (
    !message.includes(`Codex-Assignment-ID: ${record.assignment_id}`) ||
    !message.includes(`Codex-Candidate-ID: ${record.candidate.candidate_id}`)
  ) {
    throw new GitWorkspaceError("Delivery commit does not belong to this candidate.", "publication-ref-invalid");
  }
  const parentRevision = (await runGit(["rev-parse", `${revision}^`], {
    ...options,
    cwd: repository,
  })).stdoutText.trim().toLowerCase();
  const paths = parseNullSeparatedPaths((await runGit(
    ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", parentRevision, revision],
    { ...options, cwd: repository },
  )).stdout);
  if (!normalizedPathsEqual(paths, record.candidate.changed_paths, options.platform ?? process.platform)) {
    throw new GitWorkspaceError("Delivery commit contains paths outside the candidate.", "publication-ref-invalid");
  }
  const content = await runGit(
    ["diff", "--quiet", record.candidate.candidate_revision, revision, "--", ...record.candidate.changed_paths],
    { ...options, cwd: repository, allowFailure: true },
  );
  if (content.exitCode !== 0) {
    throw new GitWorkspaceError("Delivery commit content differs from the candidate.", "publication-ref-invalid");
  }
  return {
    candidate_id: record.candidate.candidate_id,
    commit_revision: revision,
    parent_revision: parentRevision,
    branch_ref: branchRef,
    publication_ref: deliveryPublicationRef(record),
  };
}

async function synchronizeDeliveryIndex(record, revision, repository, options) {
  await runGit(["reset", "--mixed", revision, "--", ...record.candidate.changed_paths], {
    ...options,
    cwd: repository,
  });
  const cached = await runGit(["diff", "--cached", "--quiet", "--", ...record.candidate.changed_paths], {
    ...options,
    cwd: repository,
    allowFailure: true,
  });
  const working = await runGit(["diff", "--quiet", "--", ...record.candidate.changed_paths], {
    ...options,
    cwd: repository,
    allowFailure: true,
  });
  if (cached.exitCode !== 0 || working.exitCode !== 0) {
    throw new GitWorkspaceError("Delivery commit could not synchronize the candidate paths.", "delivery-index-sync-failed");
  }
}

export async function commitIntegratedCandidate(record, targetCwd, options = {}) {
  if (record.candidate === null || record.integration === null || !new Set(["commit", "push"]).has(record.delivery?.mode)) {
    throw new GitWorkspaceError("Assignment is not ready for automatic commit delivery.", "delivery-not-ready");
  }
  const target = await inspectGitRepository(targetCwd, options);
  if (resolve(target.repository) !== resolve(record.repository)) {
    throw new GitWorkspaceError("Commit target belongs to another repository.", "repository-mismatch");
  }
  const branchRef = await currentBranchRef(target.repository, options);
  await assertConfiguredPushDestination(record, target.repository, branchRef, options);
  const publicationRef = deliveryPublicationRef(record);
  const existing = await runGit(["rev-parse", "--verify", publicationRef], {
    ...options,
    cwd: target.repository,
    allowFailure: true,
  });
  if (existing.exitCode === 0) {
    const revision = existing.stdoutText.trim().toLowerCase();
    const evidence = await inspectPublicationCommit(record, revision, branchRef, options);
    const branchRevision = (await runGit(["rev-parse", branchRef], {
      ...options,
      cwd: target.repository,
    })).stdoutText.trim().toLowerCase();
    if (branchRevision === revision) {
      await synchronizeDeliveryIndex(record, revision, target.repository, options);
    } else {
      const ancestor = await runGit(["merge-base", "--is-ancestor", revision, branchRevision], {
        ...options,
        cwd: target.repository,
        allowFailure: true,
      });
      if (ancestor.exitCode !== 0) {
        throw new GitWorkspaceError("Delivery branch diverged from the recorded commit.", "publication-branch-diverged");
      }
    }
    return { ...evidence, idempotent: true };
  }
  const candidatePaths = record.candidate.changed_paths;
  const staged = await runGit(["diff", "--cached", "--quiet", "--", ...candidatePaths], {
    ...options,
    cwd: target.repository,
    allowFailure: true,
  });
  if (staged.exitCode !== 0) {
    throw new GitWorkspaceError("Candidate paths contain staged changes before delivery.", "delivery-index-dirty");
  }
  for (const path of candidatePaths) {
    const changed = await runGit(["diff", "--quiet", record.base_revision, target.head, "--", path], {
      ...options,
      cwd: target.repository,
      allowFailure: true,
    });
    if (changed.exitCode !== 0) {
      throw new GitWorkspaceError(`Delivery path changed in HEAD after assignment base: ${path}`, "delivery-stale-path");
    }
  }
  const patch = await runGit(
    ["diff", "--binary", "--full-index", record.base_revision, record.candidate.candidate_revision],
    { ...options, cwd: target.repository },
  );
  if (sha256(patch.stdout) !== record.candidate.diff_sha256) {
    throw new GitWorkspaceError("Candidate diff failed delivery integrity validation.", "candidate-integrity-failed");
  }
  const state = await getRepositoryState(record.repository, options);
  await ensureWorktreesDirectory(state);
  const temporaryIndex = join(
    state.worktreesDirectory,
    `.delivery-index-${record.assignment_id.replaceAll("-", "").slice(0, 12)}-${record.attempt}-${randomUUID().replaceAll("-", "").slice(0, 8)}`,
  );
  const environment = { ...(options.environment ?? process.env), GIT_INDEX_FILE: temporaryIndex };
  try {
    await runGit(["read-tree", record.candidate.candidate_revision], {
      ...options,
      cwd: target.repository,
      environment,
    });
    const candidateTrackedPaths = parseNullSeparatedPaths((await runGit(
      ["ls-files", "-z", "--", ...candidatePaths],
      { ...options, cwd: target.repository, environment },
    )).stdout);
    const trackedPathSet = normalizedSet(candidateTrackedPaths, options.platform ?? process.platform);
    const unexpectedPaths = [];
    for (const path of candidatePaths) {
      if (
        !trackedPathSet.has(normalizedPath(path, options.platform ?? process.platform)) &&
        (await getEntry(resolveContainedPath(target.repository, path))) !== null
      ) {
        unexpectedPaths.push(path);
      }
    }
    const capture = candidateTrackedPaths.length === 0
      ? { exitCode: 0 }
      : await runGit(["add", "-A", "--", ...candidateTrackedPaths], {
          ...options,
          cwd: target.repository,
          environment,
          allowFailure: true,
        });
    const expectedCandidateTree = (await runGit(
      ["rev-parse", `${record.candidate.candidate_revision}^{tree}`],
      { ...options, cwd: target.repository },
    )).stdoutText.trim().toLowerCase();
    const capturedCandidateTree = capture.exitCode === 0
      ? (await runGit(["write-tree"], {
          ...options,
          cwd: target.repository,
          environment,
        })).stdoutText.trim().toLowerCase()
      : null;
    if (unexpectedPaths.length > 0 || capturedCandidateTree !== expectedCandidateTree) {
      throw new GitWorkspaceError(
        "Integrated candidate paths changed before delivery.",
        "delivery-path-dirty",
        {
          capture_failed: capture.exitCode !== 0,
          tree_mismatch: capturedCandidateTree !== expectedCandidateTree,
          unexpected_paths: unexpectedPaths,
        },
      );
    }
    await runGit(["read-tree", target.head], { ...options, cwd: target.repository, environment });
    await runGit(["apply", "--cached", "--binary", "-"], {
      ...options,
      cwd: target.repository,
      environment,
      input: patch.stdout,
    });
    const tree = (await runGit(["write-tree"], {
      ...options,
      cwd: target.repository,
      environment,
    })).stdoutText.trim().toLowerCase();
    const committedPaths = parseNullSeparatedPaths((await runGit(
      ["diff", "--name-only", "-z", target.head, tree],
      { ...options, cwd: target.repository },
    )).stdout);
    if (!normalizedPathsEqual(committedPaths, candidatePaths, options.platform ?? process.platform)) {
      throw new GitWorkspaceError("Automatic commit tree differs from the candidate path set.", "delivery-tree-mismatch");
    }
    const commitMessage = [
      record.delivery.commit_message,
      "",
      `Codex-Assignment-ID: ${record.assignment_id}`,
      `Codex-Candidate-ID: ${record.candidate.candidate_id}`,
      "",
    ].join("\n");
    const commitRevision = (await runGit(["commit-tree", tree, "-p", target.head], {
      ...options,
      cwd: target.repository,
      environment,
      input: commitMessage,
    })).stdoutText.trim().toLowerCase();
    const refUpdate = await runGit(
      ["update-ref", publicationRef, commitRevision, "0".repeat(commitRevision.length)],
      { ...options, cwd: target.repository, allowFailure: true },
    );
    if (refUpdate.exitCode !== 0) {
      throw new GitWorkspaceError("Delivery publication ref already exists.", "publication-ref-exists");
    }
    const branchUpdate = await runGit(["update-ref", branchRef, commitRevision, target.head], {
      ...options,
      cwd: target.repository,
      allowFailure: true,
    });
    if (branchUpdate.exitCode !== 0) {
      throw new GitWorkspaceError("Delivery branch moved while the commit was being published.", "publication-branch-diverged");
    }
    await synchronizeDeliveryIndex(record, commitRevision, target.repository, options);
    return inspectPublicationCommit(record, commitRevision, branchRef, options);
  } finally {
    await rm(temporaryIndex, { force: true });
  }
}

async function remoteBranchRevision(remote, remoteRef, repository, options) {
  const environment = {
    ...(options.environment ?? process.env),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
  const result = await runGit(["ls-remote", "--refs", remote, remoteRef], {
    ...options,
    cwd: repository,
    environment,
  });
  const lines = result.stdoutText.trim().split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length !== 1) {
    throw new GitWorkspaceError("Automatic push requires one existing remote branch.", "remote-branch-missing");
  }
  const [revision, ref] = lines[0].split(/\s+/);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(revision) || ref !== remoteRef) {
    throw new GitWorkspaceError("Remote branch returned an invalid revision.", "remote-branch-invalid");
  }
  return revision.toLowerCase();
}

async function fetchRemoteRevision(remote, remoteRef, repository, options) {
  const environment = {
    ...(options.environment ?? process.env),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
  await runGit(["fetch", "--no-tags", "--quiet", remote, remoteRef], {
    ...options,
    cwd: repository,
    environment,
  });
  return (await runGit(["rev-parse", "FETCH_HEAD"], {
    ...options,
    cwd: repository,
  })).stdoutText.trim().toLowerCase();
}

export async function pushCommittedCandidate(record, targetCwd, options = {}) {
  if (record.delivery?.mode !== "push" || record.delivery.commit === null || record.candidate === null) {
    throw new GitWorkspaceError("Assignment is not ready for automatic push delivery.", "delivery-not-ready");
  }
  const target = await inspectGitRepository(targetCwd, options);
  if (resolve(target.repository) !== resolve(record.repository)) {
    throw new GitWorkspaceError("Push target belongs to another repository.", "repository-mismatch");
  }
  const branchRef = await currentBranchRef(target.repository, options);
  await assertConfiguredPushDestination(record, target.repository, branchRef, options);
  const commitRevision = record.delivery.commit.commit_revision;
  const localContains = await runGit(["merge-base", "--is-ancestor", commitRevision, target.head], {
    ...options,
    cwd: target.repository,
    allowFailure: true,
  });
  if (localContains.exitCode !== 0) {
    throw new GitWorkspaceError("Delivery commit is not reachable from the checked-out branch.", "delivery-commit-unreachable");
  }
  const remoteRef = `refs/heads/${record.delivery.branch}`;
  let remoteBefore = await remoteBranchRevision(
    record.delivery.remote,
    remoteRef,
    target.repository,
    options,
  );
  if (remoteBefore === commitRevision) {
    return {
      candidate_id: record.candidate.candidate_id,
      commit_revision: commitRevision,
      remote: record.delivery.remote,
      branch: record.delivery.branch,
      remote_ref: remoteRef,
      remote_revision_before: remoteBefore,
      remote_revision_after: remoteBefore,
      idempotent: true,
    };
  }
  remoteBefore = await fetchRemoteRevision(
    record.delivery.remote,
    remoteRef,
    target.repository,
    options,
  );
  const alreadyPublished = await runGit(["merge-base", "--is-ancestor", commitRevision, remoteBefore], {
    ...options,
    cwd: target.repository,
    allowFailure: true,
  });
  if (alreadyPublished.exitCode === 0) {
    return {
      candidate_id: record.candidate.candidate_id,
      commit_revision: commitRevision,
      remote: record.delivery.remote,
      branch: record.delivery.branch,
      remote_ref: remoteRef,
      remote_revision_before: remoteBefore,
      remote_revision_after: remoteBefore,
      idempotent: true,
    };
  }
  const parentPublished = await runGit(
    ["merge-base", "--is-ancestor", record.delivery.commit.parent_revision, remoteBefore],
    {
      ...options,
      cwd: target.repository,
      allowFailure: true,
    },
  );
  if (parentPublished.exitCode !== 0) {
    throw new GitWorkspaceError(
      "Remote branch does not contain the delivery commit parent.",
      "push-parent-not-published",
    );
  }
  const fastForward = await runGit(["merge-base", "--is-ancestor", remoteBefore, commitRevision], {
    ...options,
    cwd: target.repository,
    allowFailure: true,
  });
  if (fastForward.exitCode !== 0) {
    throw new GitWorkspaceError("Remote branch diverged from the delivery commit.", "push-non-fast-forward");
  }
  const environment = {
    ...(options.environment ?? process.env),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
  await runGit(
    ["push", "--porcelain", record.delivery.remote, `${commitRevision}:${remoteRef}`],
    { ...options, cwd: target.repository, environment },
  );
  const remoteAfter = await remoteBranchRevision(
    record.delivery.remote,
    remoteRef,
    target.repository,
    options,
  );
  if (remoteAfter !== commitRevision) {
    const fetchedAfter = await fetchRemoteRevision(
      record.delivery.remote,
      remoteRef,
      target.repository,
      options,
    );
    const contains = await runGit(["merge-base", "--is-ancestor", commitRevision, fetchedAfter], {
      ...options,
      cwd: target.repository,
      allowFailure: true,
    });
    if (contains.exitCode !== 0) {
      throw new GitWorkspaceError("Remote branch does not contain the delivery commit.", "push-verification-failed");
    }
  }
  return {
    candidate_id: record.candidate.candidate_id,
    commit_revision: commitRevision,
    remote: record.delivery.remote,
    branch: record.delivery.branch,
    remote_ref: remoteRef,
    remote_revision_before: remoteBefore,
    remote_revision_after: remoteAfter,
  };
}

function assertControlledWorktreePath(state, path) {
  const root = resolve(state.worktreesDirectory);
  const target = resolve(path);
  const relativePath = relative(root, target);
  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new GitWorkspaceError(`Refusing unmanaged worktree path: ${path}`, "unmanaged-worktree");
  }
  return target;
}

export async function archiveAssignmentWorktree(record, options = {}) {
  if (typeof record.workspace?.path !== "string" || record.workspace.path.length === 0) {
    throw new GitWorkspaceError("Assignment does not have a worktree.", "worktree-not-found");
  }
  const state = await getRepositoryState(record.repository, options);
  await ensureWorktreesDirectory(state);
  const source = assertControlledWorktreePath(state, record.workspace.path);
  const destination = join(
    state.worktreesDirectory,
    "archive",
    worktreeName(record, "archive"),
  );
  await mkdir(dirname(destination), { recursive: true });
  await runGit(["worktree", "move", source, destination], { ...options, cwd: record.repository });
  return await realpath(destination);
}

export async function cleanupAssignmentWorktree(record, options = {}) {
  if (typeof record.workspace?.path !== "string" || record.workspace.path.length === 0) {
    return { cleaned: false, reason: "no-worktree" };
  }
  const state = await getRepositoryState(record.repository, options);
  await ensureWorktreesDirectory(state);
  const path = assertControlledWorktreePath(state, record.workspace.archive_path ?? record.workspace.path);
  await runGit(["worktree", "remove", "--force", path], {
    ...options,
    cwd: record.repository,
    allowFailure: false,
  });
  await runGit(["worktree", "prune"], { ...options, cwd: record.repository });
  return { cleaned: true, path };
}
