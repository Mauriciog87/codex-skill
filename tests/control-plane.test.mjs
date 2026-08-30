import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ControlPlaneError,
  assertEpochAssignmentsComplete,
  createAction,
  createAssignment,
  createReviewPublication,
  dispatchAssignmentAction,
  getControlPlaneStatus,
  listAssignments,
  normalizeRepositoryPath,
  pathWithinRoots,
  planResidualActions,
  readAssignment,
  reduceAssignment,
  rootsOverlap,
  validateAssignmentRequest,
} from "../.agents/skills/sol-luna-orchestration/scripts/control-plane.mjs";
import { acquireUltraLock } from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-state.mjs";
import { reconcileReviewAssignment } from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-control.mjs";

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "sol-luna-control-plane-"));
  const repository = join(root, "repository");
  const home = join(root, "home");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(home, { recursive: true });
  return {
    root,
    repository,
    options: {
      environment: { HOME: home, CODEX_HOME: join(home, ".codex") },
      homeDirectory: home,
      platform: process.platform,
    },
  };
}

function request(overrides = {}) {
  return {
    profile: "implement",
    base_revision: "a".repeat(40),
    priority: "normal",
    allowed_write_roots: ["src"],
    forbidden_write_roots: ["src/generated"],
    required_checks: [],
    artifacts: [],
    review_policy: "root",
    operator_approval_required: false,
    ...overrides,
  };
}

function candidate(record, suffix = "b") {
  return {
    candidate_id: suffix.repeat(64),
    candidate_revision: suffix.repeat(40),
    candidate_ref: `refs/codex-orchestration/candidates/${record.assignment_id}/${record.attempt}`,
    base_revision: record.base_revision,
    diff_sha256: "d".repeat(64),
    contract_sha256: "c".repeat(64),
    artifact_manifest_sha256: "e".repeat(64),
    verification_sha256: "f".repeat(64),
    changed_paths: ["src/value.txt"],
    artifacts: [],
  };
}

function result(status = "completed") {
  return {
    schema_version: 2,
    status,
    summary: status,
    changed_files: status === "completed" ? ["src/value.txt"] : [],
    checks: [],
    blockers: status === "completed" ? [] : [status],
    warnings: [],
  };
}

async function transition(fixture, record, op, authority, payload = {}) {
  return (
    await dispatchAssignmentAction(
      fixture.repository,
      createAction({ op, authority, record, payload }),
      fixture.options,
    )
  ).record;
}

test("path contracts normalize separators and compare concrete roots", () => {
  assert.equal(normalizeRepositoryPath("./src\\feature/"), "src/feature");
  assert.equal(rootsOverlap("src", "src/feature"), true);
  assert.equal(rootsOverlap("src/api", "src/ui"), false);
  assert.equal(pathWithinRoots("src/api/file.js", ["src"], ["src/generated"]), true);
  assert.equal(pathWithinRoots("src/generated/file.js", ["src"], ["src/generated"]), false);
  for (const invalid of ["../secret", "/absolute", "C:/absolute"] ) {
    assert.throws(() => normalizeRepositoryPath(invalid), ControlPlaneError);
  }
});

test("assignment contracts bind profile capabilities and require writer roots", () => {
  const validated = validateAssignmentRequest(request());
  assert.equal(validated.writer, true);
  assert.equal(validated.workspace_strategy, "isolated-worktree");
  assert.ok(validated.capabilities.includes("workspace-write"));
  assert.throws(
    () => validateAssignmentRequest(request({ allowed_write_roots: [] })),
    /require at least one allowed_write_root/,
  );
  assert.throws(
    () => validateAssignmentRequest(request({ profile: "explore", allowed_write_roots: ["src"] })),
    /cannot declare allowed_write_roots/,
  );
  assert.throws(
    () => validateAssignmentRequest(request({ allowed_write_root: ["src"] })),
    /unexpected properties/,
  );
});

test("root lifecycle requires claim, candidate approval, integration, and acknowledgement", async () => {
  const fixture = await createFixture();
  try {
    let record = await createAssignment({
      cwd: fixture.repository,
      request: request(),
      briefing: "Implement the bounded change.",
      ...fixture.options,
    });
    record = await transition(fixture, record, "start_assignment", "root", {
      workspace: { path: join(fixture.root, "worktree"), cleaned: false },
    });
    const publishedCandidate = candidate(record);
    record = await transition(fixture, record, "publish_result", "executor", {
      result: result(),
      candidate: publishedCandidate,
      operator_requests: [],
    });
    assert.equal(record.state, "result_ready");
    record = await transition(fixture, record, "claim_result", "root");
    record = await transition(fixture, record, "approve_candidate", "root", {
      candidate_id: publishedCandidate.candidate_id,
      kind: "root",
    });
    assert.equal(record.state, "integration_pending");
    record = await transition(fixture, record, "integrate_candidate", "root", {
      candidate_id: publishedCandidate.candidate_id,
      target_revision_before: "a".repeat(40),
      applied_diff_sha256: publishedCandidate.diff_sha256,
    });
    record = await transition(fixture, record, "acknowledge_assignment", "root");
    assert.equal(record.state, "acknowledged");
    assert.equal(record.resource_lease_active, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("independent review and operator approval remain bound to one candidate", async () => {
  const fixture = await createFixture();
  try {
    let record = await createAssignment({
      cwd: fixture.repository,
      request: request({ review_policy: "independent", operator_approval_required: true }),
      briefing: "Implement and request independent review.",
      ...fixture.options,
    });
    record = await transition(fixture, record, "start_assignment", "root", { workspace: { path: "worktree" } });
    const publishedCandidate = candidate(record);
    record = await transition(fixture, record, "publish_result", "executor", {
      result: result(),
      candidate: publishedCandidate,
      operator_requests: [],
    });
    record = await transition(fixture, record, "claim_result", "root");
    await assert.rejects(
      transition(fixture, record, "approve_candidate", "root", {
        candidate_id: publishedCandidate.candidate_id,
        kind: "root",
      }),
      /Independent review must complete/,
    );
    record = await transition(fixture, record, "request_review", "root", {
      candidate_id: publishedCandidate.candidate_id,
    });
    await assert.rejects(
      transition(fixture, record, "publish_review", "reviewer", {
        candidate_id: "0".repeat(64),
        verdict: "APPROVE",
      }),
      /current candidate/,
    );
    record = await transition(fixture, record, "publish_review", "reviewer", {
      candidate_id: publishedCandidate.candidate_id,
      verdict: "APPROVE",
      summary: "APPROVE",
      blockers: [],
      warnings: [],
      checks: [],
    });
    record = await transition(fixture, record, "approve_candidate", "root", {
      candidate_id: publishedCandidate.candidate_id,
      kind: "root",
    });
    assert.equal(record.state, "approval_pending");
    record = await transition(fixture, record, "approve_candidate", "operator", {
      candidate_id: publishedCandidate.candidate_id,
      kind: "operator",
    });
    assert.equal(record.state, "integration_pending");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("residual planning republishes a completed linked review after interruption", async () => {
  const fixture = await createFixture();
  try {
    let parent = await createAssignment({
      cwd: fixture.repository,
      request: request({ review_policy: "independent" }),
      briefing: "Parent candidate.",
      ...fixture.options,
    });
    parent = await transition(fixture, parent, "start_assignment", "root", { workspace: { path: "writer" } });
    const publishedCandidate = candidate(parent);
    parent = await transition(fixture, parent, "publish_result", "executor", {
      result: result(),
      candidate: publishedCandidate,
      operator_requests: [],
    });
    parent = await transition(fixture, parent, "claim_result", "root");
    parent = await transition(fixture, parent, "request_review", "root", {
      candidate_id: publishedCandidate.candidate_id,
    });
    let reviewer = await createAssignment({
      cwd: fixture.repository,
      request: request({
        profile: "review",
        base_revision: publishedCandidate.candidate_revision,
        allowed_write_roots: [],
        forbidden_write_roots: [],
        review_policy: "root",
        parent_assignment_id: parent.assignment_id,
        review_target_candidate_id: publishedCandidate.candidate_id,
      }),
      briefing: "Review exact candidate.",
      ...fixture.options,
    });
    reviewer = await transition(fixture, reviewer, "start_assignment", "root", {
      workspace: { path: "review", cleaned: true },
    });
    reviewer = await transition(fixture, reviewer, "publish_result", "executor", {
      result: {
        ...result(),
        assignment_id: reviewer.assignment_id,
        profile: "review",
        thread_id: "review-thread",
        routing_verified: true,
        summary: "APPROVE recovered review",
        changed_files: [],
      },
      candidate: null,
      operator_requests: [],
    });
    const publication = createReviewPublication(reviewer, parent);
    assert.equal(publication.verdict, "APPROVE");
    const plan = planResidualActions([parent, reviewer]);
    assert.equal(plan.mechanical[0].op, "publish_review_result");
    reviewer = await reconcileReviewAssignment(reviewer, fixture.options);
    parent = await readAssignment(fixture.repository, parent.assignment_id, fixture.options);
    assert.equal(parent.state, "approval_pending");
    assert.equal(parent.review.reviewer_assignment_id, reviewer.assignment_id);
    assert.equal(reviewer.state, "acknowledged");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("actions are idempotent and reject stale revisions or changed action content", async () => {
  const fixture = await createFixture();
  try {
    const record = await createAssignment({
      cwd: fixture.repository,
      request: request(),
      briefing: "Idempotency.",
      ...fixture.options,
    });
    const action = createAction({
      op: "start_assignment",
      authority: "root",
      record,
      payload: { workspace: { path: "worktree" } },
    });
    const first = await dispatchAssignmentAction(fixture.repository, action, fixture.options);
    const second = await dispatchAssignmentAction(fixture.repository, action, fixture.options);
    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    assert.equal(second.record.state_revision, 1);
    await assert.rejects(
      dispatchAssignmentAction(
        fixture.repository,
        { ...action, payload: { workspace: { path: "different" } } },
        fixture.options,
      ),
      /reused with different content/,
    );
    await assert.rejects(
      dispatchAssignmentAction(
        fixture.repository,
        createAction({ op: "publish_result", authority: "executor", record, payload: {} }),
        fixture.options,
      ),
      /Expected state revision/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("resource leases block overlapping writers and planner selects disjoint work", async () => {
  const fixture = await createFixture();
  try {
    const first = await createAssignment({
      cwd: fixture.repository,
      request: request({ allowed_write_roots: ["src/api"] }),
      briefing: "First.",
      ...fixture.options,
    });
    const second = await createAssignment({
      cwd: fixture.repository,
      request: request({ allowed_write_roots: ["src"] }),
      briefing: "Second.",
      ...fixture.options,
    });
    const third = await createAssignment({
      cwd: fixture.repository,
      request: request({ allowed_write_roots: ["tests"] }),
      briefing: "Third.",
      ...fixture.options,
    });
    const running = await transition(fixture, first, "start_assignment", "root", { workspace: { path: "one" } });
    await assert.rejects(
      transition(fixture, second, "start_assignment", "root", { workspace: { path: "two" } }),
      /overlap an active resource lease/,
    );
    const plan = planResidualActions([running, second, third]);
    assert.deepEqual(
      plan.mechanical.filter((item) => item.op === "start_assignment").map((item) => item.assignment_id),
      [third.assignment_id],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("operator requests require answer acknowledgement before retry", async () => {
  const fixture = await createFixture();
  try {
    let record = await createAssignment({
      cwd: fixture.repository,
      request: request(),
      briefing: "Request input.",
      ...fixture.options,
    });
    record = await transition(fixture, record, "start_assignment", "root", { workspace: { path: "worktree" } });
    const requestId = "request-1";
    record = await transition(fixture, record, "publish_result", "executor", {
      result: result("blocked"),
      candidate: null,
      operator_requests: [{ request_id: requestId, question: "Which option?", choices: ["A", "B"] }],
    });
    await assert.rejects(
      transition(fixture, record, "retry_assignment", "root"),
      /must be acknowledged/,
    );
    record = await transition(fixture, record, "answer_request", "operator", {
      request_id: requestId,
      answer: "A",
    });
    record = await transition(fixture, record, "acknowledge_answer", "root", { request_id: requestId });
    record = await transition(fixture, record, "archive_workspace", "root", {
      archive_path: "archived-worktree",
    });
    record = await transition(fixture, record, "retry_assignment", "root", {
      base_revision: "c".repeat(40),
    });
    assert.equal(record.state, "queued");
    assert.equal(record.attempt, 2);
    assert.equal(record.base_revision, "c".repeat(40));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("assignment contracts contain artifact destinations inside the writer scope", () => {
  assert.throws(
    () => validateAssignmentRequest(request({ artifacts: [{ name: "../escape", path: "src/output", kind: "file" }] })),
    /must be a file name/,
  );
  assert.throws(
    () => validateAssignmentRequest(request({ artifacts: [{ name: "output", path: "secrets.txt", kind: "file" }] })),
    /outside the assignment write scope/,
  );
  assert.throws(
    () => validateAssignmentRequest(request({ profile: "explore", allowed_write_roots: [], artifacts: [{ name: "output", path: "src/output", kind: "file" }] })),
    /cannot declare artifacts/,
  );
});

test("operator requests are accepted only for blocked results", async () => {
  const fixture = await createFixture();
  try {
    let record = await createAssignment({
      cwd: fixture.repository,
      request: request(),
      briefing: "Invalid operator request.",
      ...fixture.options,
    });
    record = await transition(fixture, record, "start_assignment", "root", { workspace: { path: "worktree" } });
    await assert.rejects(
      transition(fixture, record, "publish_result", "executor", {
        result: result(),
        candidate: candidate(record),
        operator_requests: [{ request_id: "request", question: "Continue?", choices: ["yes"] }],
      }),
      /require a blocked result/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("durable status omits briefing and event history redacts action payloads", async () => {
  const fixture = await createFixture();
  try {
    let record = await createAssignment({
      cwd: fixture.repository,
      request: request(),
      briefing: "secret briefing text",
      ...fixture.options,
    });
    record = await transition(fixture, record, "start_assignment", "root", {
      workspace: { path: "worktree" },
    });
    const status = await getControlPlaneStatus(fixture.repository, fixture.options);
    assert.equal(JSON.stringify(status).includes("secret briefing text"), false);
    const eventDirectory = join(record.payload_path, "..", "events");
    const eventNames = await import("node:fs/promises").then(({ readdir }) => readdir(eventDirectory));
    const event = await readFile(join(eventDirectory, eventNames.find((name) => name.includes(record.last_action_id))), "utf8");
    assert.equal(event.includes("worktree"), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Ultra release guard requires every matching assignment to be terminal", async () => {
  const fixture = await createFixture();
  try {
    const lock = await acquireUltraLock({
      cwd: fixture.repository,
      reason: "Control-plane epoch test",
      sandboxMode: "workspace-write",
      ...fixture.options,
    });
    let record = await createAssignment({
      cwd: fixture.repository,
      request: request({ lock_id: lock.lock_id, generation: lock.generation }),
      briefing: "Ultra child.",
      ...fixture.options,
    });
    const stored = await readAssignment(fixture.repository, record.assignment_id, fixture.options);
    assert.equal(stored.lock_id, lock.lock_id);
    await assert.rejects(
      assertEpochAssignmentsComplete(fixture.repository, lock.lock_id, lock.generation, fixture.options),
      /unfinished/,
    );
    const records = await listAssignments(fixture.repository, fixture.options);
    assert.equal(records.length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("normal durable assignments cannot enter a repository owned by Ultra", async () => {
  const fixture = await createFixture();
  try {
    await acquireUltraLock({
      cwd: fixture.repository,
      reason: "Exclusive assignment test",
      sandboxMode: "read-only",
      ...fixture.options,
    });
    await assert.rejects(
      createAssignment({
        cwd: fixture.repository,
        request: request(),
        briefing: "Normal assignment.",
        ...fixture.options,
      }),
      (error) => error.code === "repository-locked",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("pure reducer rejects unauthorized operations", async () => {
  const fixture = await createFixture();
  try {
    const record = await createAssignment({
      cwd: fixture.repository,
      request: request(),
      briefing: "Authority.",
      ...fixture.options,
    });
    assert.throws(
      () => reduceAssignment(
        record,
        createAction({ op: "start_assignment", authority: "operator", record }),
      ),
      /cannot perform/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
