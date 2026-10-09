/**
 * The one matching rule, applied to every scene in the catalogue regardless of
 * source. Pure: no network, no clock, no storage - which is what makes the
 * golden-corpus calibration harness possible.
 *
 *   ELIGIBILITY. A candidate is eligible when BOTH hold:
 *     1. duration within `LISZT_MATCH_DURATION_TOLERANCE_SEC` (default 1s)
 *     2. upload date within the window `release - 1 day` .. `release + N days`
 *     3. under `requireIdentity`, some surviving stem group names the scene
 *
 *   RANKING. Zero survivors -> the rung found nothing. One -> link it. Several
 *     -> collapse same-video reposts by title stem, then order by:
 *     1. identity tier (see `identityTier`)
 *     2. highest view count
 *     3. smallest upload-date lag
 *     4. URL, purely so the order is total
 *
 * IDENTITY IS A GATE FIRST AND A RANKING SIGNAL SECOND. This is the
 * load-bearing decision, and it was measured rather than argued.
 *
 * The previous version of this file said the opposite - identity ranks, never
 * gates - on the reasoning that a gate had once cost real links. That
 * measurement, over the 46 links the live service held on 2026-09-30:
 *
 *   - 36 of 46 links (78%) had a winner with NO identity evidence, selected on
 *     view count or upload proximity. Read by hand they are not near misses:
 *     a 1847s scene for Vivian Fernandes linked to a 1845s video titled
 *     "Aceita Dupla Penetracao".
 *   - The remaining 10, whose winners name the performer, are all correct.
 *
 * So the "tiebreak costs nothing and removes nearly all decoy exposure" claim
 * did not hold: identity as a tiebreak removed none of these, because 78% of
 * winners had nothing to be ranked on. `requireIdentity` restores the gate at
 * the point where the cheap filters have already cut the set down, and the
 * hierarchy in `tubes/resolve.ts` turns a gated no-match into "try the next
 * tube" rather than "give up".
 *
 * The residual risk is named rather than hidden: a gated no-match is a MISSING
 * high-confidence link, and the measured cost is stated - over the 115
 * linkable scenes in the calibration corpus, only 7 had any earlier Eporner index
 * candidate whose title named the performer at all. The terminal fallback now
 * keeps date-and-duration survivors from every tube available as visibly low
 * confidence links, rather than silently dropping every scene outside those 7.
 *
 * THE MMDD PROXY IS GONE. `mmddCode` / `hasDateEvidence` / the
 * `LISZT_POOL_REQUIRE_DATE_EVIDENCE` knob existed only to make identity
 * stricter. They measured as completely inert besides - the earlier Eporner index's
 * retitles carry no date code at all - and date already has its own upload
 * window filter. Identity is now a gate again, but that does not make a date
 * token an identity signal.
 *
 * THE FALSIFIED STAGES ARE STILL ABSENT and must not be re-added: studio-in-
 * title, thumbnail similarity, tag-based search, and fuzzy title similarity.
 * Duration and date are filters, never evidence of a match; identity gates a
 * high-confidence result and ranks the named survivors. Only the explicit
 * terminal fallback may use views after no tube produced a named result.
 */
const DECORATION_WORDS = new Set(["new", "watch", "download"]);

const DAY_MS = 86_400_000;

/**
 * Undo a UTF-8 payload that was decoded as Latin-1 on its way to us.
 *
 * MEASURED, NOT SPECULATIVE. The eporner profile listings decode cleanly, but
 * the `video/id` records for the earlier Eporner index store their titles mojibake'd: a
 * mathematical-bold title arrives as the literal characters `ð`, U+009D, U+0090
 * and so on - which are the original UTF-8 bytes F0 9D 90 8B (= U+1D40B, `𝐀`)
 * each widened into one Latin-1 codepoint. A live record read
 * `ðð¢­ð¥ð ð¥ð­ð¢§ð¬ ð°ð¡ð«ð ððð ðððð£ð` and this
 * function returns `𝐏𝐞𝐭𝐢𝐭𝐞 𝐥𝐚𝐧𝐢𝐲𝐬 𝐰𝐡𝐨𝐱𝐞𝐬 𝐋𝐮𝐧𝐚, 𝐄𝐦𝐲, 𝐒𝐚𝐦, 𝐁𝐚𝐛𝐲 & 𝐂𝐡𝐞𝐫𝐫𝐲`.
 *
 * Without this the entire earlier Eporner index is unreadable to `matchTokens`: NFKC on
 * `ð` yields `ð`, not `p`, so every performer name scores zero identity and the
 * gate degenerates to ranking on views alone. That is precisely the decoy path,
 * and a live calibration measured 20 of 22 pool winners at tier 0 before this
 * was added.
 *
 * The repair is applied conservatively, because the alternative - mangling a
 * legitimate title - would be worse than the bug:
 *  - ASCII-only strings short-circuit, so the common case is untouched.
 *  - The round-trip must decode as STRICT UTF-8. Genuine Latin-1 text such as
 *    `café` held as U+00E9 produces an invalid byte and is returned unchanged.
 *  - A string that mixes mojibake with a real character outside Latin-1 also
 *    fails the strict decode, and is returned unchanged.
 */
export function repairMojibake(value: string | null | undefined): string {
  const text = String(value ?? "");
  // The signature of a Latin-1 mis-decode: high bytes or C1 controls. Anything
  // outside that range has nothing to repair and must not be round-tripped.
  if (!/[\u0080-\u00ff]/.test(text)) return text;
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    // Codepoints above Latin-1 cannot be one widened byte, so this is not a
    // Latin-1 mis-decode and repairing it would corrupt real text.
    if (code > 0xff) return text;
    bytes[index] = code;
  }
  try {
    // `fatal` makes an invalid sequence throw instead of yielding U+FFFD, so a
    // genuine-Latin-1 string is rejected rather than silently corrupted.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return text;
  }
}

/** Normalise tube text without losing characters represented by compatibility glyphs. */
export function matchTokens(value: string | null | undefined): string[] {
  return (
    repairMojibake(value)
      .normalize("NFKC")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  );
}

export function normalizedText(value: string | null | undefined): string {
  return matchTokens(value).join(" ");
}

/**
 * Build an epoch from calendar components, or null if they are not a real date.
 *
 * `Date.UTC` ROLLOVER is the trap this exists to close. Given month 19 it does
 * not fail - it returns July of the following year. That is the worst possible
 * failure for a date used as evidence: the value looks valid, so a garbage row
 * gets a confident wrong date instead of being honestly unknown.
 *
 * Measured reaching here: the mojibake'd pool titles contain digit runs that
 * parse as `2026-19-07`, which `Date.UTC` turned into `2027-07-07` - and that
 * became the earlier Eporner index's `MAX(added)` watermark, which would have frozen the
 * incremental index walk at one page. Round-tripping the components back out
 * rejects any rollover.
 */
export function calendarDateUtc(year: number, month: number, day: number): number | null {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year) return null;
  if (date.getUTCMonth() + 1 !== month) return null;
  if (date.getUTCDate() !== day) return null;
  return time;
}

/** True when the text already carries an explicit UTC offset or zone marker. */
function hasZoneDesignator(text: string): boolean {
  return /(?:Z|z|[+-]\d{2}:?\d{2})$/.test(text.trim());
}

/**
 * Parse a timestamp to epoch milliseconds, or null.
 *
 * Deliberately NOT `Date.parse`. Two reasons, both load-bearing:
 *
 *  - eporner serves `added` as `YYYY-MM-DD HH:MM:SS` with no zone marker. The
 *    legacy parser reads that as LOCAL time, which would make the window return
 *    different answers on the VPS than on a laptop - the window would move with
 *    the host's `TZ`. It is pinned to UTC here instead. The true zone is not
 *    knowable from the payload, and a +-2h ambiguity is comfortably inside the
 *    window's 1-day negative margin, so determinism is the property that pays.
 *  - sxyprn serves ISO 8601 WITH an offset, which `Date.parse` handles correctly
 *    and which must not be second-guessed into a different zone.
 *
 * An unparseable value is null. It is never coerced to a default, because
 * "unknown" and "the epoch" are opposite answers to the window's question.
 */
export function parseTimestamp(value: string | null | undefined): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const zoneless = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (zoneless) {
    const day = calendarDateUtc(Number(zoneless[1]), Number(zoneless[2]), Number(zoneless[3]));
    if (day === null) return null;
    const hour = Number(zoneless[4]);
    const minute = Number(zoneless[5]);
    const second = Number(zoneless[6] ?? 0);
    if (hour > 23 || minute > 59 || second > 59) return null;
    return day + hour * 3_600_000 + minute * 60_000 + second * 1000;
  }
  const dayOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dayOnly) return calendarDateUtc(Number(dayOnly[1]), Number(dayOnly[2]), Number(dayOnly[3]));
  // The `Date.parse` fallback, with one correction. For an ISO-8601 date-time
  // that carries no offset - `2024-05-03T11:20:00.500`, a sub-second form the
  // regex above does not cover - the spec says the value is LOCAL time. The
  // zone-less branch above exists precisely because a local reading would make
  // the window answer differently on the VPS than on a laptop, so the fallback
  // must not reintroduce it: a zone-less ISO value is pinned to UTC first, and
  // only a value that still will not parse falls through to the host default.
  if (!hasZoneDesignator(text) && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) {
    const pinned = Date.parse(`${text}Z`);
    if (Number.isFinite(pinned)) return pinned;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalise a timestamp to ISO 8601 UTC, or null when it cannot be read.
 *
 * Applied at every write boundary that persists an upload date, so the
 * `pool_videos.added` column holds one lexicographically comparable shape. The
 * index window query is a TEXT range scan, and `...T20:16:35Z` does not sort
 * against `... 20:16:35` the way it looks like it should.
 */
export function toIsoUtc(value: string | null | undefined): string | null {
  const parsed = parseTimestamp(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

export interface SceneIdentity {
  title: string;
  performers: string[];
  releaseDate: string;
  durationSec: number | null;
  durationRange?: { minSec: number; maxSec: number };
  durationReview?: boolean;
  /** Scene-code retrieval hint, e.g. Mambo Perv's OB codes. */
  sceneCode?: string | null;
}

export interface TubeCandidate {
  title: string;
  duration?: number | string | null;
  url?: string;
  uploader?: unknown;
  user?: unknown;
  author?: unknown;
  username?: unknown;
  views?: number | string | null;
  added?: string | null;
}

/** How much the candidate title actually identifies the scene. Higher wins. */
export type IdentityTier = 0 | 1 | 2 | 3;

/**
 * Identity, as an ordered tier rather than a pass/fail.
 *
 *  - `3` the scene title appears verbatim in the candidate title, or the scene
 *      code does. Both are same-phrasing evidence: someone reused the studio's
 *      own wording.
 *  - `2` a full performer name is present, every token of it. Studio-intent
 *      evidence: the uploader named the cast.
 *  - `1` only the first token of a performer is present. This tier earns its
 *      place because the earlier Eporner index's retitles carry only first names for
 *      multi-performer scenes - one live title read
 *      `Pennie Laniys Wheres Luna, Emy, Bamy & Cherry` for a five-performer
 *      scene - so a tier-2-only rule would score the whole earlier Eporner index at 0.
 *  - `0` nothing. The candidate is still ELIGIBLE; it simply has the weakest
 *      claim, and wins only when nothing better survives.
 *
 * A scene with no performers is a legal input: it tops out at tier 3 and
 * carries one fewer ranking signal, which is the intended behaviour.
 */
export function identityTier(scene: SceneIdentity, title: string): IdentityTier {
  const candidateTokens = matchTokens(title);
  const candidate = new Set(candidateTokens);
  const joined = ` ${candidateTokens.join(" ")} `;

  const sceneTitle = normalizedText(scene.title);
  if (sceneTitle.length > 0 && joined.includes(` ${sceneTitle} `)) return 3;

  const code = matchTokens(scene.sceneCode);
  if (code.length > 0 && code.every((token) => candidate.has(token))) return 3;

  let best: IdentityTier = 0;
  for (const name of scene.performers) {
    const tokens = matchTokens(name);
    if (!tokens.length) continue;
    if (tokens.every((token) => candidate.has(token))) return 2;
    // `Vovick0301` style: the name glued to a date code as one token.
    const first = tokens[0] as string;
    if (
      best < 1 &&
      (candidate.has(first) ||
        candidateTokens.some((token) => new RegExp(`^${first}\\d{3,4}$`).test(token)))
    ) {
      best = 1;
    }
  }
  return best;
}

/**
 * The date half of the gate, as a THREE-state answer.
 *
 * `"unknown"` exists so a caller cannot collapse "no date" into "no problem"
 * by accident. An un-dated candidate is NOT admissible: it has to be inside
 * the window, not merely un-disproved. Collapsing the two states would let a
 * rung that cannot supply dates at all pass everything, which is the exact
 * opposite of what the third state is warning about.
 */
export type DateCheck = true | false | "unknown";

/**
 * Is `added` inside the upload window for `releaseDate`?
 *
 * Asymmetric on purpose: `release - 1 day` to `release + windowDays`, inclusive
 * at both ends. The negative margin is for pre-release leaks, which happen and
 * which a `release + 0` lower bound would reject.
 *
 * The release date is date-only and is read as UTC midnight; the upload date is
 * a full timestamp. That asymmetry is what the two bounds below compensate for,
 * and getting it wrong costs almost a whole day of window:
 *
 *  - The lower bound is `release - 1 day` INCLUSIVE. From midnight that is the
 *    exact start of the previous day, so the whole previous day is admitted.
 *  - The upper bound is `release + (windowDays + 1) days` EXCLUSIVE. A naive
 *    `release + windowDays` would close the window at midnight on day 7 and
 *    reject every upload from the rest of that day - so `WINDOW_DAYS=7` would
 *    really admit 6 days and change, and the lag histogram would show the
 *    spike one day earlier than the configuration claims.
 *
 * Both bounds are therefore expressed in whole calendar days, which is the unit
 * the knob is named in.
 *
 * `"unknown"` covers both an unreadable upload date and an unreadable release
 * date - neither can be placed relative to the other.
 */
export function withinDateWindow(
  releaseDate: string,
  added: string | null | undefined,
  windowDays: number,
): DateCheck {
  const release = parseTimestamp(releaseDate);
  if (release === null) return "unknown";
  const uploaded = parseTimestamp(added);
  if (uploaded === null) return "unknown";
  return uploaded >= release - DAY_MS && uploaded < release + (windowDays + 1) * DAY_MS;
}

/** Remove common repost wrappers while retaining words which carry scene identity. */
export function titleStem(value: string | null | undefined): string {
  const withoutUrls = String(value || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\{(?:new|watch\/?download:)[^}]*\}/gi, " ")
    .replace(/(?:\s+#[\p{L}\p{N}_-]+)+\s*$/u, " ")
    .replace(/\b(?:19|20)\d{2}[-/. ]\d{1,2}[-/. ]\d{1,2}\b/g, " ")
    .replace(/\b\d{2}[-/. ](?:0?[1-9]|1[0-2])[-/. ](?:0?[1-9]|[12]\d|3[01])\b/g, " ");
  return matchTokens(withoutUrls)
    .filter((token) => !DECORATION_WORDS.has(token))
    .join(" ");
}

/**
 * The default duration tolerance.
 *
 * MEASURED OVER THE LINKS THAT EXISTED, not chosen. On 2026-09-30 the live
 * service held 46 links; the winner's duration was compared against the scene's
 * for every one of them, reading `length_sec` back from eporner:
 *
 *   | 0s | 1s | 2s |
 *   | -- | -- | -- |
 *   | 26 |  9 | 11 |
 *
 * That distribution is only interesting with one more column, so the same 46
 * were cross-tabulated against whether the winner's title names the performer:
 *
 *   | delta | links | identity evidence |
 *   | ----- | ----- | ----------------- |
 *   |   0s  |   26  |  10 named, 16 not |
 *   |   1s  |    9  |   0 named         |
 *   |   2s  |   11  |   0 named         |
 *
 * Every link carrying identity evidence sits at exactly 0s, and every link
 * sitting at 1s or more carries none. Reading those 20 by hand, all of them are
 * the wrong video - not a near miss, a different film with a similar running
 * time. The reported bug is in that group: a 1847s scene linked to a 1845s
 * video, admitted because the comparison was `> tolerance` and 2 > 2 is false.
 *
 * So the choice is not a trade-off. Dropping 2s to 1s removes 20 wrong-video
 * winners on this corpus and 0 correct ones, and the correctness argument does
 * not depend on the tolerance at all - see `requireIdentity` below, which is what
 * actually excludes a decoy.
 *
 * WHAT WOULD OVERTURN IT. The evidence is 10 proven links, not 46, because the
 * other 36 are unproven rather than known-bad. A true pair that drifts 2s or
 * more would lose its link here; the direction of that error is a missing link
 * rather than a wrong one, which is why 1s is taken even though 0s would score
 * identically on this corpus. `.env.example` justified the old value with a
 * single pair reading 2407s against 2408s, but nothing in this corpus
 * corroborates it: all nine of the 1s links here are decoys, so that pair is
 * more likely itself a decoy pair than a measurement of re-encode drift.
 */
export const MATCH_DURATION_TOLERANCE_SEC = 1;

/**
 * The tolerance to actually apply.
 *
 * A caller-supplied tolerance reaches this from configuration, and a
 * non-finite or negative one is not a stricter gate - it is a DISABLED one.
 * `Math.abs(duration - scene) > NaN` is false, so every candidate passes the
 * duration half, and the "duration is the one signal every rung can supply"
 * invariant quietly stops holding while the logs still say a match was
 * duration-gated. Falling back to the measured default is the safe direction:
 * a misconfigured tolerance narrows the gate instead of removing it.
 */
function resolveTolerance(value: number | undefined): number {
  if (value === undefined) return MATCH_DURATION_TOLERANCE_SEC;
  return Number.isFinite(value) && value >= 0 ? value : MATCH_DURATION_TOLERANCE_SEC;
}

export interface PickOptions {
  /** Duration tolerance. Defaults to `MATCH_DURATION_TOLERANCE_SEC`. */
  durationToleranceSec?: number;
  /**
   * The upload window, or `null`.
   *
   * `null` means the date half is NOT TESTABLE AT THIS STAGE and the result is
   * not an admission. Exactly one caller needs it: the sxyprn rung ranks search
   * cards before it has fetched the posts, and a card carries only a relative
   * label like `21 hours ago`, never a real date. The sxyprn rung re-gates with
   * the real window on the verified post detail, which is the pass that admits.
   * The flag is reported back on the result as `dateWindowApplied` so a
   * deferred pass can never be mistaken for an admission.
   */
  dateWindowDays: number | null;
  /**
   * Refuse to return a winner that no surviving stem group can name.
   *
   * THE GATE, AND WHY IT IS REINTRODUCED HERE. This module used to document the
   * opposite decision on purpose - "there is deliberately no identity gate" -
   * because identity had been demoted to a tiebreak and an earlier gate had cost
   * real links. That reasoning was sound on the evidence available then, and the
   * evidence has since changed.
   *
   * MEASURED, 2026-09-30, over the 46 links the live service held: 36 of 46 -
   * 78% - were `confidence: "low"`, meaning the winner carried no identity
   * evidence at all and was chosen on views or upload proximity. Reading them by
   * hand, they are not near misses. They are different videos that happen to
   * share a running time: a 1847s Brazilian scene linked to a 1845s video
   * titled "Aceita Dupla Penetracao", a 2806s scene for a performer named Mia
   * Walker linked to "Bem No Fundo Da Bunda". All ten links that DID name the
   * performer are correct.
   *
   * So the cost of dropping identity-as-ranking-signal was not a few lost links.
   * It was 36 confident-looking wrong URLs, and the "a first-name-only match is
   * a real match" comment above sat on top of a rule that had stopped
   * discriminating. The position is different from the gate that was removed:
   * that one filtered candidates DURING selection, where a performer-less scene
   * could never match at all. This one runs AFTER date and duration narrowing,
   * on the small set that survived, and returns `no-match` so the LADDER can
   * move on - which is what a sparse identity signal needs. It gates the answer,
   * not the question.
   *
   * A performer-less scene is NOT excluded by this: with no performers and no
   * scene code, every candidate scores tier 0, so the gate returns no-match for
   * a scene whose video could not have been named anyway. The ladder, not this
   * flag, is where a performer-less scene is decided: if no tube can name it,
   * the terminal fallback may still link its most-viewed eligible survivor and
   * mark it `low`.
   */
  requireIdentity?: boolean;
}

export interface PickResult {
  candidate: TubeCandidate;
  /** The winner's identity tier, for ranking provenance and confidence. */
  identityTier: IdentityTier;
  /** False when the date half was deferred; see `PickOptions.dateWindowDays`. */
  dateWindowApplied: boolean;
}

type Scored = { candidate: TubeCandidate; tier: IdentityTier; lag: number };

/**
 * A comparable view count, or null when the source did not give a real number.
 *
 * Sources render views in every shape imaginable - `"1.2M"`, `"12,345 views"`,
 * `""` - and `Number()` turns those into `NaN`. `NaN` is the worst value to
 * carry into a comparator: it is falsy, so an `if (views)` guard silently skips
 * the tiebreak, and it poisons the NEXT comparison in the chain
 * (`Infinity - Infinity` is `NaN` too, so an un-dated pair returns `NaN` from
 * `rank` and `Array.prototype.sort` treats that as "equal" - the survivor of a
 * stem group then depends on input order rather than on the ranking). So the
 * value is normalised once, here, and an unreadable count becomes `null` -
 * which the comparator ranks BELOW any real count instead of collapsing to a
 * number that happens to be undefined.
 */
function viewCount(candidate: TubeCandidate): number | null {
  const raw = candidate.views;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  // Strip grouping separators and any trailing unit word, then require digits.
  const digits = raw.replace(/[,\s]/g, "").replace(/(?:views?|k|m)$/i, "");
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  // `1.2M` / `12k` shorthand, which several sources use.
  const suffix = /(k|m)$/i.exec(raw.trim());
  if (suffix) return value * (/^m$/i.test(suffix[1] as string) ? 1_000_000 : 1_000);
  return value;
}

/**
 * Pick the largest known view count, with a stable URL tie-break.
 *
 * This is intentionally NOT `pickMatch`: the terminal fallback runs only after
 * every identity-gated rung declined, and its rule is explicitly views-first
 * across the survivors from ALL tubes. Re-applying identity-tier ranking here
 * would quietly turn the fallback back into a named match and let an older,
 * lower-view candidate win. Unknown counts rank below any real count; when all
 * counts are unknown, URL order makes the result deterministic.
 */
export function pickHighestViews(candidates: readonly TubeCandidate[]): TubeCandidate | null {
  let best: TubeCandidate | null = null;
  let bestViews: number | null = null;
  for (const candidate of candidates) {
    const views = viewCount(candidate);
    if (best === null) {
      best = candidate;
      bestViews = views;
      continue;
    }
    const wins =
      (views !== null && bestViews === null) ||
      (views !== null && bestViews !== null && views > bestViews) ||
      (views === bestViews &&
        String(candidate.url ?? "").localeCompare(String(best.url ?? "")) < 0);
    if (wins) {
      best = candidate;
      bestViews = views;
    }
  }
  return best;
}

/** The tiebreak chain: identity tier, then views, then lag, then URL. */
function rank(scene: SceneIdentity, left: Scored, right: Scored): number {
  if (left.tier !== right.tier) return right.tier - left.tier;
  const leftViews = viewCount(left.candidate);
  const rightViews = viewCount(right.candidate);
  // Documented view evidence beats none: a candidate the source counted
  // outranks one the source said nothing about, rather than the pair falling
  // through to a URL comparison. `rank` is negative when LEFT is better, so the
  // side with no count is the one that loses. Two candidates with no count are
  // genuinely un-ordered on this signal, so the chain continues.
  if (leftViews !== rightViews) {
    if (leftViews === null) return 1;
    if (rightViews === null) return -1;
    return rightViews - leftViews;
  }
  // Lag, and this comparator MUST BE A TOTAL ORDER - `sort` and the stem
  // collapse both depend on it. The old guard required BOTH lags to be finite,
  // so a dated-versus-un-dated pair fell through to the URL tiebreak even though
  // a finite lag is strictly smaller than `Infinity`. That is not just "the wrong
  // winner", it is a non-transitive one: with A (lag 1d, url `.../a`), B
  // (un-dated, url `.../b`) and C (lag 5d, url `.../c`) the old chain gave
  // A < B and C < B by URL but B < C by lag, so the winner depended on input
  // order. `lag` is assigned above as either `Infinity` or a finite difference
  // and is never `NaN`, so `!==` alone is enough: `finite - Infinity` is
  // `-Infinity` (negative - the dated side wins, which is the intent) and the
  // guard already excludes `Infinity - Infinity`.
  if (left.lag !== right.lag) return left.lag - right.lag;
  return String(left.candidate.url || "").localeCompare(String(right.candidate.url || ""));
}

/** Rank already date- and duration-filtered candidates from multiple sources. */
export function rankMatchedCandidates(
  scene: SceneIdentity,
  candidates: readonly { candidate: TubeCandidate; identityTier: IdentityTier }[],
): Array<{ candidate: TubeCandidate; identityTier: IdentityTier }> {
  const release = parseTimestamp(scene.releaseDate);
  const bestByStem = new Map<string, Scored>();
  for (const { candidate, identityTier: tier } of candidates) {
    const stem = titleStem(candidate.title);
    if (!stem || tier <= 0) continue;
    const uploaded = parseTimestamp(candidate.added);
    const scored: Scored = {
      candidate,
      tier,
      lag: release === null || uploaded === null ? Number.POSITIVE_INFINITY : uploaded - release,
    };
    const current = bestByStem.get(stem);
    if (!current || rank(scene, scored, current) < 0) bestByStem.set(stem, scored);
  }
  return [...bestByStem.values()]
    .sort((left, right) => rank(scene, left, right))
    .map(({ candidate, tier }) => ({ candidate, identityTier: tier }));
}

/**
 * Filter by duration and upload date, then rank what survives.
 *
 * Two structural rules are load-bearing:
 *
 *  - Accepted candidates collapse by title stem BEFORE ranking, so a repost and
 *    its original are one candidate and a video never competes with itself.
 *    Within a stem the same order picks the survivor, so the collapse cannot
 *    promote a worse-ranked member of a group.
 *  - A scene with no positive duration is never matched, on any rung. Duration
 *    is the one signal every rung can supply.
 *
 *  - A candidate whose title stems to NOTHING is not a candidate. Every such
 *    title hashes to the same empty key, so they would collapse into one stem
 *    group and one of them - whichever the comparator happened to prefer -
 *    would take the group's slot. Worse, a titled candidate that loses the
 *    rank to a blank one is then discarded with it. The gate can still measure
 *    duration and date without a title, so the honest outcome is "this rung
 *    cannot rank it", which is what returning null for the stem expresses.
 *
 * There is deliberately no multi-uploader rejection. A single uploader, though,
 * is no longer enough: under `requireIdentity` a rung may only link a candidate
 * whose title identifies the scene, and returns no-match otherwise so the ladder
 * can move to the next tube. See `PickOptions.requireIdentity` for the
 * measurement behind that and for why it is a different gate from the one this
 * comment used to describe.
 */
export function pickMatch(
  scene: SceneIdentity,
  candidates: TubeCandidate[],
  options: PickOptions,
): PickResult | null {
  const tolerance = resolveTolerance(options.durationToleranceSec);
  const range = scene.durationRange;
  if (scene.durationReview) return null;
  if (
    (!Number.isFinite(scene.durationSec) || (scene.durationSec ?? 0) <= 0) &&
    (!range || range.minSec <= 0 || range.maxSec < range.minSec)
  )
    return null;

  const release = parseTimestamp(scene.releaseDate);
  const bestByStem = new Map<string, Scored>();
  for (const candidate of candidates) {
    const duration = Number(candidate.duration);
    if (!Number.isFinite(duration)) continue;
    const delta = range
      ? Math.max(range.minSec - duration, 0, duration - range.maxSec)
      : Math.abs(duration - (scene.durationSec ?? 0));
    if (delta > tolerance) continue;
    if (options.dateWindowDays !== null) {
      // A three-state check that a two-state one cannot express: "unknown" is a
      // rejection, not a pass. See `withinDateWindow`.
      if (withinDateWindow(scene.releaseDate, candidate.added, options.dateWindowDays) !== true) {
        continue;
      }
    }
    // A candidate whose title stems to NOTHING is not a candidate. Every such
    // title hashes to the same empty key, so they would collapse into one stem
    // group and one of them - whichever the comparator happened to prefer -
    // would take the group's slot. Worse, a titled candidate that loses the
    // rank to a blank one is then discarded with it. The gate can still measure
    // duration and date without a title, so the honest outcome is "this rung
    // cannot rank it", which is what returning null for the stem expresses.
    const stem = titleStem(candidate.title);
    if (!stem) continue;
    const uploaded = parseTimestamp(candidate.added);
    const scored: Scored = {
      candidate,
      tier: identityTier(scene, candidate.title),
      lag: release === null || uploaded === null ? Number.POSITIVE_INFINITY : uploaded - release,
    };
    const current = bestByStem.get(stem);
    if (!current || rank(scene, scored, current) < 0) bestByStem.set(stem, scored);
  }

  const best = survivors(scene, bestByStem, options);
  if (!best) return null;
  return {
    candidate: best.candidate,
    identityTier: best.tier,
    dateWindowApplied: options.dateWindowDays !== null,
  };
}

/**
 * The stem groups that may still compete, then the best of them.
 *
 * The identity gate lives here rather than in the scan loop for a reason that
 * is easy to get wrong: candidates are collapsed by title stem BEFORE ranking,
 * so a repost and its original are a single group. Gating inside the loop would
 * judge a group on whichever of its members happened to be examined first, and
 * would drop a correctly-titled original because an untitled sibling was seen
 * first. Gating on the group's BEST tier - which is the member `rank` already
 * chose, since the collapse keeps the highest-ranked member of each stem - means
 * one named member is enough to keep the group, and no member's absence can
 * remove a title that was there all along.
 *
 * The `requireIdentity` check is `tier > 0`, not `tier === 3`. Tier 1 is a
 * first-name-only match, and the earlier Eporner index's retitles routinely carry first
 * names alone for multi-performer scenes, so requiring the top tier would score
 * the whole pool at zero - the exact failure that got the earlier gate removed.
 * Zero is the only tier that means "nothing in this title identifies the scene".
 */
function survivors(
  scene: SceneIdentity,
  bestByStem: Map<string, Scored>,
  options: PickOptions,
): Scored | undefined {
  const groups = [...bestByStem.values()];
  const eligible = options.requireIdentity ? groups.filter((scored) => scored.tier > 0) : groups;
  return eligible.sort((left, right) => rank(scene, left, right))[0];
}
