import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogueCoverage } from "../src/core/catalogue-coverage.ts";

const record = (id: string, extra = {}) => ({
  id,
  title: "A long afternoon with Jane",
  releaseDate: "2026-09-04",
  durationSec: 2954,
  ...extra,
});

test("four-provider coverage includes ManyVids and retains conflicting original metadata", () => {
  const report = catalogueCoverage({
    tpdb: [record("tp-1")],
    stashdb: [record("stash-1", { releaseDate: "2026-09-05" })],
    traxxx: [],
    manyvids: [
      record("mv-1", { title: "A long afternoon with Jane!", durationSec: 2957 }),
      record("mv-2", { title: "Different release" }),
    ],
  });
  assert.equal(report.unionCount, 2);
  assert.deepEqual(report.providers.manyvids, {
    available: true,
    records: 2,
    covered: 2,
    coverage: 1,
  });
  assert.equal(report.providers.tpdb.coverage, 0.5);
  assert.equal(report.groups[0]!.length, 3);
  assert.equal(report.groups[0]![1]!.releaseDate, "2026-09-05");
  assert.equal(report.groups[0]![2]!.durationSec, 2957);
});

test("fuzzy title evidence needs a close date and runtime; duration alone never merges scenes", () => {
  const report = catalogueCoverage({
    tpdb: [record("1")],
    manyvids: [
      record("2", { title: "A long afternoon with lovely Jane" }),
      record("3", { title: "Something entirely different" }),
      record("4", { releaseDate: "2026-09-07" }),
      record("5", { durationSec: 2960 }),
    ],
  });
  assert.equal(report.unionCount, 4);
  assert.equal(report.groups.filter((g) => g.length === 2).length, 1);
  assert.equal(report.providers.stashdb.available, false);
  assert.equal(report.providers.traxxx.coverage, null);
});

test("ambiguous same-provider candidates remain separate instead of arbitrarily choosing a match", () => {
  const report = catalogueCoverage({ tpdb: [record("1"), record("2")], manyvids: [record("3")] });
  assert.equal(report.unionCount, 3);
  assert.equal(report.ambiguousPairs, 2);
});

test("non-transitive date chains do not collapse releases more than two days apart", () => {
  const report = catalogueCoverage({
    tpdb: [record("1")],
    stashdb: [record("2", { releaseDate: "2026-09-06" })],
    manyvids: [record("3", { releaseDate: "2026-09-08" })],
  });
  assert.equal(report.unionCount, 2);
});

test("missing duration or empty titles cannot establish cross-provider identity", () => {
  const report = catalogueCoverage({
    tpdb: [record("1", { durationSec: null })],
    manyvids: [record("2")],
  });
  assert.equal(report.unionCount, 2);
  assert.throws(() => catalogueCoverage({ tpdb: [record("x", { title: "" })] }), /title/);
  assert.throws(
    () => catalogueCoverage({ tpdb: [record("x", { releaseDate: "2026-02-30" })] }),
    /calendar/,
  );
});

test("coverage is deterministic across input order and empty coverage is unknown", () => {
  const first = record("1");
  const second = record("2", { title: "Different release" });
  assert.deepEqual(
    catalogueCoverage({ manyvids: [first, second] }),
    catalogueCoverage({ manyvids: [second, first] }),
  );
  assert.equal(catalogueCoverage({ manyvids: [] }).providers.manyvids.coverage, null);
});
