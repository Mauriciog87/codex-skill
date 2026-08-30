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

function normalizedSet(values, platform = process.platform) {
  return new Set(values.map((value) => {
    const normalized = normalizeRepositoryPath(value);
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  }));
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
