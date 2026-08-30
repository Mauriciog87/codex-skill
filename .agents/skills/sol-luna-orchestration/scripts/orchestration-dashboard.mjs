import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createAction, dispatchAssignmentAction, getControlPlaneStatus, readAssignment } from "./control-plane.mjs";

const MAX_REQUEST_BYTES = 65_536;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

function token() {
  return randomBytes(32).toString("base64url");
}

function equalToken(first, second) {
  if (typeof first !== "string" || typeof second !== "string") {
    return false;
  }
  const left = Buffer.from(first);
  const right = Buffer.from(second);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseCookies(value) {
  return Object.fromEntries(
    String(value ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return separator < 0
          ? [part, ""]
          : [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      }),
  );
}

function send(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  response.end(body);
}

function sendJson(response, statusCode, value) {
  send(response, statusCode, `${JSON.stringify(value)}\n`, {
    "Content-Type": "application/json; charset=utf-8",
  });
}

async function readJsonBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_REQUEST_BYTES) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function dashboardHtml(csrfToken, nonce) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="csrf-token" content="${csrfToken}">
<title>Sol-Luna control plane</title>
<style nonce="${nonce}">
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#0c111b;color:#e8edf6}body{margin:0;padding:24px}main{max-width:1180px;margin:auto}h1{font-size:24px;margin:0 0 8px}.muted{color:#94a3b8}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:20px 0}.card,table{background:#151d2b;border:1px solid #293548;border-radius:12px}.card{padding:16px}.number{font-size:28px;font-weight:700}table{width:100%;border-collapse:collapse;overflow:hidden}th,td{text-align:left;padding:10px;border-bottom:1px solid #293548;font-size:13px}th{color:#9fb0c8}button{background:#4f7cff;color:white;border:0;border-radius:7px;padding:7px 10px;cursor:pointer}button.secondary{background:#30405a}.badge{display:inline-block;padding:3px 7px;border-radius:999px;background:#273650}.attention{color:#ffca6a}.error{color:#ff8080;white-space:pre-wrap}code{font-family:ui-monospace,monospace}</style>
</head>
<body>
<main>
<h1>Sol-Luna control plane</h1>
<div class="muted" id="repository"></div>
<div class="cards" id="cards"></div>
<div id="error" class="error"></div>
<table><thead><tr><th>Assignment</th><th>Profile</th><th>State</th><th>Attempt</th><th>Candidate</th><th>Delivery</th><th>Attention</th><th>Action</th></tr></thead><tbody id="assignments"></tbody></table>
</main>
<script nonce="${nonce}">
const csrf=document.querySelector('meta[name="csrf-token"]').content;
const errorNode=document.getElementById('error');
async function action(payload){const response=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(payload)});const value=await response.json();if(!response.ok)throw new Error(value.error||'Action failed');await refresh()}
function cell(text){const node=document.createElement('td');node.textContent=text??'';return node}
function button(label,handler,secondary=false){const node=document.createElement('button');node.textContent=label;if(secondary)node.className='secondary';node.addEventListener('click',handler);return node}
async function refresh(){try{const response=await fetch('/api/status',{cache:'no-store'});if(!response.ok)throw new Error('Status unavailable');const status=await response.json();document.getElementById('repository').textContent=status.repository;const counts={total:status.assignments.length,active:status.assignments.filter(x=>!['acknowledged','abandoned'].includes(x.state)).length,attention:status.planner.attention.length,candidates:status.assignments.filter(x=>x.candidate_id).length};document.getElementById('cards').replaceChildren(...Object.entries(counts).map(([key,value])=>{const card=document.createElement('div');card.className='card';const number=document.createElement('div');number.className='number';number.textContent=value;const label=document.createElement('div');label.className='muted';label.textContent=key;card.append(number,label);return card}));const attention=new Map(status.planner.attention.map(x=>[x.assignment_id,x]));const rows=status.assignments.map(item=>{const row=document.createElement('tr');row.append(cell(item.assignment_id.slice(0,8)),cell(item.profile),cell(item.state),cell(String(item.attempt)),cell(item.candidate_id?.slice(0,12)||''),cell(item.delivery.mode));const need=attention.get(item.assignment_id);const attentionCell=cell(need?.kind||'');if(need)attentionCell.className='attention';row.append(attentionCell);const controls=document.createElement('td');const openRequest=item.operator_requests.find(x=>x.state==='open');if(openRequest){controls.append(button('Answer',async()=>{const answer=window.prompt(openRequest.question);if(answer!==null&&answer.trim())await action({op:'answer_request',assignment_id:item.assignment_id,expected_state_revision:item.state_revision,request_id:openRequest.request_id,answer})}))}if(need?.kind==='operator-approval'){controls.append(button('Approve',()=>action({op:'approve_candidate',assignment_id:item.assignment_id,expected_state_revision:item.state_revision,candidate_id:item.candidate_id,kind:'operator'})))}if(need?.kind==='delivery-blocked'){controls.append(button('Retry delivery',()=>action({op:'retry_delivery',assignment_id:item.assignment_id,expected_state_revision:item.state_revision})))}row.append(controls);return row});document.getElementById('assignments').replaceChildren(...rows);errorNode.textContent=''}catch(error){errorNode.textContent=error.message}}
refresh();setInterval(refresh,2000);
</script>
</body>
</html>`;
}

function validateHost(requestHost, boundPort) {
  try {
    const parsed = new URL(`http://${requestHost}`);
    const port = parsed.port.length === 0 ? 80 : Number(parsed.port);
    return LOOPBACK_HOSTS.has(parsed.hostname) && port === boundPort;
  } catch {
    return false;
  }
}

async function defaultActionDispatcher(cwd, payload) {
  const record = await readAssignment(cwd, payload.assignment_id);
  if (record.state_revision !== payload.expected_state_revision) {
    throw new Error(`Assignment revision is ${record.state_revision}.`);
  }
  if (payload.op === "answer_request") {
    return dispatchAssignmentAction(
      record.repository,
      createAction({
        op: "answer_request",
        authority: "operator",
        record,
        payload: { request_id: payload.request_id, answer: payload.answer },
      }),
    );
  }
  if (payload.op === "approve_candidate") {
    return dispatchAssignmentAction(
      record.repository,
      createAction({
        op: "approve_candidate",
        authority: "operator",
        record,
        payload: { candidate_id: payload.candidate_id, kind: "operator" },
      }),
    );
  }
  if (payload.op === "retry_delivery") {
    return dispatchAssignmentAction(
      record.repository,
      createAction({ op: "retry_delivery", authority: "operator", record }),
    );
  }
  throw new Error("Dashboard action is not allowed.");
}

export async function startDashboard({
  cwd,
  host = "127.0.0.1",
  port = 0,
  tokenGenerator = token,
  serverFactory = createServer,
  statusProvider = getControlPlaneStatus,
  actionDispatcher = defaultActionDispatcher,
} = {}) {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("Dashboard must bind to loopback.");
  }
  let initialToken = tokenGenerator();
  const sessionToken = tokenGenerator();
  const csrfToken = tokenGenerator();
  const server = serverFactory(async (request, response) => {
    try {
      const address = server.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      if (!validateHost(request.headers.host, boundPort)) {
        send(response, 400, "Invalid Host header.");
        return;
      }
      const requestUrl = new URL(request.url, `http://${request.headers.host}`);
      if (request.method === "GET" && requestUrl.pathname === "/" && initialToken !== null) {
        const supplied = requestUrl.searchParams.get("token");
        if (equalToken(supplied, initialToken)) {
          initialToken = null;
          send(response, 303, "", {
            Location: "/",
            "Set-Cookie": `sol_luna_session=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/`,
          });
          return;
        }
      }
      const cookies = parseCookies(request.headers.cookie);
      if (!equalToken(cookies.sol_luna_session, sessionToken)) {
        send(response, 401, "Unauthorized.");
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/") {
        const nonce = tokenGenerator();
        send(response, 200, dashboardHtml(csrfToken, nonce), {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
        });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/status") {
        sendJson(response, 200, await statusProvider(cwd));
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/action") {
        const expectedOrigin = `http://${request.headers.host}`;
        if (request.headers.origin !== expectedOrigin || !equalToken(request.headers["x-csrf-token"], csrfToken)) {
          sendJson(response, 403, { status: "failed", error: "Origin or CSRF validation failed." });
          return;
        }
        const payload = await readJsonBody(request);
        if (!Number.isInteger(payload.expected_state_revision)) {
          throw new Error("expected_state_revision is required.");
        }
        const result = await actionDispatcher(cwd, payload);
        sendJson(response, 200, { status: "completed", state_revision: result.record.state_revision });
        return;
      }
      send(response, 404, "Not found.");
    } catch (error) {
      sendJson(response, 400, { status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, host, () => {
      server.removeListener("error", rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  const displayHost = host === "::1" ? "[::1]" : host;
  const closed = new Promise((resolvePromise) => server.once("close", resolvePromise));
  const close = () => server.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  server.once("close", () => {
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
  });
  return {
    server,
    url: `http://${displayHost}:${actualPort}/?token=${encodeURIComponent(initialToken)}`,
    closed,
    close,
  };
}
