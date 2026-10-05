/**
 * The sxyprn matcher - rung 2 of the ladder.
 *
 * sxyprn exposes no clean public API, so it is reached through the optional
 * `sxyprn` client (browser impersonation) when that package is installed. From
 * a datacenter IP sxyprn frequently answers 403 behind Cloudflare, so this rung
 * is the one most likely to be unavailable in production; the client is
 * therefore lazily loaded and circuit-broken in `sxyprn-client.ts`. A failure
 * is recorded, and any trusted-pool survivors already collected remain
 * available to the ladder's cross-tube fallback.
 *
 * MEASURED, and the reason "most likely to be unavailable" is stated as a
 * concern rather than a fact. From a workstation IP the client answers fine: a
 * live `search("mambo-perv")` on 2026-09-30 returned 30 cards, each carrying
 * `durationSeconds`, `views`, `relativeDate` and `author`. The open question is
 * what a datacenter IP gets, and the ladder now logs the error a rung throws
 * instead of folding every rung's failures into one `errored` counter - a
 * blocked IP, a missing optional package and a genuine outage were
 * indistinguishable from outside, which is how this rung came to be described
 * as dead on the strength of an aggregate. Everything the gate needs is here:
 * the card carries the duration, the post carries a real `uploadDate` and a
 * `views` count, so this tube can raise the share of scenes that can be
 * identified at all.
 *
 * THE TWO PASSES, AND WHY THERE ARE TWO. Search cards already carry
 * `durationSeconds`, so the duration half of the gate can run on the cards and
 * used to. They do NOT carry a real date: `relativeDate` is a rendered label
 * like `21 hours ago` or `Yesterday`, which is not a timestamp and is not
 * treated as one. So the date half cannot run on a card at all.
 *
 *   card pass  - duration filter, then rank identity-named cards first and
 *                fill the bounded detail slice with other duration survivors.
 *                `dateWindowDays: null`, because the date is not testable here.
 *                This pass CANNOT admit anything and is not treated as an
 *                admission.
 *   detail pass - the POST's own title, duration, schema.org `uploadDate` and
 *                views. THIS is the authoritative date+duration survivor set.
 *                A title that names the scene is a high-confidence match; an
 *                unnamed survivor is returned to the ladder's terminal
 *                fallback, which can use its views only after every tube has
 *                failed to produce a named match.
 *
 * An unverified search card is never exposed as playback: every survivor is
 * fetched and checked against the post itself, because a card can advertise a
 * title, duration or date the post contradicts.
 *
 * The codex `sxyprn-overrides.js` hardcoded URL map is deliberately absent. It
 * was a workaround for opaque titles, and the rebuild dropped it: a link that
 * cannot clear the measured gate is not written.
 */
import {
  identityTier,
  pickMatch,
  parseTimestamp,
  withinDateWindow,
  type IdentityTier,
  type TubeCandidate,
} from "../core/matching.ts";
import { mapIsolated } from "../core/concurrency.ts";
import { createExpiringCache } from "./eporner.ts";
import { buildQueries, configuredSceneCode } from "./queries.ts";
import type { MatchScene } from "./types.ts";

export interface SxyprnCard {
  url?: string;
  title?: string;
  durationSeconds?: number | string;
  /** View count exposed by the card and verified again on the post detail. */
  views?: number | string;
  isExternal?: boolean;
  author?: unknown;
  /** A rendered relative label (`21 hours ago`). Not a timestamp; not parsed. */
  relativeDate?: string;
}

export interface SxyprnDetail extends SxyprnCard {
  streamUrl?: string;
  /** Schema.org `uploadDate`, ISO 8601 with an offset. The date the gate uses. */
  uploadDate?: string;
  sizeBytes?: number;
  /** View count. A string on the wire, so it is normalised at the boundary. */
  views?: number | string;
}

/**
 * Requests the rung actually spent at the source, split by pass.
 *
 * The split is the point. Every request costs the package's politeness floor, so
 * the two together are the run's cost in time; and separately they answer the two
 * questions a budget decision needs - `search` is how many scenes reached this
 * rung at all, `details` how many candidate posts had to be verified.
 */
export interface SxyprnRequestCount {
  search: number;
  details: number;
}

export interface SxyprnClient {
  videos: {
    search(query: string): Promise<{ videos?: SxyprnCard[] }>;
    details(input: { url: string }): Promise<SxyprnDetail>;
  };
  /**
   * Requests issued since the last call, and zero the counter.
   *
   * A drain, not a total: the client is process-wide and outlives any one cycle,
   * so a cumulative figure would let a single refresh be charged for every
   * refresh before it. One drain per cycle, once the resolve stage is over.
   */
  takeRequests(): SxyprnRequestCount;
}

/** 13 hex chars, e.g. `/post/6ab1a9bec8445.html`. */
export function validSxyprnUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value));
    return (
      url.protocol === "https:" &&
      url.hostname === "sxyprn.com" &&
      /^\/post\/[a-f0-9]{13}\.html$/.test(url.pathname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** A search query reduced to sxyprn's slug convention. */
export function searchSlug(value: string): string {
  return String(value || "")
    .replace(/[`~!@#$%^&*()_|+\-=?;:'",.<>{}[\]\\/]/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * A rejected detail fetch reduced to one readable reason. A detail wrapper can
 * rethrow anything, and a truthy non-`Error` would otherwise land in the joined
 * diagnostic as `undefined` - or as an empty field when the reasons are joined.
 * Never returns an empty string, so a reason is never a blank gap in the list.
 */
function detailFailureReason(error: unknown): string {
  if (error instanceof Error) return error.message.trim() || "unknown detail error";
  if (typeof error === "string" && error.trim()) return error.trim();
  return "unknown detail error";
}

export interface SxyprnLookupOptions {
  client: SxyprnClient;
  maxMatches?: number;
  /** The upload window, applied on the verified post. */
  dateWindowDays: number;
  durationToleranceSec?: number;
  /** Detail fetches in flight at once, and the per-slice detail cache TTL. */
  detailConcurrency?: number;
  cacheTtlMs?: number;
}

/** One verified date-and-duration survivor, including identity and view evidence. */
export interface SxyprnMatch {
  url: string;
  identityTier: IdentityTier;
  lagDays: number | null;
  title: string;
  duration: number;
  added: string;
  views: number | string | null;
}

/**
 * Build the sxyprn lookup bound to one scene. Returns every date-and-duration
 * survivor from the bounded detail slice, with its identity tier and view count.
 * Throws only when the source itself could not answer, so the caller can tell
 * "the source is down" from "the source found nothing" and move down the ladder
 * without recording a false negative.
 */
export function createSxyprnLookup({
  client,
  maxMatches = 1,
  dateWindowDays,
  durationToleranceSec,
  detailConcurrency = 3,
  cacheTtlMs = 5 * 60_000,
}: SxyprnLookupOptions) {
  // Both caches are bounded AND expiring. A `Map` that only ever grows is a
  // slow leak across a long-running server: one entry per slug and per post URL
  // for the life of the process, holding a resolved detail forever.
  const cachedSearch = createExpiringCache({ ttlMs: cacheTtlMs });
  const cachedDetails = createExpiringCache({ ttlMs: cacheTtlMs });
  const search = (query: string): Promise<{ videos?: SxyprnCard[] }> =>
    cachedSearch(searchSlug(query), () => client.videos.search(searchSlug(query)));
  const details = (url: string): Promise<SxyprnDetail> =>
    cachedDetails(url, () => client.videos.details({ url }));

  return async function lookup(scene: MatchScene): Promise<SxyprnMatch[]> {
    const code = scene.sceneCode ?? configuredSceneCode(scene);
    const queries = buildQueries(scene);
    if (!queries.length || (!Number.isFinite(scene.durationSec) && !scene.durationRange)) return [];
    const allCandidates = new Map<string, SxyprnCard>();
    let successfulSearches = 0;
    const searchErrors: string[] = [];
    for (const query of queries) {
      try {
        const page = await search(query);
        successfulSearches += 1;
        for (const item of page.videos ?? []) {
          if (!validSxyprnUrl(item.url)) continue;
          allCandidates.set(item.url as string, item);
        }
      } catch (error) {
        searchErrors.push((error as Error).message);
        /* A second performer or the title may still find the scene. */
      }
    }
    if (!successfulSearches) {
      // Keep the source's actual reason. A generic message made an HTTP 403,
      // a timeout, and a broken package indistinguishable, so the aggregate
      // `errored` count was mistaken for proof that this whole tube was dead.
      // The query text is not logged; it may contain scene metadata.
      const reasons = [...new Set(searchErrors)].slice(0, 3).join("; ");
      throw new Error(`sxyprn search unavailable${reasons ? `: ${reasons}` : ""}`);
    }

    // The card pass. `dateWindowDays: null` is the whole point: a card has no
    // real date, so the date half is deferred rather than faked from
    // `relativeDate`. This pass cannot gate identity: a card may omit the
    // performer that its post detail supplies, and unnamed cards still need to
    // reach the bounded leftover set for the terminal fallback.
    const identity = { ...scene, sceneCode: code };
    const mapped: (TubeCandidate & { isExternal: boolean })[] = [...allCandidates.values()].map(
      (item) => ({
        url: String(item.url ?? ""),
        title: String(item.title ?? ""),
        duration: Number(item.durationSeconds),
        views: item.views ?? null,
        isExternal: item.isExternal ?? false,
        ...(item.author ? { author: item.author } : {}),
      }),
    );
    const picked = pickMatch(identity, mapped, { dateWindowDays: null, durationToleranceSec });
    // Detail-verify every duration-surviving card in the bounded slice, not
    // only the winner's title-stem siblings. Once the pool and the named sxyprn
    // pass both decline, the terminal fallback compares leftovers across ALL
    // tubes by views; omitting other card stems here would make that comparison
    // a popularity contest over an arbitrary title group.
    const durationSurvivors = mapped.filter((item) => {
      const duration = Number(item.duration);
      return (
        Number.isFinite(duration) &&
        (scene.durationRange
          ? Math.max(
              scene.durationRange.minSec - duration,
              0,
              duration - scene.durationRange.maxSec,
            )
          : Math.abs(duration - (scene.durationSec ?? 0))) <= (durationToleranceSec ?? 1)
      );
    });
    if (!durationSurvivors.length) return [];
    const cardViews = (candidate: TubeCandidate): number => {
      const raw = candidate.views;
      if (typeof raw === "number") return Number.isFinite(raw) ? raw : -1;
      if (typeof raw !== "string") return -1;
      const value = Number(raw.replace(/[,\s]/g, ""));
      return Number.isFinite(value) ? value : -1;
    };
    const ranked = [
      ...(picked ? [picked.candidate as TubeCandidate & { isExternal: boolean }] : []),
      ...durationSurvivors
        .filter((item) => item.url !== picked?.candidate.url)
        .sort(
          (left, right) =>
            Number(left.isExternal) - Number(right.isExternal) ||
            cardViews(right) - cardViews(left) ||
            String(left.url).localeCompare(String(right.url)),
        ),
    ];

    // The detail pass. The posts are fetched concurrently (each pays a browser-
    // impersonated request, so serial would multiply the ladder's latency by
    // the slice length) but RE-VERIFIED sequentially in rank order, so the
    // winner's ordering and the maxMatches cut are unchanged.
    //
    // `mapIsolated`, not the shared pool: this runs inside `resolveLinks`' own
    // fan-out, so the caller already holds a slot and a second acquire on the
    // shared (non-re-entrant) counter would deadlock at the limit rather than
    // merely slow down.
    const slice = ranked.slice(0, Math.max(3, maxMatches));
    const fetched = await mapIsolated(
      slice,
      async (item) => {
        try {
          return { detail: await details(item.url as string) };
        } catch (error) {
          return { detail: null, error };
        }
      },
      detailConcurrency,
    );

    // Two counters, deliberately: `verifiedPosts` counts posts the source could
    // ANSWER, and is what distinguishes "sxyprn is down" from "sxyprn found
    // nothing". `verified` counts posts that cleared the date+duration filter,
    // including unnamed survivors reserved for fallback. Conflating the two
    // would report a healthy source as dead whenever the filter rejected all.
    let verifiedPosts = 0;
    const detailErrors: string[] = [];
    const verified: SxyprnMatch[] = [];
    for (let index = 0; index < slice.length; index += 1) {
      const item = slice[index] as TubeCandidate & { isExternal: boolean };
      const outcome = fetched[index];
      // A post we could not fetch is never exposed as playback, and is not
      // counted against the source: the ladder moves down instead.
      if (!outcome || outcome.detail === null) {
        if (outcome) detailErrors.push(detailFailureReason(outcome.error));
        continue;
      }
      const detail = outcome.detail;
      verifiedPosts += 1;
      // Verify the POST's own title, duration and date, not the search card's:
      // a card can advertise any of the three wrongly. This is the authoritative
      // survivor set for the terminal fallback. Identity decides which
      // survivors are high confidence; it does not remove date+duration
      // survivors from the low-confidence candidate pool.
      const title = String(detail.title ?? "");
      const duration = Number(detail.durationSeconds ?? item.duration);
      const datePass =
        withinDateWindow(scene.releaseDate, detail.uploadDate ?? null, dateWindowDays) === true;
      const durationPass =
        Number.isFinite(duration) &&
        (Number.isFinite(scene.durationSec) || Boolean(scene.durationRange)) &&
        (scene.durationRange
          ? Math.max(
              scene.durationRange.minSec - duration,
              0,
              duration - scene.durationRange.maxSec,
            )
          : Math.abs(duration - (scene.durationSec ?? 0))) <= (durationToleranceSec ?? 1);
      if (
        validSxyprnUrl(detail.url) &&
        detail.url === item.url &&
        detail.streamUrl &&
        datePass &&
        durationPass
      ) {
        verified.push({
          url: detail.url as string,
          identityTier: identityTier(identity, title),
          lagDays: lagInDays(scene.releaseDate, detail.uploadDate),
          title,
          duration,
          added: String(detail.uploadDate ?? ""),
          views: detail.views ?? null,
        });
      }
    }
    // Keep WHY, the same way the search path does. A bare "unavailable" merged
    // an upstream refusal, a network failure, a parser break and the deadline
    // into one string, which is why this rung could not be diagnosed from the
    // outside - and the deadline is the one worth separating, because it is the
    // only kind the circuit breaker can put a bound on. Capped at three
    // distinct reasons: the post URLs are never logged, and a runaway list is
    // not a diagnosis anyone can read.
    const reasons = [...new Set(detailErrors)].slice(0, 3).join("; ");
    if (!verifiedPosts)
      throw new Error(`sxyprn post verification unavailable${reasons ? `: ${reasons}` : ""}`);
    return verified;
  };
}

function lagInDays(releaseDate: string, added: string | null | undefined): number | null {
  const release = parseTimestamp(releaseDate);
  const uploaded = parseTimestamp(added);
  if (release === null || uploaded === null) return null;
  return Math.round((uploaded - release) / 86_400_000);
}
