export const access = "admin";
export const methods = ["POST"];

export default async function (_req, res) {
  globalThis.console.error(
    JSON.stringify({
      event: "pilot.handled_failure",
      run_id: "pilot",
      provider: "pilot_probe",
      stage: "log_check",
      occurred_at: new Date().toISOString(),
      summary: "intentional sanitized sample failure",
    }),
  );
  res.json({ logged: true });
}
