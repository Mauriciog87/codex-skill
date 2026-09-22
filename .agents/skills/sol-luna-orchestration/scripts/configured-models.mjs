import { readDeliveryConfiguration } from "./delivery-configuration.mjs";
import { readCodexModelCatalog } from "./codex-app-server-client.mjs";
import { resolveModelRoute, validateModelConfiguration } from "./model-selection.mjs";

export async function resolveConfiguredModel(role, {
  cwd,
  environment = process.env,
  command,
  codexHome,
  timeoutMs,
  configurationReader = readDeliveryConfiguration,
  catalogReader = readCodexModelCatalog,
} = {}) {
  const configuration = await configurationReader({ codexHome, environment });
  const models = validateModelConfiguration(configuration.models);
  const catalog = await catalogReader({ cwd, environment, command, timeoutMs });
  return resolveModelRoute(role, models, catalog);
}
