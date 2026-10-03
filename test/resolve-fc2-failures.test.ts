/**
 * How the FC2 lane's own failures reach the resolver's records.
 *
 * `fc2-eporner` reports failure IN its result rather than throwing, and the
 * wiring read `.links` alone. An eporner outage then reached the resolver as an
 * empty list, which is indistinguishable from a release nobody reposted: the
 * scene was stamped `videoCheckedAt` exactly as a clean negative would be, no
 * rejection counter moved, and nothing was logged. The run ledger therefore
 * reported "this release has no upload" for a source that was down.
 *
 * Its own file because the throttled log counter is module state, and `node
 * --test` gives every file a fresh process. Sharing a file with the lane suite
 * would make the expected log lines depend on which tests ran first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyRejections, resolveFc2Scene, type RungRejections } from "../src/tubes/resolve.ts";
import type { Fc2LookupResult } from "../src/tubes/fc2-eporner.ts";
import { makeScene } from "./helpers.ts";

const NOW = new Date("2026-10-03T00:00:00Z");
const UPLOAD = "https://www.eporner.com/video-a/";

const SCENE = makeScene({
  id: "fc2cmadb:4979341",
  sourceId: "fc2cmadb",
  releaseUrl: "https://fc2cmadb.com/articles/4979341",
});

const answer = (error?: string): Fc2LookupResult => ({
  links: [{ url: UPLOAD, uploader: "U" }],
  code: "4979341",
  pagesRead: 1,
  candidatePagesRead: 1,
  relatedFollowed: 0,
  ...(error === undefined ? {} : { error }),
});

interface LoggedFailure {
  rung: string;
  error: string;
}

/** Resolve the one scene, collecting what the resolver counted and logged. */
async function run(
  rejections: RungRejections,
  lookup: (code: string) => Promise<Fc2LookupResult>,
): Promise<{ lines: LoggedFailure[]; scene: Awaited<ReturnType<typeof resolveFc2Scene>> }> {
  const lines: LoggedFailure[] = [];
  const result = await resolveFc2Scene(
    SCENE,
    {
      now: NOW,
      lookup,
      log: {
        warn: (message, fields = {}) => {
          if (message !== "ladder rung failed") return;
          lines.push({ rung: String(fields.rung), error: String(fields.error) });
        },
      },
    },
    rejections,
  );
  return { lines, scene: result };
}

test("a lane that answered with an error is counted, named, and keeps its links", async () => {
  const rejections = emptyRejections();
  const { lines, scene } = await run(rejections, async () =>
    answer("https://www.eporner.com/api/v2/video/search/ -> HTTP 503"),
  );

  assert.equal(rejections.errored, 1, "an outage is not a clean negative");
  assert.equal(rejections.noMatch, 0, "and the ladder is not told the scene has no video");
  // A partial answer is still an answer: the uploads read before the failure
  // were each verified on their own page, so discarding them loses real work.
  assert.equal(scene.matched, true);
  assert.deepEqual(
    scene.scene.videoUrls.map((link) => link.url),
    [UPLOAD],
  );
  assert.deepEqual(
    lines.map((line) => line.rung),
    ["fc2-eporner"],
    "the lane that failed is named, so it is not filed under another tube's outage",
  );
  assert.match(lines[0]?.error ?? "", /HTTP 503/, "and what it failed on");
});

test("an FC2 answer with no error is not reported as an outage", async () => {
  const rejections = emptyRejections();
  const { lines, scene } = await run(rejections, async () => answer());

  assert.equal(rejections.errored, 0);
  assert.equal(scene.matched, true);
  assert.equal(lines.length, 0, "a successful lookup logs nothing");
});
