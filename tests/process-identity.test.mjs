import assert from "node:assert/strict";
import test from "node:test";
import {
  ProcessIdentityError,
  captureProcessFingerprint,
  createProcessIdentity,
  inspectProcessIdentity,
  parseLinuxProcessStat,
} from "../.agents/skills/sol-luna-orchestration/scripts/process-identity.mjs";

function identityOptions(result) {
  return {
    platform: "linux",
    architecture: "x64",
    hostnameValue: "test-host",
    instanceId: "instance-123",
    captureFingerprint: async () => result,
  };
}

test("process identities bind an instance to its operating-system start fingerprint", async () => {
  const identity = await createProcessIdentity({
    pid: 123,
    ...identityOptions({ status: "found", fingerprint: "boot-id:42" }),
  });
  assert.deepEqual(identity, {
    pid: 123,
    instance_id: "instance-123",
    start_fingerprint: "boot-id:42",
    hostname: "test-host",
    platform: "linux",
    architecture: "x64",
  });
});

test("process inspection distinguishes same, dead, reused, and unknown", async () => {
  const identity = await createProcessIdentity({
    pid: 123,
    ...identityOptions({ status: "found", fingerprint: "boot-id:42" }),
  });
  for (const [captured, expected] of [
    [{ status: "found", fingerprint: "boot-id:42" }, "same"],
    [{ status: "dead" }, "dead"],
    [{ status: "found", fingerprint: "boot-id:99" }, "reused"],
    [{ status: "unknown", reason: "permission denied" }, "unknown"],
  ]) {
    const result = await inspectProcessIdentity(identity, {
      captureFingerprint: async () => captured,
      platform: "linux",
      architecture: "x64",
      hostnameValue: "test-host",
    });
    assert.equal(result.status, expected);
  }
});

test("identity creation fails closed when a process fingerprint is unavailable", async () => {
  await assert.rejects(
    createProcessIdentity({
      pid: 123,
      ...identityOptions({ status: "unknown", reason: "unsupported platform" }),
    }),
    ProcessIdentityError,
  );
  await assert.rejects(
    createProcessIdentity({
      pid: 123,
      ...identityOptions({ status: "dead" }),
    }),
    /not active/,
  );
});

test("Linux stat parsing handles process names containing spaces and parentheses", () => {
  const fields = ["S", ...Array.from({ length: 18 }, () => "0"), "777"];
  assert.equal(parseLinuxProcessStat(`123 (node (worker)) ${fields.join(" ")}`), "777");
  assert.throws(() => parseLinuxProcessStat("malformed"), ProcessIdentityError);
});

test("platform fingerprint providers use bounded native process queries", async () => {
  const linux = await captureProcessFingerprint(123, {
    platform: "linux",
    readFileImplementation: async (path) => path.endsWith("boot_id")
      ? "boot-123\n"
      : `123 (node worker) ${["S", ...Array.from({ length: 18 }, () => "0"), "456"].join(" ")}`,
    processAlive: () => true,
  });
  assert.deepEqual(linux, { status: "found", fingerprint: "boot-123:456" });

  const invocations = [];
  const execFileImplementation = async (executable, args, options) => {
    invocations.push({ executable, args, options });
    return { stdout: executable === "ps" ? "Mon Aug 24 10:00:00 2026\n" : "2026-08-24T10:00:00Z" };
  };
  const darwin = await captureProcessFingerprint(123, {
    platform: "darwin",
    execFileImplementation,
    processAlive: () => true,
  });
  const windows = await captureProcessFingerprint(123, {
    platform: "win32",
    execFileImplementation,
    processAlive: () => true,
  });
  assert.equal(darwin.fingerprint, "Mon Aug 24 10:00:00 2026");
  assert.equal(windows.fingerprint, "2026-08-24T10:00:00Z");
  assert.equal(invocations[0].executable, "ps");
  assert.deepEqual(invocations[0].args, ["-o", "lstart=", "-p", "123"]);
  assert.equal(invocations[1].executable, "powershell.exe");
  assert.match(invocations[1].args.at(-1), /Get-CimInstance Win32_Process/);
  assert.equal(invocations.some((invocation) => invocation.options.shell === true), false);
  assert.equal(invocations.every((invocation) => invocation.options.timeout === 5_000), true);
});
