const PREFIX = "Sol-Luna orchestrator";
const RESET = "\u001b[0m";

function upper(value) {
  return String(value).toUpperCase();
}

function describeRoute({ model, reasoningEffort, serviceTier, sandboxMode }) {
  return `${model} at ${reasoningEffort} reasoning on ${serviceTier} tier in ${sandboxMode} mode`;
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
    return `${PREFIX}: Executor routing verified for ${result.profile}: ${describeRoute({
      model: result.model,
      reasoningEffort: result.reasoning_effort,
      serviceTier: result.service_tier,
      sandboxMode: result.sandbox_mode,
    })} (routing_verified=true). Status: ${result.status}.`;
  }

  return `${PREFIX}: Executor routing was not verified for ${result.profile ?? "the requested profile"}. Status: ${result.status}.`;
}

export function ultraLaunchMessage({ model, reasoningEffort, serviceTier, sandboxMode }) {
  return `◆ ULTRA · ${upper(model)} · ${upper(reasoningEffort)} · ${upper(serviceTier)} · ${upper(sandboxMode)}`;
}

export function ultraResultMessage(result) {
  if (result.routing_verified === true) {
    return `${PREFIX}: Ultra routing verified: ${describeRoute({
      model: result.model,
      reasoningEffort: result.reasoning_effort,
      serviceTier: result.service_tier,
      sandboxMode: result.sandbox_mode,
    })} (routing_verified=true). Status: ${result.status}.`;
  }

  const recovery = result.warnings?.some((warning) => warning.includes("recovery-required"))
    ? " The repository lock requires recovery."
    : "";
  return `${PREFIX}: Ultra routing was not verified. Status: ${result.status}.${recovery}`;
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
