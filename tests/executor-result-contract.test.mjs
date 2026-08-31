import assert from "node:assert/strict";
import test from "node:test";
import {
  RESULT_SCHEMA_PATH,
  loadExecutorResultContract,
  validateExecutorResultContract,
  validateExecutorResultSchema,
} from "../.agents/skills/sol-luna-orchestration/scripts/executor-result-contract.mjs";

function createValidSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "operator_requests"],
    properties: {
      status: {
        type: "string",
        enum: ["completed", "blocked", "failed"],
      },
      operator_requests: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["question", "choices"],
          properties: {
            question: { type: "string" },
            choices: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      },
    },
  };
}

test("the production executor result schema is Structured Outputs compatible", async () => {
  const contract = await loadExecutorResultContract();
  assert.equal(contract.path, RESULT_SCHEMA_PATH);
  assert.match(contract.sha256, /^[0-9a-f]{64}$/);
  assert.equal(contract.schema.type, "object");
  assert.equal(contract.schema.required.includes("operator_requests"), true);
  assert.equal(Object.hasOwn(contract.schema, "allOf"), false);
});

test("the contract rejects unsupported composition keywords with their JSON pointer", () => {
  for (const keyword of [
    "allOf",
    "if",
    "then",
    "else",
    "not",
    "dependentRequired",
    "dependentSchemas",
  ]) {
    const schema = createValidSchema();
    schema.properties.status[keyword] = {};
    assert.throws(
      () => validateExecutorResultSchema(schema),
      (error) => error.code === "unsupported-schema-keyword"
        && error.pointer === `/properties/status/${keyword}`,
    );
  }
});

test("the contract requires every object property and forbids additional properties", () => {
  const missingRequired = createValidSchema();
  missingRequired.required = ["status"];
  assert.throws(
    () => validateExecutorResultSchema(missingRequired),
    (error) => error.code === "schema-properties-not-required"
      && error.pointer === "/required",
  );

  for (const additionalProperties of [undefined, true]) {
    const schema = createValidSchema();
    if (additionalProperties === undefined) {
      delete schema.properties.operator_requests.items.additionalProperties;
    } else {
      schema.properties.operator_requests.items.additionalProperties = additionalProperties;
    }
    assert.throws(
      () => validateExecutorResultSchema(schema),
      (error) => error.code === "schema-additional-properties"
        && error.pointer === "/properties/operator_requests/items/additionalProperties",
    );
  }
});

test("the contract requires an object at the root", () => {
  assert.throws(
    () => validateExecutorResultSchema({ type: "array", items: { type: "string" } }),
    (error) => error.code === "schema-root-type" && error.pointer === "/type",
  );
});

test("the loaded contract requires the exact SHA-256 of its schema", () => {
  assert.throws(
    () => validateExecutorResultContract({
      schema: createValidSchema(),
      sha256: "a".repeat(64),
    }),
    (error) => error.code === "schema-hash" && error.pointer === "/sha256",
  );
});
