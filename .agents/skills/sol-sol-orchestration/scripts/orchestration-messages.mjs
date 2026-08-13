const PREFIX = "Sol orchestrator";

function describeRoute({ model, reasoningEffort, sandboxMode }) {
  return `${model} at ${reasoningEffort} reasoning in ${sandboxMode} mode`;
}

export function executorLaunchMessage({ profile, model, reasoningEffort, sandboxMode }) {
  return `${PREFIX}: Launching a separate ${profile} executor with ${describeRoute({
    model,
    reasoningEffort,
    sandboxMode,
  })}.`;
}

export function executorResultMessage(result) {
  if (result.routing_verified === true) {
    return `${PREFIX}: Executor routing verified for ${result.profile}: ${result.model} at ${result.reasoning_effort} reasoning (routing_verified=true). Status: ${result.status}.`;
  }

  return `${PREFIX}: Executor routing was not verified for ${result.profile ?? "the requested profile"}. Status: ${result.status}.`;
}

export function ultraLaunchMessage({ model, reasoningEffort, sandboxMode }) {
  return `${PREFIX}: Starting an exclusive Ultra takeover with ${describeRoute({
    model,
    reasoningEffort,
    sandboxMode,
  })}.`;
}

export function ultraResultMessage(result) {
  if (result.routing_verified === true) {
    return `${PREFIX}: Ultra routing verified: ${result.model} at ${result.reasoning_effort} reasoning (routing_verified=true). Status: ${result.status}.`;
  }

  const recovery = result.warnings?.some((warning) => warning.includes("recovery-required"))
    ? " The repository lock requires recovery."
    : "";
  return `${PREFIX}: Ultra routing was not verified. Status: ${result.status}.${recovery}`;
}

export function writeStatusMessage(message, stream = process.stderr) {
  stream.write(`${message}\n`);
}
