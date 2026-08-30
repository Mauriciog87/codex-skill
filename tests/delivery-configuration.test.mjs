import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  DEFAULT_DELIVERY_CONFIGURATION_CONTENT,
  DeliveryConfigurationError,
  getDeliveryConfigurationPath,
  parseDeliveryConfiguration,
  readDeliveryConfiguration,
} from "../.agents/skills/sol-luna-orchestration/scripts/delivery-configuration.mjs";
import {
  applyAutomaticDeliveryConfiguration,
  createAutomaticCommitMessage,
  parseArguments,
  resolveAutomaticPushDestination,
} from "../.agents/skills/sol-luna-orchestration/scripts/invoke-profile-executor.mjs";

async function createFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "sol-luna-delivery-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, ".codex");
  const path = getDeliveryConfigurationPath({ codexHome });
  return { root, codexHome, path };
}

function writerOptions(cwd) {
  return parseArguments([
    "--profile",
    "implement",
    "--cwd",
    cwd,
    "--sandbox",
    "workspace-write",
    "--write-root",
    "src",
  ]);
}

test("delivery configuration defaults to automatic and preserves an explicit opt-out", async (context) => {
  const fixture = await createFixture(context);
  assert.equal(DEFAULT_DELIVERY_CONFIGURATION_CONTENT, '{\n  "automatic_delivery": true\n}\n');
  assert.deepEqual(await readDeliveryConfiguration({ codexHome: fixture.codexHome }), {
    automatic_delivery: true,
    path: fixture.path,
    exists: false,
  });

  await mkdir(dirname(fixture.path), { recursive: true });
  await writeFile(fixture.path, '{"automatic_delivery":false}\n');
  assert.deepEqual(await readDeliveryConfiguration({ codexHome: fixture.codexHome }), {
    automatic_delivery: false,
    path: fixture.path,
    exists: true,
  });
});

test("delivery configuration rejects malformed and ambiguous values", () => {
  assert.throws(() => parseDeliveryConfiguration("{"), DeliveryConfigurationError);
  assert.throws(
    () => parseDeliveryConfiguration('{"automatic_delivery":"yes"}'),
    /must be true or false/,
  );
  assert.throws(
    () => parseDeliveryConfiguration('{"automatic_delivery":true,"push":true}'),
    /Unexpected delivery configuration properties/,
  );
});

test("automatic delivery commits validated writer assignments and pushes to a matching upstream", async () => {
  const options = writerOptions(process.cwd());
  const configured = await applyAutomaticDeliveryConfiguration({
    options,
    briefing: "feat: add the requested behavior\n\nMore detail.",
    configurationReader: async () => ({ automatic_delivery: true }),
    pushDestinationResolver: async () => ({ remote: "origin", branch: "master" }),
  });
  assert.equal(configured.deliveryMode, "push");
  assert.equal(configured.commitMessage, "feat: add the requested behavior");
  assert.equal(configured.pushRemote, "origin");
  assert.equal(configured.pushBranch, "master");

  const localOnly = await applyAutomaticDeliveryConfiguration({
    options,
    briefing: "Implement a validated task.",
    configurationReader: async () => ({ automatic_delivery: true }),
    pushDestinationResolver: async () => null,
  });
  assert.equal(localOnly.deliveryMode, "commit");
  assert.equal(localOnly.commitMessage, "chore: Implement a validated task.");
  assert.equal(localOnly.pushRemote, null);
  assert.equal(localOnly.pushBranch, null);
});

test("automatic delivery is opt-out and explicit CLI delivery has precedence", async () => {
  const options = writerOptions(process.cwd());
  let destinationChecks = 0;
  const disabled = await applyAutomaticDeliveryConfiguration({
    options,
    briefing: "Implement a task.",
    configurationReader: async () => ({ automatic_delivery: false }),
    pushDestinationResolver: async () => {
      destinationChecks += 1;
      return { remote: "origin", branch: "master" };
    },
  });
  assert.strictEqual(disabled, options);
  assert.equal(destinationChecks, 0);

  const explicit = await applyAutomaticDeliveryConfiguration({
    options,
    briefing: "Implement a task.",
    deliveryExplicit: true,
    configurationReader: async () => {
      throw new Error("configuration must not be read");
    },
  });
  assert.strictEqual(explicit, options);

  const readOnly = parseArguments(["--profile", "explore"]);
  const unchangedReadOnly = await applyAutomaticDeliveryConfiguration({
    options: readOnly,
    briefing: "Inspect only.",
    configurationReader: async () => {
      throw new Error("read-only profiles must not read delivery configuration");
    },
  });
  assert.strictEqual(unchangedReadOnly, readOnly);

  const resumed = parseArguments([
    "--profile",
    "implement",
    "--sandbox",
    "workspace-write",
    "--assignment-id",
    "existing-assignment",
  ]);
  const unchangedResume = await applyAutomaticDeliveryConfiguration({
    options: resumed,
    briefing: "",
    configurationReader: async () => {
      throw new Error("resumed assignments must not read delivery configuration");
    },
  });
  assert.strictEqual(unchangedResume, resumed);
});

test("automatic push discovery uses only a matching configured upstream", async () => {
  const processRunner = async (_command, args) => {
    const key = args.join(" ");
    const stdout = new Map([
      ["symbolic-ref --quiet --short HEAD", "master"],
      ["config --get branch.master.remote", "origin"],
      ["config --get branch.master.merge", "refs/heads/master"],
    ]).get(key);
    return {
      exitCode: stdout === undefined ? 1 : 0,
      stdout: stdout ?? "",
      stderr: "",
      timedOut: false,
      aborted: false,
    };
  };
  assert.deepEqual(
    await resolveAutomaticPushDestination(process.cwd(), { processRunner }),
    { remote: "origin", branch: "master" },
  );

  const mismatchedRunner = async (command, args, options) => {
    const result = await processRunner(command, args, options);
    if (args.at(-1) === "branch.master.merge") {
      return { ...result, stdout: "refs/heads/release" };
    }
    return result;
  };
  assert.equal(
    await resolveAutomaticPushDestination(process.cwd(), { processRunner: mismatchedRunner }),
    null,
  );
});

test("automatic commit messages are one-line and bounded", () => {
  const message = createAutomaticCommitMessage(`# ${"task ".repeat(80)}\nignored`);
  assert.match(message, /^chore: task/);
  assert.equal(message.includes("\n"), false);
  assert.ok(message.length <= 200);
});
