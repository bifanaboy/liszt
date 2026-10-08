import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createFc2CmadbStudio } from "../lib/sources/fc2cmadb.js";

const now = new Date("2026-10-03T00:00:00Z");
const records = [1, 2, 3, 4].map((id) => ({
  video_id: id,
  title: "Fixture scene",
  release_date: "2026-10-02",
  duration: "20:00",
  censored: id === 1 ? "有" : id === 4 ? "無" : null,
  pivot: { tag_id: 47 },
  tags: [{ name: "アナル" }],
}));
const html = (component, props) =>
  `<script data-page="app" type="application/json">${JSON.stringify({ component, props })}</script>`;

function context() {
  return {
    now,
    log() {},
    fetcher: {
      async fetch(url) {
        if (url.includes("/tags/"))
          return new Response(
            html("Tags/Show", {
              tag_name: "アナル",
              articles: { data: records, next_cursor: null },
            }),
          );
        const id = Number(url.split("/").at(-1));
        if (id === 2) return new Response("removed", { status: 404 });
        return new Response(html("Articles/Show", { article: records[id - 1] }));
      },
    },
  };
}

function makeStore() {
  const decisions = new Map();
  return {
    decisions,
    async deleteFc2CandidatesBefore() {},
    async noteFc2Sightings() {},
    async decideFc2Candidate(id, status) {
      await setImmediate();
      decisions.set(id, status);
    },
    async fc2Candidates() {
      assert.equal(
        decisions.get("1"),
        "excluded",
        "listing decision must be saved before reading states",
      );
      return new Map();
    },
    async fc2DueCandidates() {
      await setImmediate();
      return ["2", "3", "4"].map((videoId) => ({ videoId, recheckAt: now.toISOString() }));
    },
    async retireFc2StalePending(id) {
      assert.equal(decisions.get(id), "pending", "classification must be saved before retirement");
      return 1;
    },
    async countFc2Pending() {
      assert.deepEqual(
        [...decisions],
        [
          ["1", "excluded"],
          ["2", "excluded"],
          ["3", "pending"],
          ["4", "accepted"],
        ],
      );
      return 0;
    },
  };
}

const source = (store) =>
  createFc2CmadbStudio({ store, listingMinIntervalMs: 0, detailMinIntervalMs: 0 });

test("FC2 awaits due candidates and saves each decision before dependent work", async () => {
  const result = await source(makeStore()).fetch("2026-07-05", context());
  assert.deepEqual(
    result.scenes.map((scene) => scene.sourceSceneId),
    ["4"],
  );
  assert.deepEqual(result.excludedSceneIds, ["1", "2"]);
});

for (const failingId of ["1", "2", "3"]) {
  test(`FC2 propagates asynchronous decision failures for candidate ${failingId}`, async () => {
    const store = makeStore();
    const save = store.decideFc2Candidate;
    const failure = new Error("database write failed");
    store.decideFc2Candidate = async (id, status) => {
      if (id === failingId) {
        await setImmediate();
        throw failure;
      }
      await save(id, status);
    };
    await assert.rejects(source(store).fetch("2026-07-05", context()), failure);
  });
}
