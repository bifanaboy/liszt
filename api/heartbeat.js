import { db } from "hatchable";
import { incrementPilotCounter } from "lib/pilot.js";

export const access = "scheduler";
export const methods = ["POST"];

export default async function (_req, res) {
  const tick = await incrementPilotCounter(db);
  console.info(JSON.stringify({ event: "pilot.cron", tick }));
  res.json({ ok: true, tick });
}
