const PREFIX = "Astra-Luna orchestrator";
const RESET = "\u001b[0m";

function upper(value) {
  return String(value).toUpperCase();
}

function describeRoute({ model, reasoningEffort, serviceTier, sandboxMode }) {
  return `${model}, ${reasoningEffort} reasoning, ${serviceTier} tier, ${sandboxMode}`;
}

export function executorLaunchMessage({
  profile,
  model,
  reasoningEffort,
  serviceTier,
  sandboxMode,
}) {
  return `◆ ${upper(profile)} · ${upper(model)} · ${upper(reasoningEffort)} · ${upper(serviceTier)} · ${upper(sandboxMode)}`;
}

export function executorResultMessage(result) {
  if (result.routing_verified === true) {
    return `${PREFIX}: ${result.profile} task ${result.status}. Routing: verified (${describeRoute({
      model: result.model,
      reasoningEffort: result.reasoning_effort,
      serviceTier: result.service_tier,
      sandboxMode: result.sandbox_mode,
    })}).`;
  }

  return `${PREFIX}: ${result.profile ?? "Executor"} task ${result.status}. Routing: not verified. See blockers and warnings in the JSON result.`;
}

export function ultraLaunchMessage({ model, reasoningEffort, serviceTier, sandboxMode }) {
  return `◆ ULTRA · ${upper(model)} · ${upper(reasoningEffort)} · ${upper(serviceTier)} · ${upper(sandboxMode)}`;
}

export function ultraResultMessage(result) {
  if (result.routing_verified === true) {
    return `${PREFIX}: Ultra task ${result.status}. Routing: verified (${describeRoute({
      model: result.model,
      reasoningEffort: result.reasoning_effort,
      serviceTier: result.service_tier,
      sandboxMode: result.sandbox_mode,
    })}).`;
  }

  const recovery = result.warnings?.some((warning) => warning.includes("recovery-required"))
    ? " The repository lock requires recovery. Inspect it with the orchestration gate status command before attempting recovery."
    : "";
  return `${PREFIX}: Ultra task ${result.status}. Routing: not verified. See blockers and warnings in the JSON result.${recovery}`;
}

export function shouldUseColor(
  stream = process.stderr,
  environment = process.env,
) {
  if (Object.hasOwn(environment, "NO_COLOR") || environment.TERM === "dumb") {
    return false;
  }
  if (Object.hasOwn(environment, "FORCE_COLOR")) {
    return environment.FORCE_COLOR !== "0";
  }
  return stream.isTTY === true;
}

export function colorizeStatus(
  message,
  colorCode,
  { stream = process.stderr, environment = process.env } = {},
) {
  return colorCode !== null && shouldUseColor(stream, environment)
    ? `\u001b[${colorCode}m${message}${RESET}`
    : message;
}

export function writeStatusMessage(
  message,
  stream = process.stderr,
  { colorCode = null, environment = process.env } = {},
) {
  stream.write(`${colorizeStatus(message, colorCode, { stream, environment })}\n`);
}
