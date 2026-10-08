export async function incrementPilotCounter(db) {
  const { rows } = await db.query(
    "UPDATE hatchable_pilot_state SET counter = counter + 1 WHERE id = 1 RETURNING counter",
  );
  if (!rows[0]) throw new Error("Pilot counter row is missing");
  return Number(rows[0].counter);
}
