import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexInvocation } from "./codex-command.mjs";
import { readCodexModelCatalog } from "./codex-app-server-client.mjs";
import { readDeliveryConfiguration } from "./delivery-configuration.mjs";
import { DEFAULT_MODEL_CONFIGURATION, resolveModelRoute } from "./model-selection.mjs";
import { rootConfigValues } from "./model-policy.mjs";
import { executorLaunchMessage, writeStatusMessage } from "./orchestration-messages.mjs";

export function parseModelRoutingArguments(argv, cwd = process.cwd()) {
  const [operation, ...rest] = argv;
  if (!["inspect", "root"].includes(operation) || (rest.length !== 0 && (rest.length !== 2 || rest[0] !== "--cwd" || !rest[1] || rest[1].startsWith("--")))) {
    throw new Error("Use model-routing.mjs inspect|root [--cwd <directory>]. Configure models in sol-luna-orchestration/config.json, not CLI overrides.");
  }
  return { operation, cwd: resolve(cwd, rest[1] ?? ".") };
}

export function buildRootArguments(route, cwd) {
  return ["--cd", cwd, ...Object.entries(rootConfigValues(route)).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]),
    "-c", "features.fast_mode=false", "-c", "features.multi_agent=false", "-c", "agents.max_depth=1", "-c", "agents.max_threads=4"];
}

export async function startConfiguredRoot(route, {
  cwd,
  environment = process.env,
  commandResolver = resolveCodexInvocation,
  spawnImplementation = spawn,
  signal,
} = {}) {
  const invocation = await commandResolver("codex", { platform: process.platform, architecture: process.arch, environment });
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawnImplementation(invocation.executable, buildRootArguments(route, cwd), {
      cwd, env: invocation.environment, stdio: "inherit", shell: false, windowsHide: true, signal,
    });
    child.once("error", rejectPromise);
    child.once("close", (code, terminationSignal) => {
      if (terminationSignal) rejectPromise(new Error(`Root session ended with ${terminationSignal}.`));
      else resolvePromise(code ?? 2);
    });
  });
}

export async function main(argv = process.argv.slice(2), {
  environment = process.env,
  configurationReader = readDeliveryConfiguration,
  catalogReader = readCodexModelCatalog,
  rootStarter = startConfiguredRoot,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const options = parseModelRoutingArguments(argv);
    const configuration = await configurationReader({ environment });
    const catalog = await catalogReader({ cwd: options.cwd, environment });
    if (options.operation === "inspect") {
      const routes = Object.fromEntries(Object.keys(DEFAULT_MODEL_CONFIGURATION.efforts).map((role) => [role, resolveModelRoute(role, configuration.models, catalog)]));
      stdout.write(`${JSON.stringify({ status: "completed", configuration_path: configuration.path, routes })}\n`);
      return 0;
    }
    const route = resolveModelRoute("root", configuration.models, catalog);
    writeStatusMessage(executorLaunchMessage({ ...route, profile: "root", sandboxMode: "session policy" }), stderr, { colorCode: 33, environment });
    return await rootStarter(route, { cwd: options.cwd, environment });
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
