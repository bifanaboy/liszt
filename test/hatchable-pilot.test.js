import assert from "node:assert/strict";
import test from "node:test";
import { incrementPilotCounter } from "../lib/pilot.js";

test("increments and returns the persistent pilot counter", async () => {
  let counter = 0;
  const db = {
    async query(sql) {
      assert.equal(
        sql,
        "UPDATE hatchable_pilot_state SET counter = counter + 1 WHERE id = 1 RETURNING counter",
      );
      counter += 1;
      return { rows: [{ counter }] };
    },
  };

  assert.equal(await incrementPilotCounter(db), 1);
  assert.equal(await incrementPilotCounter(db), 2);
});

test("fails clearly when the pilot counter row is missing", async () => {
  await assert.rejects(
    incrementPilotCounter({ query: async () => ({ rows: [] }) }),
    { message: "Pilot counter row is missing" },
  );
});
