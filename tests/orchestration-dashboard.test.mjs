import assert from "node:assert/strict";
import test from "node:test";
import { startDashboard } from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-dashboard.mjs";

test("dashboard requires one-time authentication, CSRF, and loopback origin", async () => {
  let actionPayload = null;
  const dashboard = await startDashboard({
    cwd: "repository",
    host: "127.0.0.1",
    port: 0,
    statusProvider: async () => ({
      repository: "repository",
      assignments: [],
      planner: { mechanical: [], attention: [] },
    }),
    actionDispatcher: async (_cwd, payload) => {
      actionPayload = payload;
      return { record: { state_revision: payload.expected_state_revision + 1 } };
    },
  });
  try {
    const url = new URL(dashboard.url);
    const origin = url.origin;
    const unauthorized = await fetch(`${origin}/api/status`);
    assert.equal(unauthorized.status, 401);
    const authenticated = await fetch(dashboard.url, { redirect: "manual" });
    assert.equal(authenticated.status, 303);
    const cookie = authenticated.headers.get("set-cookie").split(";")[0];
    assert.match(cookie, /^sol_luna_session=/);
    const page = await fetch(`${origin}/`, { headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    const html = await page.text();
    const csrf = /name="csrf-token" content="([^"]+)"/.exec(html)?.[1];
    assert.ok(csrf);
    const status = await fetch(`${origin}/api/status`, { headers: { Cookie: cookie } });
    assert.equal(status.status, 200);
    const rejected = await fetch(`${origin}/api/action`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "https://attacker.invalid",
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({ expected_state_revision: 1 }),
    });
    assert.equal(rejected.status, 403);
    const accepted = await fetch(`${origin}/api/action`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({
        op: "answer_request",
        assignment_id: "assignment",
        expected_state_revision: 1,
        request_id: "request",
        answer: "answer",
      }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(actionPayload.answer, "answer");
    const replay = await fetch(dashboard.url, { redirect: "manual" });
    assert.equal(replay.status, 401);
  } finally {
    dashboard.close();
    await dashboard.closed;
  }
});

test("dashboard refuses non-loopback binds", async () => {
  await assert.rejects(
    startDashboard({ cwd: "repository", host: "0.0.0.0" }),
    /loopback/,
  );
});
