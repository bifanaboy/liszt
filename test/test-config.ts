import { loadConfig } from "../src/config.ts";

/** Test-only credentials; production config still refuses to start without owner values. */
export const loadConfigForTest = (env: NodeJS.ProcessEnv = {}) =>
  loadConfig({
    LISZT_AUTH_USERNAME: "test-owner",
    LISZT_AUTH_PASSWORD: "test-password-at-least-12",
    ...env,
  });
