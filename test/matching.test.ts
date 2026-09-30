/**
 * The one matching rule, asserted from both sides.
 *
 * The load-bearing behaviours, in the order the rule states them:
 *   - duration band accepts and rejects at the boundary
 *   - the upload window accepts, rejects, and is asymmetric
 *   - an UNKNOWN date is a rejection, never a pass
 *   - identity ORDERS survivors, and a candidate with no identity at all is
 *     still eligible - the case the old identity gate blocked outright
 *   - views break ties within a tier, lag and URL break them after that
 *   - a repost never competes with its own original
 *
 * Every test passes an explicit `dateWindowDays`. There is deliberately no
 * default: the window is half the rule, and a call site that forgets it should
 * be a type error rather than a candidate that silently skips the check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MATCH_DURATION_TOLERANCE_SEC,
  identityTier,
  matchTokens,
  pickMatch,
  parseTimestamp,
  repairMojibake,
  titleStem,
  toIsoUtc,
  withinDateWindow,
  type IdentityTier,
  type PickResult,
  type TubeCandidate,
} from "../src/core/matching.ts";
import { matchEpornerOpen } from "../src/tubes/eporner.ts";
import type { MatchScene } from "../src/tubes/types.ts";

const scene: MatchScene = {
  id: "test:1",
  source: "test",
  sourceId: "test",
  label: "Test",
  title: "Marfe takes it deep",
  performers: ["Marfe okkk"],
  releaseDate: "2026-03-04",
  durationSec: 1418,
};

const WINDOW = { dateWindowDays: 7 };

/** Default candidate: the scene's own title, released on the scene's date. */
const candidate = (over: Partial<TubeCandidate> = {}): TubeCandidate => ({
  title: "Marfe takes it deep",
  duration: 1418,
  url: "https://www.eporner.com/video-abc/",
  uploader: "someone",
  added: "2026-03-05 10:00:00",
  ...over,
});

/**
 * The identity tier a pick actually reported.
 *
 * This used to be `tiers.length`, called as `tierOf([picked.identityTier])` - so
 * the assertion was `1 === 1` and passed no matter what tier came back. It was
 * guarding the ranking chain (the winner here is decided by views, which only
 * matters if both sides are the same tier) while checking nothing at all.
 */
const tierOf = (picked: PickResult | null): IdentityTier | null => picked?.identityTier ?? null;

test("accepts a candidate inside the duration band and the window", () => {
  const picked = pickMatch(scene, [candidate()], WINDOW);
  assert.ok(picked);
  assert.equal(picked.candidate.url, "https://www.eporner.com/video-abc/");
  assert.equal(picked.dateWindowApplied, true);
});

test("duration rejects at the boundary and accepts one second inside it", () => {
  assert.ok(pickMatch(scene, [candidate({ duration: 1420 })], WINDOW), "+2s is inside");
  assert.ok(pickMatch(scene, [candidate({ duration: 1416 })], WINDOW), "-2s is inside");
  assert.equal(pickMatch(scene, [candidate({ duration: 1421 })], WINDOW), null, "+3s is outside");
  assert.equal(pickMatch(scene, [candidate({ duration: 1415 })], WINDOW), null, "-3s is outside");
  assert.equal(MATCH_DURATION_TOLERANCE_SEC, 2);
});

test("a scene with no positive duration can never match, on any rung", () => {
  assert.equal(pickMatch({ ...scene, durationSec: null }, [candidate()], WINDOW), null);
  assert.equal(pickMatch({ ...scene, durationSec: 0 }, [candidate()], WINDOW), null);
});

// --------------------------------------------------------------- date window

test("the window accepts the whole of day +7 and rejects day +8", () => {
  assert.equal(withinDateWindow("2026-03-04", "2026-03-04 00:00:00", 7), true);
  // The bound is in whole calendar days, so the WHOLE of day 7 is inside.
  // A naive `release + 7d` would close at midnight here and silently lose
  // almost a day of window.
  assert.equal(withinDateWindow("2026-03-04", "2026-03-11 00:00:00", 7), true);
  assert.equal(withinDateWindow("2026-03-04", "2026-03-11 23:59:59", 7), true, "+7d is inside");
  assert.equal(withinDateWindow("2026-03-04", "2026-03-12 00:00:00", 7), false, "past +7d");
});

test("the lower bound is asymmetric: one day of pre-release leak is admitted", () => {
  assert.equal(withinDateWindow("2026-03-04", "2026-03-03 12:00:00", 7), true, "-1d is inside");
  assert.equal(withinDateWindow("2026-03-04", "2026-03-02 23:59:59", 7), false, "-2d is outside");
});

test("an unreadable date is UNKNOWN, and unknown is not a pass", () => {
  assert.equal(withinDateWindow("2026-03-04", null, 7), "unknown");
  assert.equal(withinDateWindow("2026-03-04", "not a date", 7), "unknown");
  assert.equal(withinDateWindow("2026-03-04", "", 7), "unknown");
  // An unreadable RELEASE date is equally unplaceable, so it is unknown too.
  assert.equal(withinDateWindow("nonsense", "2026-03-05 10:00:00", 7), "unknown");
});

test("a candidate with no upload date is rejected, not waved through", () => {
  // This is the assertion that would fail if the three-state check were
  // collapsed to a boolean: a candidate that merely has no date is NOT inside
  // the window, it is un-proved.
  assert.equal(pickMatch(scene, [candidate({ added: null })], WINDOW), null);
  assert.equal(pickMatch(scene, [candidate({ added: "garbage" })], WINDOW), null);
});

test("deferring the date half is explicit and is reported back as deferred", () => {
  const picked = pickMatch(scene, [candidate({ added: null })], { dateWindowDays: null });
  assert.ok(picked, "a card with no date can still be RANKED");
  assert.equal(picked.dateWindowApplied, false, "but the result must not read as an admission");
});

test("a zone-less ISO timestamp with sub-seconds is pinned to UTC", () => {
  // The zone-less branch exists because `Date.parse` reads such a value as LOCAL
  // time, which would make the window answer differently on the VPS than on a
  // laptop. A `.500` fraction falls past that branch's regex, so the `Date.parse`
  // fallback is where the host default used to sneak back in.
  const at10 = Date.parse("2026-03-05T10:00:00Z");
  const at10half = Date.parse("2026-03-05T10:00:00.500Z");
  assert.equal(parseTimestamp("2026-03-05T10:00:00.500"), at10half);
  assert.equal(parseTimestamp("2026-03-05T10:00:00"), at10);
  assert.equal(parseTimestamp("2026-03-05 10:00:00"), at10);
  // An explicit offset is honoured, not second-guessed into UTC.
  assert.equal(parseTimestamp("2026-03-05T12:00:00+02:00"), at10);
  assert.equal(parseTimestamp("2026-03-05T10:00:00.000Z"), at10);
  assert.equal(toIsoUtc("2026-03-05 10:00:00"), "2026-03-05T10:00:00.000Z");
  assert.equal(toIsoUtc("2026-03-05T10:00:00.500"), "2026-03-05T10:00:00.500Z");
  // Unrelated shapes are unchanged, including the ones that must stay unparsed.
  assert.equal(parseTimestamp("2026-19-07T10:00:00"), null);
  assert.equal(parseTimestamp("not a date"), null);
});

test("a non-finite tolerance narrows the gate, never disables it", () => {
  // `Math.abs(duration - scene) > NaN` is false, so a NaN tolerance let every
  // candidate through the duration half - the one signal every rung supplies -
  // while the logs still claimed the winner was duration-gated.
  const naive = pickMatch(scene, [candidate({ duration: 999_999 })], {
    ...WINDOW,
    durationToleranceSec: Number.NaN,
  });
  assert.equal(naive, null, "a NaN tolerance must not admit anything");

  const negative = pickMatch(scene, [candidate({ duration: 1419 })], {
    ...WINDOW,
    durationToleranceSec: -5,
  });
  assert.ok(
    negative,
    "a negative tolerance falls back to the measured default band, not to no gate",
  );
  assert.equal(
    pickMatch(scene, [candidate({ duration: 1421 })], { ...WINDOW, durationToleranceSec: -5 }),
    null,
    "and the default band still rejects",
  );

  const zero = pickMatch(scene, [candidate({ duration: 1418 })], {
    ...WINDOW,
    durationToleranceSec: 0,
  });
  assert.ok(zero, "zero is a legitimate tolerance: exact duration only");
  assert.equal(
    pickMatch(scene, [candidate({ duration: 1419 })], { ...WINDOW, durationToleranceSec: 0 }),
    null,
  );
});

test("a title that stems to nothing is not a candidate", () => {
  // Every blank stem hashes to the same key, so blank-titled candidates used to
  // collapse into one group and take the slot - discarding a titled candidate
  // that lost the rank to them.
  assert.equal(titleStem(""), "");
  assert.equal(titleStem("   "), "");
  assert.equal(titleStem("https://example.test/watch?v=1"), "");
  const blank = pickMatch(scene, [candidate({ title: "" })], WINDOW);
  assert.equal(blank, null, "a blank title cannot outrank or occupy a stem slot");
  // And it cannot displace a real candidate either.
  const kept = pickMatch(
    scene,
    [candidate({ title: "", views: 10_000_000 }), candidate({ title: "Marfe takes it deep" })],
    WINDOW,
  );
  assert.ok(kept);
  assert.equal(kept.candidate.title, "Marfe takes it deep");
});

test("an unreadable view count never reorders the ranking", () => {
  // `Number("1.2M")` is NaN, and NaN is falsy - so the views tiebreak was
  // skipped silently, and `Infinity - Infinity` in the next comparison made
  // `rank` return NaN, which `sort` treats as "equal". The survivor then
  // depended on input order.
  const parsed = pickMatch(
    scene,
    [candidate({ views: "1.2M", url: "https://www.eporner.com/video-a/" })],
    WINDOW,
  );
  assert.ok(parsed, "an abbreviated count is still a count");
  // A real count still beats no count: unknown is not zero.
  const ranked = pickMatch(
    scene,
    [
      candidate({
        title: "Marfe takes it deep",
        views: "",
        url: "https://www.eporner.com/video-none/",
      }),
      candidate({
        title: "Marfe takes it deep",
        views: "12,345",
        url: "https://www.eporner.com/video-some/",
      }),
    ],
    WINDOW,
  );
  assert.ok(ranked);
  assert.equal(ranked.candidate.url, "https://www.eporner.com/video-some/");
  // Abbreviations parse in the direction the sources write them.
  assert.equal(
    pickMatch(
      scene,
      [
        candidate({
          title: "Marfe takes it deep",
          views: "2k",
          url: "https://www.eporner.com/video-k/",
        }),
        candidate({
          title: "Marfe takes it deep",
          views: "1500",
          url: "https://www.eporner.com/video-n/",
        }),
      ],
      WINDOW,
    )?.candidate.url,
    "https://www.eporner.com/video-k/",
  );
  // Two undated-but-otherwise-equal candidates must produce a total order, not NaN.
  const settled = pickMatch(
    scene,
    [
      candidate({
        title: "Marfe takes it deep extra",
        views: "1.2M",
        url: "https://www.eporner.com/video-zz/",
      }),
      candidate({
        title: "Marfe takes it deep extra take",
        views: "1.2M",
        url: "https://www.eporner.com/video-aa/",
      }),
    ],
    WINDOW,
  );
  assert.ok(settled);
  assert.equal(
    settled.candidate.url,
    "https://www.eporner.com/video-aa/",
    "URL is the final, always-total tiebreak",
  );
});

// ------------------------------------------------------------- identity tier

test("identity tiers order 3 > 2 > 1 > 0", () => {
  const verbatim = identityTier(scene, "Marfe takes it deep");
  const fullName = identityTier(scene, "Marfe okkk does it deep");
  const firstName = identityTier(scene, "Marfe compilation");
  const nothing = identityTier(scene, "unrelated clip");
  assert.equal(verbatim, 3);
  assert.equal(fullName, 2);
  assert.equal(firstName, 1);
  assert.equal(nothing, 0);
  assert.ok(verbatim > fullName);
  assert.ok(fullName > firstName);
  assert.ok(firstName > nothing);
});

test("a scene code in the title is tier-3 same-phrasing evidence", () => {
  const coded = { ...scene, sceneCode: "MAB-123" };
  assert.equal(identityTier(coded, "MAB-123 some other clip"), 3);
  // With the code absent the title falls back to whatever the performers earn.
  assert.equal(identityTier(coded, "some other clip"), 0);
  // A partial code is not the code: `123` alone must not satisfy `MAB-123`.
  assert.equal(identityTier(coded, "clip 123"), 0);
});

test("the pool's first-name-only retitles still earn tier 1", () => {
  // A multi-token performer reduced to its first name. Under a full-name-only
  // rule this would score 0 and lose to every decoy, which is precisely how
  // the trusted pool's obfuscated retitles would all be excluded.
  const one = { ...scene, performers: ["Lana Rhoades"] };
  assert.equal(identityTier(one, "Lana Rhoades takes it deep"), 2, "full name");
  assert.equal(identityTier(one, "Lana compilation"), 1, "first name only");
  assert.equal(identityTier(one, "unrelated clip"), 0, "nothing");

  // A single-token performer IS a full name, so a title carrying just it is
  // tier 2, not tier 1.
  const five = { ...scene, performers: ["Pennie Laniys", "Wheres Luna", "Emy", "Bamy", "Cherry"] };
  assert.equal(identityTier(five, "Emy"), 2);
  assert.equal(identityTier(five, "Pennie"), 1);
});

test("a candidate with NO identity evidence is still eligible", () => {
  // The case the old identity gate blocked outright. A performer-less or
  // poorly-matched scene used to be unmatchable however obvious its video was.
  const picked = pickMatch(scene, [candidate({ title: "unrelated clip" })], WINDOW);
  assert.ok(picked, "identity ranks, it does not gate");
  assert.equal(picked.identityTier, 0);
  assert.equal(picked.dateWindowApplied, true);
});

test("a scene with no performers still matches, at whatever tier it earns", () => {
  const noPerformers = { ...scene, performers: [] };
  const picked = pickMatch(noPerformers, [candidate()], WINDOW);
  assert.ok(picked);
  assert.equal(picked.identityTier, 3, "the verbatim title still carries it");
});

// -------------------------------------------------------------------- ranking

test("identity outranks views: a named match beats a more popular decoy", () => {
  const decoy = candidate({
    title: "unrelated clip",
    views: 9_000_000,
    url: "https://www.eporner.com/video-decoy/",
  });
  const real = candidate({ title: "Marfe okkk does it deep", views: 12 });
  const picked = pickMatch(scene, [decoy, real], WINDOW);
  assert.ok(picked);
  assert.equal(picked.candidate.url, real.url);
  assert.equal(picked.identityTier, 2);
});

test("views break ties WITHIN a tier", () => {
  const quiet = candidate({
    title: "Marfe okkk quiet take",
    views: 5,
    url: "https://www.eporner.com/video-a/",
  });
  const loud = candidate({
    title: "Marfe okkk loud take",
    views: 5000,
    url: "https://www.eporner.com/video-b/",
  });
  assert.equal(identityTier(scene, quiet.title), 2);
  assert.equal(identityTier(scene, loud.title), 2);
  assert.equal(pickMatch(scene, [quiet, loud], WINDOW)?.candidate.url, loud.url);
});

test("lag then URL break ties left by tier and views", () => {
  const early = candidate({
    added: "2026-03-04 01:00:00",
    url: "https://www.eporner.com/video-z/",
  });
  const late = candidate({ added: "2026-03-10 01:00:00", url: "https://www.eporner.com/video-a/" });
  assert.equal(
    pickMatch(scene, [late, early], WINDOW)?.candidate.url,
    early.url,
    "smaller lag wins",
  );
  // Identical everything but URL: the URL decides, so the order is total.
  const tieA = candidate({ url: "https://www.eporner.com/video-aaa/" });
  const tieB = candidate({ url: "https://www.eporner.com/video-bbb/" });
  assert.equal(pickMatch(scene, [tieB, tieA], WINDOW)?.candidate.url, tieA.url);
});

test("reposts collapse to one representative before ranking", () => {
  const original = candidate({ title: "Marfe takes it deep 0304", views: 10 });
  const repost = candidate({
    title: "Marfe takes it deep 0304 [new]",
    views: 99_999,
    url: "https://www.eporner.com/video-xyz/",
  });
  assert.equal(titleStem(original.title), titleStem(repost.title));
  // One video, one candidate. The group is represented by its best-ranked
  // member, which is the more popular copy - the original gets no privilege,
  // because which copy someone re-uploaded is not a fact about the video.
  const picked = pickMatch(scene, [original, repost], WINDOW);
  assert.ok(picked);
  assert.equal(picked.candidate.url, repost.url);

  // Tier order is what decides across groups, and 3 is the top tier: a
  // verbatim-title match beats a full-performer-name one even on fewer views.
  const named = candidate({
    title: "Marfe okkk does it deep",
    views: 1,
    url: "https://www.eporner.com/video-named/",
  });
  assert.equal(identityTier(scene, named.title), 2);
  assert.equal(identityTier(scene, repost.title), 3);
  assert.equal(pickMatch(scene, [named, repost], WINDOW)?.candidate.url, repost.url);
});

test("distinct stems from different uploaders are now ranked, not rejected", () => {
  // INVERTED from the old rule. Multi-uploader rejection existed to defend the
  // identity gate; with identity demoted to a tiebreak it only threw away
  // correct matches for no gain.
  const a = candidate({ title: "Marfe takes it deep", uploader: "alice", views: 10 });
  const b = candidate({ title: "Marfe takes it deep extra take", uploader: "bob", views: 20 });
  const picked = pickMatch(scene, [a, b], WINDOW);
  assert.ok(picked);
  assert.equal(picked.candidate.url, b.url, "views decide between equal tiers");
  // Both titles contain the scene's own wording, so both are tier 3 and the
  // views tiebreak is what actually picked the winner. Asserting the tier is
  // what makes the previous line mean what it says.
  assert.equal(tierOf(picked), 3, "the scene title appears verbatim in both candidates");
  assert.equal(identityTier(scene, a.title), tierOf(picked));
  assert.equal(identityTier(scene, b.title), tierOf(picked));
});

// ------------------------------------------------------------- open-search rung

test("the open rung applies the same rule as every other rung", () => {
  const video = {
    url: "https://www.eporner.com/video-abc/",
    embed: "https://www.eporner.com/embed/abc/",
    title: "Marfe takes it deep",
    length_sec: 1418,
    added: "2026-03-05 10:00:00",
  };
  assert.ok(matchEpornerOpen(scene, [video], WINDOW));
  // Out of window on this rung exactly as on the pool rung.
  assert.equal(matchEpornerOpen(scene, [{ ...video, added: "2026-04-20 10:00:00" }], WINDOW), null);
  // Out of the duration band, and with no date at all.
  assert.equal(matchEpornerOpen(scene, [{ ...video, length_sec: 1423 }], WINDOW), null);
  assert.equal(matchEpornerOpen(scene, [{ ...video, added: null }], WINDOW), null);
});

// ----------------------------------------------------------------- timestamps

test("a zone-less timestamp is pinned to UTC, not read as local time", () => {
  // `Date.parse("2026-09-29 20:16:35")` reads that as LOCAL time, which would
  // make the window move with the host's TZ and answer differently on the VPS
  // than on a laptop. The explicit parse is what removes that.
  assert.equal(toIsoUtc("2026-09-29 20:16:35"), "2026-09-29T20:16:35.000Z");
  assert.equal(toIsoUtc("2026-09-29T21:39:37+00:00"), "2026-09-29T21:39:37.000Z");
  assert.equal(toIsoUtc("2026-09-29"), "2026-09-29T00:00:00.000Z");
  assert.equal(toIsoUtc(null), null);
  assert.equal(toIsoUtc("nonsense"), null);
});

test("an impossible calendar date is UNKNOWN, never a rolled-over one", () => {
  // `Date.UTC(2026, 18, 7)` does not fail - it returns July 2027. Measured
  // reaching here: a mojibake'd pool card read `2026-19-07`, and that became
  // the trusted pool's MAX(added) watermark, which would freeze the
  // incremental index walk at one page. A wrong date is worse than no date.
  assert.equal(toIsoUtc("2026-19-07"), null, "month 19 does not roll into the next year");
  assert.equal(toIsoUtc("2026-13-01"), null);
  assert.equal(toIsoUtc("2026-00-10"), null);
  assert.equal(toIsoUtc("2026-02-30"), null, "February has no 30th");
  assert.equal(toIsoUtc("2026-04-31"), null, "April has no 31st");
  assert.equal(toIsoUtc("2026-03-32"), null);
  assert.equal(toIsoUtc("2026-02-29 12:00:00"), null, "2026 is not a leap year");
  assert.equal(toIsoUtc("2024-02-29 12:00:00"), "2024-02-29T12:00:00.000Z", "but 2024 is");
  // Time components are range-checked too.
  assert.equal(toIsoUtc("2026-03-04 25:00:00"), null);
  assert.equal(toIsoUtc("2026-03-04 10:61:00"), null);
  // Real dates still work.
  assert.equal(toIsoUtc("2026-03-04"), "2026-03-04T00:00:00.000Z");
  assert.equal(toIsoUtc("2026-12-31"), "2026-12-31T00:00:00.000Z");
});

test("compatibility-glyph titles still tokenise", () => {
  // A live trusted-pool retitle, in mathematical-bold Unicode. NFKC/NFKD must
  // reduce it to plain ASCII or identity would score 0 on every pool title.
  assert.deepEqual(
    matchTokens(
      "\u{1D40F}\u{1D41E}\u{1D42D}\u{1D422}\u{1D42D}\u{1D41E} \u{1D425}\u{1D41A}\u{1D42D}\u{1D422}\u{1D427}\u{1D41A}\u{1D42C} \u{1D430}\u{1D421}\u{1D428}\u{1D42B}\u{1D41E}\u{1D42C} \u{1D40B}\u{1D42E}\u{1D427}\u{1D41A}",
    ),
    ["petite", "latinas", "whores", "luna"],
  );
});

/**
 * Reproduce the wire format: take correct UTF-8 and widen each BYTE into one
 * Latin-1 codepoint, which is exactly what a Latin-1 mis-decode produces.
 *
 * Built in code rather than pasted, because the widened string is mostly
 * invisible C1 control characters and a pasted copy silently loses them - which
 * is how this bug nearly got written off as "the titles are just unreadable".
 */
function mojibake(value: string): string {
  return [...Buffer.from(value, "utf8")].map((byte) => String.fromCharCode(byte)).join("");
}

test("mojibake'd titles are repaired before tokenising", () => {
  // The shape the eporner `video/id` API actually serves for the trusted pool.
  // Without the repair these tokenise to NOTHING and the whole trusted pool
  // scores identity tier 0, leaving the gate ranking on views alone.
  const bold =
    "\u{1D40F}\u{1D41E}\u{1D42D}\u{1D422}\u{1D42D}\u{1D41E} \u{1D425}\u{1D41A}\u{1D42D}\u{1D422}\u{1D427}\u{1D41A}\u{1D42C} \u{1D430}\u{1D421}\u{1D428}\u{1D42B}\u{1D41E}\u{1D42C} \u{1D40B}\u{1D42E}\u{1D427}\u{1D41A}, \u{1D404}\u{1D426}\u{1D432}, \u{1D412}\u{1D41A}\u{1D426}, \u{1D401}\u{1D41A}\u{1D41B}\u{1D432} & \u{1D402}\u{1D421}\u{1D41E}\u{1D42B}\u{1D42B}\u{1D432}";
  const wire = mojibake(bold);
  assert.notEqual(wire, bold, "the wire form really is mangled");
  assert.deepEqual(matchTokens(wire), [
    "petite",
    "latinas",
    "whores",
    "luna",
    "emy",
    "sam",
    "baby",
    "cherry",
  ]);
  assert.deepEqual(matchTokens(bold), matchTokens(wire), "both forms agree after repair");

  // And the repaired title now carries identity, which is the whole point.
  const scene = {
    title: "x",
    performers: ["Luna White"],
    releaseDate: "2026-03-04",
    durationSec: 10,
  };
  assert.equal(identityTier(scene, wire), 1, "Luna is present in the repaired title");
  assert.equal(identityTier(scene, bold), 1, "and in the decoded form");
});

test("the mojibake repair never corrupts text that was not mis-decoded", () => {
  // ASCII is untouched.
  assert.equal(repairMojibake("Bem No Fundo Da Bunda"), "Bem No Fundo Da Bunda");
  // Genuine Latin-1 text (e-acute held as U+00E9) is NOT valid UTF-8 once
  // round-tripped, so it must be returned exactly as it was.
  assert.equal(repairMojibake("café"), "café");
  // Text mixing mojibake with a real character outside Latin-1 is left alone
  // rather than half-repaired.
  assert.equal(repairMojibake("café ð"), "café ð");
  // Already-correct bold text is not a Latin-1 mis-decode and is left alone.
  const bold = "𝐏𝐞𝐭𝐢𝐭𝐞";
  assert.equal(repairMojibake(bold), bold);
  assert.deepEqual(matchTokens(null), []);
});

// ------------------------------------------------------------- total ordering

/**
 * `pickMatch` has no exported comparator, so a total order is only observable
 * through its two call sites: the final `sort`, and the stem-collapse
 * `rank(...) < 0` that decides which member of a group survives. Both are
 * driven by input order through `Array.prototype.sort`, so a comparator that is
 * not transitive makes the winner depend on the order the candidates arrived in.
 *
 * `dateWindowDays: null` throughout, and deliberately so: the window rejects an
 * UNKNOWN date outright, so with the window on, the un-dated candidate is
 * filtered out before it ever reaches the comparator and the whole point is
 * untestable. The window-off call is a real one (`gatherPoolSurvivors` uses it)
 * and it is where the ordering actually has to hold.
 */
const UNWINDOWED = { dateWindowDays: null } as const;

test("the winner does not depend on input order", () => {
  // A is the tightest lag (1 day), B has no date at all, C is the loosest (5
  // days). The URLs are ordered so the URL tiebreak OPPOSES the lag order -
  // that is what makes the case discriminating rather than incidental.
  const a = candidate({
    title: "Marfe takes it deep",
    added: "2026-03-05 00:00:00",
    url: "https://www.eporner.com/video-zzzz/",
  });
  const b = candidate({
    title: "Marfe takes it deep again",
    added: null,
    url: "https://www.eporner.com/video-aaaa/",
  });
  const c = candidate({
    title: "Marfe takes it deep tonight",
    added: "2026-03-09 00:00:00",
    url: "https://www.eporner.com/video-mmmm/",
  });

  const permutations: TubeCandidate[][] = [
    [a, b, c],
    [a, c, b],
    [b, a, c],
    [b, c, a],
    [c, a, b],
    [c, b, a],
  ];
  const winners = permutations.map(
    (order) => pickMatch(scene, order, UNWINDOWED)?.candidate.url ?? null,
  );
  assert.equal(
    new Set(winners).size,
    1,
    `every input order must agree on the winner, got ${JSON.stringify(winners)}`,
  );
  // And the winner is the tightest LAG, not the alphabetically first URL. The
  // old both-finite guard made B win on its URL alone, so a candidate the source
  // could not date beat one it dated to within a day - the exact inversion the
  // guard's comment claimed to prevent.
  assert.equal(
    winners[0],
    a.url,
    "a finite lag beats no lag, and the smallest finite lag beats the larger one",
  );
});

test("the stem collapse keeps the tighter lag, not the first-seen member", () => {
  // The second call site: within one stem the same order decides the survivor.
  // A repost and its original collapse to a single candidate, so a comparator
  // that ranks the un-dated one first keeps it and discards the dated one.
  const undated = candidate({
    title: "Marfe takes it deep 0304",
    added: null,
    url: "https://www.eporner.com/video-aaaa/",
  });
  const dated = candidate({
    title: "Marfe takes it deep 0304 [new]",
    added: "2026-03-05 00:00:00",
    url: "https://www.eporner.com/video-zzzz/",
  });
  assert.equal(titleStem(undated.title), titleStem(dated.title), "one stem, two members");
  for (const order of [
    [undated, dated],
    [dated, undated],
  ]) {
    assert.equal(
      pickMatch(scene, order, UNWINDOWED)?.candidate.url,
      dated.url,
      "the dated member wins the stem regardless of which arrived first",
    );
  }
});
