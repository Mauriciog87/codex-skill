import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SKILL_NAME,
  installGlobalSkill,
} from "../scripts/install-global-skill.mjs";

async function createSkill(skillDirectory, name = SKILL_NAME) {
  await mkdir(join(skillDirectory, "agents"), { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill.\n---\n\n# Test\n`,
  );
  await writeFile(
    join(skillDirectory, "agents", "openai.yaml"),
    'interface:\n  display_name: "Sol-Terra Orchestration"\n',
  );
}

async function createFixture(context, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, "repository");
  const homeDirectory = join(root, "home");
  const canonicalSkill = join(
    repositoryRoot,
    ".agents",
    "skills",
    SKILL_NAME,
  );
  await createSkill(canonicalSkill);
  return { root, repositoryRoot, homeDirectory, canonicalSkill };
}

test("installGlobalSkill creates an idempotent repository link and removes validated legacy data", async (context) => {
  const fixture = await createFixture(context, "sol-terra-install-success-");
  const legacySkill = join(
    fixture.homeDirectory,
    ".codex",
    "skills",
    SKILL_NAME,
  );
  await createSkill(legacySkill);

  const first = await installGlobalSkill({
    repositoryRoot: fixture.repositoryRoot,
    homeDirectory: fixture.homeDirectory,
  });
  assert.equal(first.already_linked, false);
  assert.equal(first.legacy_removed, true);
  assert.equal(await realpath(first.global_skill), await realpath(fixture.canonicalSkill));
  await assert.rejects(lstat(legacySkill), { code: "ENOENT" });

  const second = await installGlobalSkill({
    repositoryRoot: fixture.repositoryRoot,
    homeDirectory: fixture.homeDirectory,
  });
  assert.equal(second.already_linked, true);
  assert.equal(second.legacy_removed, false);
});

test("installGlobalSkill fails without replacing an unrelated destination", async (context) => {
  const fixture = await createFixture(context, "sol-terra-install-conflict-");
  const destination = join(
    fixture.homeDirectory,
    ".agents",
    "skills",
    SKILL_NAME,
  );
  await mkdir(destination, { recursive: true });
  const marker = join(destination, "unrelated.txt");
  await writeFile(marker, "preserve");

  await assert.rejects(
    installGlobalSkill({
      repositoryRoot: fixture.repositoryRoot,
      homeDirectory: fixture.homeDirectory,
    }),
    /not a link/,
  );
  assert.equal(await readFile(marker, "utf8"), "preserve");
});

test("installGlobalSkill preserves an unverified legacy directory", async (context) => {
  const fixture = await createFixture(context, "sol-terra-install-legacy-");
  const legacySkill = join(
    fixture.homeDirectory,
    ".codex",
    "skills",
    SKILL_NAME,
  );
  await createSkill(legacySkill, "unrelated-skill");

  await assert.rejects(
    installGlobalSkill({
      repositoryRoot: fixture.repositoryRoot,
      homeDirectory: fixture.homeDirectory,
    }),
    /identity mismatch/,
  );
  assert.equal((await lstat(legacySkill)).isDirectory(), true);
  await assert.rejects(
    lstat(
      join(
        fixture.homeDirectory,
        ".agents",
        "skills",
        SKILL_NAME,
      ),
    ),
    { code: "ENOENT" },
  );
});
