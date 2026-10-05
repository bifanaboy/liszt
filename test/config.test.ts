import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

test("TPDB API key is read from its environment variable", () => {
  assert.equal(loadConfig({}).tpdbApiKey, undefined);
  assert.equal(loadConfig({ TPDB_API_KEY: "  token-value  " }).tpdbApiKey, "token-value");
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
  assert.deepEqual(loadConfig({ LISZT_STUDIO_LINKS: file }).studioLinks, [brazzers]);
  assert.deepEqual(loadConfig({ LISZT_STUDIO_LINKS: JSON.stringify([brazzers]) }).studioLinks, [
    brazzers,
  ]);
  assert.deepEqual(loadConfig({ LISZT_STUDIO_LINKS: "[]" }).studioLinks, []);
});

test("default studio links register every Dredd TPDB site under one alias", () => {
  const dredd = loadConfig({}).studioLinks.find((link) => link.studioId === "dredd");
  assert.ok(dredd);
  assert.equal(dredd.studio, "Dredd");
  assert.ok(dredd.aliases?.includes("DreddXXX"));
  assert.deepEqual(dredd.tpdb?.siteIds, [50864, 39697, 81939]);
});

test("Bang has a verified default listing URL and permits an explicit override", () => {
  assert.equal(loadConfig({}).bangListingUrl, "https://www.bang.com/videos?by=date.desc");
  assert.equal(
    loadConfig({ LISZT_BANG_LISTING_URL: "https://www.bang.com/videos?by=date.desc&page=2" })
      .bangListingUrl,
    "https://www.bang.com/videos?by=date.desc&page=2",
  );
});

test("a broken studio declaration is a named configuration error, not a silent drop", () => {
  // A silently dropped studio is indistinguishable from a studio that released
  // nothing, which is the failure this whole mechanism exists to avoid.
  assert.throws(
    () => loadConfig({ LISZT_STUDIO_LINKS: "{not json" }),
    /LISZT_STUDIO_LINKS is not valid JSON/,
  );
  assert.throws(
    () => loadConfig({ LISZT_STUDIO_LINKS: "/nonexistent/studio-links.json" }),
    /could not be read/,
  );
  assert.throws(
    () => loadConfig({ LISZT_STUDIO_LINKS: JSON.stringify([{ studioId: "x" }]) }),
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
  assert.throws(() => loadConfig({ LISZT_STUDIO_LINKS: JSON.stringify(conflict) }), /TPDB site 92/);
  assert.throws(
    () =>
      loadConfig({
        LISZT_STUDIO_LINKS: JSON.stringify([
          brazzers,
          { ...brazzers, tpdb: { siteIds: [116], name: "Brazzers Vault" } },
        ]),
      }),
    /duplicate studioId "network-brazzers-anal"/,
  );
});
