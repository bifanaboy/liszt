/**
 * The sxyprn matcher - rung 2 of the ladder.
 *
 * sxyprn exposes no clean public API, so it is reached through the optional
 * `sxyprn` client (browser impersonation) when that package is installed. From
 * a datacenter IP sxyprn frequently answers 403 behind Cloudflare, so this rung
 * is the one most likely to be dead in production; the client is therefore
 * lazily loaded and circuit-broken in `sxyprn-client.ts`, and a failure here
 * simply lets the eporner-open rung run.
 *
 * THE TWO PASSES, AND WHY THERE ARE TWO. Search cards already carry
 * `durationSeconds`, so the duration half of the gate can run on the cards and
 * used to. They do NOT carry a real date: `relativeDate` is a rendered label
 * like `21 hours ago` or `Yesterday`, which is not a timestamp and is not
 * treated as one. So the date half cannot run on a card at all.
 *
 *   card pass  - duration filter, then rank by identity tier to decide which
 *                posts are worth fetching. `dateWindowDays: null`, because the
 *                date is not testable here. This pass CANNOT admit anything and
 *                is not treated as an admission.
 *   detail pass - the POST's own title, duration and schema.org `uploadDate`,
 *                with the real window. THIS is the pass that admits, and no
 *                URL reaches the store without clearing it.
 *
 * An unverified search card is never exposed as playback either: every accepted
 * hit is fetched and re-gated against the post itself, because a card can
 * advertise a title, duration or date the post contradicts.
 *
 * The codex `sxyprn-overrides.js` hardcoded URL map is deliberately absent. It
 * was a workaround for opaque titles, and the rebuild dropped it: a link that
 * cannot clear the measured gate is not written.
 */
import {
  pickMatch,
  parseTimestamp,
  titleStem,
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

export interface SxyprnClient {
  videos: {
    search(query: string): Promise<{ videos?: SxyprnCard[] }>;
    details(input: { url: string }): Promise<SxyprnDetail>;
  };
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

/** One accepted post: its URL, and the evidence that admitted it. */
export interface SxyprnMatch {
  url: string;
  identityTier: IdentityTier;
  lagDays: number | null;
}

/**
 * Build the sxyprn lookup bound to one scene. Returns [] when nothing clears the
 * gate; throws only when the source itself could not answer, so the caller can
 * tell "the source is down" from "the source found nothing" and move down the
 * ladder without recording a false negative.
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
    if (!queries.length || !Number.isFinite(scene.durationSec)) return [];
    const allCandidates = new Map<string, SxyprnCard>();
    let successfulSearches = 0;
    for (const query of queries) {
      try {
        const page = await search(query);
        successfulSearches += 1;
        for (const item of page.videos ?? []) {
          if (!validSxyprnUrl(item.url)) continue;
          allCandidates.set(item.url as string, item);
        }
      } catch {
        /* A second performer or the title may still find the scene. */
      }
    }
    if (!successfulSearches) throw new Error("sxyprn search unavailable");

    // The card pass. `dateWindowDays: null` is the whole point: a card has no
    // real date, so the date half is deferred rather than faked from
    // `relativeDate`. Identity is carried as the scene code so a title that
    // quotes the studio's own code still ranks at the top tier.
    const identity = { ...scene, sceneCode: code };
    const mapped: (TubeCandidate & { isExternal: boolean })[] = [...allCandidates.values()].map(
      (item) => ({
        url: String(item.url ?? ""),
        title: String(item.title ?? ""),
        duration: Number(item.durationSeconds),
        isExternal: item.isExternal ?? false,
        ...(item.author ? { author: item.author } : {}),
      }),
    );
    const picked = pickMatch(identity, mapped, { dateWindowDays: null, durationToleranceSec });
    if (!picked) return [];
    // Fetch the same-video siblings of the winner too, then prefer real
    // uploads over embeds: a card is cheap to check and an embed is a link to
    // someone else's file.
    const sameStem = mapped.filter(
      (item) =>
        titleStem(item.title) === titleStem(picked.candidate.title) &&
        item.url !== picked.candidate.url,
    );
    const ranked = [picked.candidate as TubeCandidate & { isExternal: boolean }, ...sameStem].sort(
      (left, right) => Number(left.isExternal) - Number(right.isExternal),
    );

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
    // nothing". `accepted` counts posts that then cleared the gate. Conflating
    // them would report a healthy source as a dead one whenever the gate
    // rejected every candidate.
    let verifiedPosts = 0;
    const verified: SxyprnMatch[] = [];
    for (let index = 0; index < slice.length; index += 1) {
      if (verified.length >= maxMatches) break;
      const item = slice[index] as TubeCandidate & { isExternal: boolean };
      const outcome = fetched[index];
      // A post we could not fetch is never exposed as playback, and is not
      // counted against the source: the ladder moves down instead.
      if (!outcome || outcome.detail === null) continue;
      const detail = outcome.detail;
      verifiedPosts += 1;
      // Verify the POST's own title, duration and date, not the search card's:
      // a card can advertise any of the three wrongly.
      const accepted = pickMatch(
        identity,
        [
          {
            url: String(item.url ?? ""),
            title: detail.title ?? "",
            duration: Number(detail.durationSeconds ?? item.duration),
            added: detail.uploadDate ?? null,
            views: detail.views ?? null,
          },
        ],
        { dateWindowDays, durationToleranceSec },
      );
      if (validSxyprnUrl(detail.url) && detail.url === item.url && detail.streamUrl && accepted) {
        verified.push({
          url: detail.url as string,
          identityTier: accepted.identityTier,
          lagDays: lagInDays(scene.releaseDate, detail.uploadDate),
        });
      }
    }
    if (!verifiedPosts) throw new Error("sxyprn post verification unavailable");
    return verified.slice(0, maxMatches);
  };
}

function lagInDays(releaseDate: string, added: string | null | undefined): number | null {
  const release = parseTimestamp(releaseDate);
  const uploaded = parseTimestamp(added);
  if (release === null || uploaded === null) return null;
  return Math.round((uploaded - release) / 86_400_000);
}
