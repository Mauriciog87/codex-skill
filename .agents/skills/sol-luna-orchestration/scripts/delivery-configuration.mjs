import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodexHome } from "./orchestration-state.mjs";

export const DEFAULT_DELIVERY_CONFIGURATION = Object.freeze({
  automatic_delivery: true,
});
export const DEFAULT_DELIVERY_CONFIGURATION_CONTENT = `${JSON.stringify(
  DEFAULT_DELIVERY_CONFIGURATION,
  null,
  2,
)}\n`;

export class DeliveryConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeliveryConfigurationError";
  }
}

export function getDeliveryConfigurationPath({
  codexHome,
  environment = process.env,
  homeDirectory,
} = {}) {
  const root = codexHome ?? getCodexHome(environment, homeDirectory);
  return join(root, "sol-luna-orchestration", "config.json");
}

export function validateDeliveryConfiguration(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DeliveryConfigurationError("Delivery configuration must be a JSON object.");
  }
  const properties = Object.keys(value);
  const unexpected = properties.filter((property) => property !== "automatic_delivery");
  if (unexpected.length > 0) {
    throw new DeliveryConfigurationError(
      `Unexpected delivery configuration properties: ${unexpected.join(", ")}.`,
    );
  }
  if (typeof value.automatic_delivery !== "boolean") {
    throw new DeliveryConfigurationError("automatic_delivery must be true or false.");
  }
  return { automatic_delivery: value.automatic_delivery };
}

export function parseDeliveryConfiguration(content, path = "delivery configuration") {
  let value;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new DeliveryConfigurationError(`${path} contains invalid JSON: ${error.message}`);
  }
  return validateDeliveryConfiguration(value);
}

export async function readDeliveryConfiguration({
  codexHome,
  environment = process.env,
  homeDirectory,
  readFileImplementation = readFile,
} = {}) {
  const path = getDeliveryConfigurationPath({ codexHome, environment, homeDirectory });
  let content;
  try {
    content = await readFileImplementation(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        ...DEFAULT_DELIVERY_CONFIGURATION,
        path,
        exists: false,
      };
    }
    throw error;
  }
  return {
    ...parseDeliveryConfiguration(content, path),
    path,
    exists: true,
  };
}
