import assert from "node:assert/strict";
import test from "node:test";
import {
  SimulationError,
  parseSimulationArguments,
  simulateControlPlane,
} from "../.agents/skills/sol-luna-orchestration/scripts/orchestration-simulator.mjs";

test("control-plane simulation is deterministic and exercises every safety path", () => {
  const first = simulateControlPlane({ iterations: 500, seed: 73 });
  const second = simulateControlPlane({ iterations: 500, seed: 73 });
  assert.deepEqual(first, second);
  assert.equal(first.status, "completed");
  assert.equal(first.rejected_faults, 4);
  assert.ok(first.transitions > first.iterations);
  for (const count of Object.values(first.scenario_counts)) {
    assert.ok(count > 0);
  }
});

test("simulator arguments are bounded and reject ambiguity", () => {
  assert.deepEqual(parseSimulationArguments(["--iterations", "12", "--seed", "9"]), {
    iterations: 12,
    seed: 9,
  });
  assert.throws(() => parseSimulationArguments(["--seed", "1", "--seed", "2"]), SimulationError);
  assert.throws(() => parseSimulationArguments(["--unknown", "1"]), SimulationError);
  assert.throws(() => simulateControlPlane({ iterations: 0 }), SimulationError);
  assert.throws(() => simulateControlPlane({ iterations: 100_001 }), SimulationError);
  assert.throws(() => simulateControlPlane({ iterations: 1, seed: Number.NaN }), SimulationError);
});
