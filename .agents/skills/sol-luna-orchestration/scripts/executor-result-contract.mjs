import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const UNSUPPORTED_KEYWORDS = new Set([
  "allOf",
  "if",
  "then",
  "else",
  "not",
  "dependentRequired",
  "dependentSchemas",
]);

export const RESULT_SCHEMA_PATH = resolve(
  SCRIPT_DIRECTORY,
  "..",
  "references",
  "executor-result.schema.json",
);

export class ExecutorResultContractError extends Error {
  constructor(message, code, pointer) {
    super(`${message} at ${pointer || "/"}.`);
    this.name = "ExecutorResultContractError";
    this.code = code;
    this.pointer = pointer || "/";
  }
}

function pointerSegment(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function childPointer(pointer, segment) {
  return `${pointer}/${pointerSegment(segment)}`;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message, code, pointer) {
  throw new ExecutorResultContractError(message, code, pointer);
}

function validateObjectSchema(schema, pointer) {
  if (schema.additionalProperties !== false) {
    fail(
      "Structured Outputs object schemas require additionalProperties false",
      "schema-additional-properties",
      childPointer(pointer, "additionalProperties"),
    );
  }
  if (!isObject(schema.properties)) {
    fail(
      "Structured Outputs object schemas require a properties object",
      "schema-properties",
      childPointer(pointer, "properties"),
    );
  }
  if (!Array.isArray(schema.required) || schema.required.some((entry) => typeof entry !== "string")) {
    fail(
      "Structured Outputs object schemas require a required string array",
      "schema-required",
      childPointer(pointer, "required"),
    );
  }
  const properties = Object.keys(schema.properties);
  const required = new Set(schema.required);
  if (
    required.size !== schema.required.length
    || properties.length !== required.size
    || properties.some((property) => !required.has(property))
  ) {
    fail(
      "Every Structured Outputs object property must be required exactly once",
      "schema-properties-not-required",
      childPointer(pointer, "required"),
    );
  }
}

function visitSchema(schema, pointer, root = false) {
  if (!isObject(schema)) {
    fail("Schema nodes must be objects", "schema-node", pointer);
  }
  if (root && schema.type !== "object") {
    fail("Structured Outputs requires an object at the root", "schema-root-type", "/type");
  }
  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (Object.hasOwn(schema, keyword)) {
      fail(
        `Structured Outputs does not support ${keyword}`,
        "unsupported-schema-keyword",
        childPointer(pointer, keyword),
      );
    }
  }
  if (schema.type === "object" || Object.hasOwn(schema, "properties")) {
    validateObjectSchema(schema, pointer);
  }
  if (isObject(schema.properties)) {
    for (const [property, propertySchema] of Object.entries(schema.properties)) {
      visitSchema(propertySchema, childPointer(childPointer(pointer, "properties"), property));
    }
  }
  if (isObject(schema.items)) {
    visitSchema(schema.items, childPointer(pointer, "items"));
  }
  if (Array.isArray(schema.anyOf)) {
    schema.anyOf.forEach((entry, index) => {
      visitSchema(entry, childPointer(childPointer(pointer, "anyOf"), index));
    });
  }
  for (const definitionKeyword of ["$defs", "definitions"]) {
    if (!isObject(schema[definitionKeyword])) {
      continue;
    }
    for (const [name, definition] of Object.entries(schema[definitionKeyword])) {
      visitSchema(definition, childPointer(childPointer(pointer, definitionKeyword), name));
    }
  }
}

export function validateExecutorResultSchema(schema) {
  visitSchema(schema, "", true);
  return schema;
}

function schemaSha256(schema) {
  return createHash("sha256").update(JSON.stringify(schema)).digest("hex");
}

export function validateExecutorResultContract(contract) {
  if (!isObject(contract)) {
    fail("The executor result contract must be an object", "schema-contract", "/");
  }
  validateExecutorResultSchema(contract.schema);
  const expectedSha256 = schemaSha256(contract.schema);
  if (
    typeof contract.sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(contract.sha256)
    || contract.sha256 !== expectedSha256
  ) {
    fail("The executor result contract SHA-256 is invalid", "schema-hash", "/sha256");
  }
  return contract;
}

export async function loadExecutorResultContract({
  path = RESULT_SCHEMA_PATH,
  readFileImplementation = readFile,
} = {}) {
  const resolvedPath = resolve(path);
  let schema;
  try {
    schema = JSON.parse(await readFileImplementation(resolvedPath, "utf8"));
  } catch (error) {
    fail(`Unable to load the executor result schema: ${error.message}`, "schema-load-failed", "/");
  }
  const contract = {
    path: resolvedPath,
    schema,
    sha256: schemaSha256(schema),
  };
  return validateExecutorResultContract(contract);
}
