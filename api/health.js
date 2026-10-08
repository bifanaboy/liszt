import { db } from "hatchable";
import { incrementPilotCounter } from "lib/pilot.js";

export const access = "member";
export const methods = ["GET"];

export default async function (_req, res) {
  const probeCount = await incrementPilotCounter(db);
  res.json({ ok: true, probe_count: probeCount });
}
