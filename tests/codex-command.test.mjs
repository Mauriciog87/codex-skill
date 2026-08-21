import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { resolveCodexInvocation } from "../.agents/skills/sol-luna-orchestration/scripts/codex-command.mjs";

async function createFile(path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "", "utf8");
  return path;
}

test("non-Windows and explicit commands remain direct", async () => {
  const environment = {};
  assert.deepEqual(
    await resolveCodexInvocation("codex", { platform: "linux", environment }),
    { executable: "codex", environment },
  );
  assert.deepEqual(
    await resolveCodexInvocation("codex", { platform: "darwin", environment }),
    { executable: "codex", environment },
  );
  assert.deepEqual(
    await resolveCodexInvocation("C:\\tools\\codex.exe", {
      platform: "win32",
      architecture: "x64",
      environment,
    }),
    { executable: "C:\\tools\\codex.exe", environment },
  );
});

test("Windows prefers the first direct codex.exe on PATH", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-command-direct-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const firstDirectory = join(root, "first");
  const secondDirectory = join(root, "second");
  const firstExecutable = await createFile(join(firstDirectory, "codex.exe"));
  await createFile(join(secondDirectory, "codex.exe"));

  const environment = { Path: `${firstDirectory};${secondDirectory}` };
  assert.deepEqual(
    await resolveCodexInvocation("codex", {
      platform: "win32",
      architecture: "x64",
      environment,
    }),
    { executable: firstExecutable, environment },
  );
});

test("Windows resolves nested and hoisted npm native packages", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-command-npm-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    {
      name: "nested x64",
      architecture: "x64",
      packageName: "codex-win32-x64",
      target: "x86_64-pc-windows-msvc",
      segments: ["node_modules", "@openai", "codex", "node_modules", "@openai"],
    },
    {
      name: "hoisted arm64",
      architecture: "arm64",
      packageName: "codex-win32-arm64",
      target: "aarch64-pc-windows-msvc",
      segments: ["node_modules", "@openai"],
    },
    {
      name: "bundled x64",
      architecture: "x64",
      packageName: "codex",
      target: "x86_64-pc-windows-msvc",
      segments: ["node_modules", "@openai"],
    },
  ];

  for (const fixture of cases) {
    await context.test(fixture.name, async () => {
      const prefix = join(root, fixture.name);
      await createFile(join(prefix, "codex.cmd"));
      const executable = await createFile(join(
        prefix,
        ...fixture.segments,
        fixture.packageName,
        "vendor",
        fixture.target,
        "bin",
        "codex.exe",
      ));
      const environment = {
        PATH: prefix,
        CODEX_MANAGED_BY_BUN: "1",
        CODEX_MANAGED_BY_PNPM: "1",
      };
      const invocation = await resolveCodexInvocation("codex", {
          platform: "win32",
          architecture: fixture.architecture,
          environment,
        });
      assert.equal(invocation.executable, executable);
      assert.equal(
        invocation.environment.CODEX_MANAGED_PACKAGE_ROOT,
        join(prefix, "node_modules", "@openai", "codex"),
      );
      assert.equal(invocation.environment.CODEX_MANAGED_BY_NPM, "1");
      assert.equal(Object.hasOwn(invocation.environment, "CODEX_MANAGED_BY_BUN"), false);
      assert.equal(Object.hasOwn(invocation.environment, "CODEX_MANAGED_BY_PNPM"), false);
      assert.equal(Object.hasOwn(environment, "CODEX_MANAGED_BY_NPM"), false);
    });
  }
});

test("Windows fails closed for unsupported, incomplete, and absent installations", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-command-invalid-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createFile(join(root, "codex.cmd"));

  await assert.rejects(
    resolveCodexInvocation("codex", {
      platform: "win32",
      architecture: "ia32",
      environment: { PATH: root },
    }),
    /Unsupported Windows architecture/,
  );
  await assert.rejects(
    resolveCodexInvocation("codex", {
      platform: "win32",
      architecture: "x64",
      environment: { PATH: root },
    }),
    /shim.*native codex\.exe/i,
  );
  await assert.rejects(
    resolveCodexInvocation("codex", {
      platform: "win32",
      architecture: "x64",
      environment: { PATH: join(root, "missing") },
    }),
    /not found on PATH/,
  );
});
