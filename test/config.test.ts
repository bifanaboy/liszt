import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

const load = (env: NodeJS.ProcessEnv = {}) =>
  loadConfig({
    LISZT_AUTH_USERNAME: "owner",
    LISZT_AUTH_PASSWORD: "test-password-at-least-12",
    ...env,
  });

test("TPDB API key is read from its environment variable", () => {
  assert.equal(load({}).tpdbApiKey, undefined);
  assert.equal(load({ TPDB_API_KEY: "  token-value  " }).tpdbApiKey, "token-value");
});

const brazzers = {
  studioId: "network-brazzers-anal",
  studio: "Brazzers",
  tags: ["anal"],
  traxxx: {
    kind: "network",
    slug: "brazzers",
    url: "https://traxxx.me/network/brazzers/scenes/latest/1",
  },
  tpdb: { siteIds: [92], name: "Brazzers" },
};

test("declared studios are read from a file path or from inline JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "liszt-links-"));
  const file = join(dir, "studio-links.json");
  writeFileSync(file, JSON.stringify([brazzers]));
  assert.deepEqual(load({ LISZT_STUDIO_LINKS: file }).studioLinks, [brazzers]);
  assert.deepEqual(load({ LISZT_STUDIO_LINKS: JSON.stringify([brazzers]) }).studioLinks, [
    brazzers,
  ]);
  assert.deepEqual(load({ LISZT_STUDIO_LINKS: "[]" }).studioLinks, []);
});

test("default studio links register every Dredd TPDB site under one alias", () => {
  const dredd = load({}).studioLinks.find((link) => link.studioId === "dredd");
  assert.ok(dredd);
  assert.equal(dredd.studio, "Dredd");
  assert.ok(dredd.aliases?.includes("DreddXXX"));
  assert.deepEqual(dredd.tpdb?.siteIds, [50864, 39697, 81939]);
});

test("private HTTP credentials are required and validated at startup", () => {
  assert.throws(
    () => loadConfig({}, { requireAuth: true }),
    /LISZT_AUTH_USERNAME.*LISZT_AUTH_PASSWORD/,
  );
  assert.throws(
    () =>
      loadConfig(
        { LISZT_AUTH_USERNAME: "owner", LISZT_AUTH_PASSWORD: "short" },
        { requireAuth: true },
      ),
    /authPassword/,
  );
  assert.equal(load({}).authUsername, "owner");
});

test("a broken studio declaration is a named configuration error, not a silent drop", () => {
  // A silently dropped studio is indistinguishable from a studio that released
  // nothing, which is the failure this whole mechanism exists to avoid.
  assert.throws(
    () => load({ LISZT_STUDIO_LINKS: "{not json" }),
    /LISZT_STUDIO_LINKS is not valid JSON/,
  );
  assert.throws(
    () => load({ LISZT_STUDIO_LINKS: "/nonexistent/studio-links.json" }),
    /could not be read/,
  );
  assert.throws(
    () => load({ LISZT_STUDIO_LINKS: JSON.stringify([{ studioId: "x" }]) }),
    /studio/,
    "a declaration missing required fields is rejected by name",
  );
});

test("two studios claiming one key or one TPDB site stop the app starting", () => {
  const conflict = [
    brazzers,
    {
      ...brazzers,
      studioId: "network-brazzers-2",
      studio: "Brazzers Vault",
      tpdb: { siteIds: [92], name: "Brazzers Vault" },
    },
  ];
  assert.throws(() => load({ LISZT_STUDIO_LINKS: JSON.stringify(conflict) }), /TPDB site 92/);
  assert.throws(
    () =>
      load({
        LISZT_STUDIO_LINKS: JSON.stringify([
          brazzers,
          { ...brazzers, tpdb: { siteIds: [116], name: "Brazzers Vault" } },
        ]),
      }),
    /duplicate studioId "network-brazzers-anal"/,
  );
});
