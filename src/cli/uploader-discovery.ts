/**
 * `npm run discover-uploaders` - propose trusted-pool accounts, write nothing.
 *
 * THE QUESTION. `LISZT_TRUSTED_UPLOADERS` is a curated list, and curation
 * stalls: an account that starts reposting studio scenes gets no link until a
 * human notices, and the signal for noticing does not exist anywhere. This is
 * that signal.
 *
 * It works backwards from the scenes we FAILED to link. For each unlinked scene
 * it searches eporner, keeps the hits that clear the duration band and the
 * upload window - a filter, never a score - and then asks the only place eporner
 * will say who posted each one: the video page. An account that keeps turning
 * up for scenes we could not link, on videos whose TITLES name the performer or
 * reuse the studio's scene code, is an account worth trusting.
 *
 * It prints a ranked table and exits. It does not write a link, does not touch
 * `pool_videos`, and does not add anything to the trusted list. Admitting an
 * account is a human decision, because a wrong one puts every video on that
 * account into the pool - see `tubes/discovery.ts` for why that is the one
 * irreversible step here.
 *
 * WHY SEARCH IS STILL USED AFTER THE RUNG WAS DELETED. The eporner open-search
 * RUNG was removed from the ladder because it cannot gate: the v2 search API
 * exposes no date filter, so a 90-day-old release is only reachable by
 * paginating backwards with no reliable stop. That is an argument about
 * ADMISSION and says nothing about RECALL, which is all this tool needs. The
 * rows themselves do carry `added` - measured 2026-09-30, 100% populated over
 * 4,000 rows - so the window is applied exactly here rather than approximated.
 *
 * The JSON report goes to stdout; logs go to stderr.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { HttpFetcher } from "../core/fetcher.ts";
import { JsonLogger } from "../core/logger.ts";
import { SqliteStore } from "../core/store/sqlite.ts";
import { mapIsolated } from "../core/concurrency.ts";
import { withinDateWindow } from "../core/matching.ts";
import { dateOnly } from "../pipeline/sync.ts";
import { buildQueries } from "../tubes/queries.ts";
import { buildMatchScene } from "../tubes/resolve.ts";
import {
  parseVideoUploader,
  proposeUploaders,
  scoreIdentityAgreement,
  evidenceScore,
  type UploaderObservation,
} from "../tubes/discovery.ts";
import type { MatchScene } from "../tubes/types.ts";

const SEARCH_URL = "https://www.eporner.com/api/v2/video/search/";
const DAY_MS = 86_400_000;

/**
 * Detail fetches in flight at once.
 *
 * Each is a full video page - roughly 100 KB of HTML, and it exists only to
 * read one account name out of it. A low number is deliberate: this is a
 * read-only proposal tool, and the polite rate is worth more here than the wall
 * clock, because the number of requests is bounded by `--limit` and
 * `--per-scene` rather than by anything the tool needs to be fast.
 */
const SCENE_CONCURRENCY = 2;

interface SearchRow {
  id?: string;
  title?: string;
  views?: number | string;
  added?: string;
  length_sec?: number | string;
  url?: string;
}

/** The account name carried in a search row's URL slug path. */
function videoIdOf(url: string | undefined, fallback: string): string {
  return /\/video-([A-Za-z0-9]+)/.exec(url ?? "")?.[1] ?? fallback;
}

/** Numeric view count, or null. Never 0 for an unreadable value. */
function viewsOf(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const value = Number(raw.replace(/[,\s]/g, ""));
  return Number.isFinite(value) ? value : null;
}

/** Search unlinked scenes and print uploader proposals without saving links or changing trust. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      limit: { type: "string", default: "40" },
      "per-scene": { type: "string", default: "6" },
      "scene-id": { type: "string" },
      "min-delta": { type: "string" },
      window: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const config = loadConfig();
  const log = new JsonLogger({ component: "discover-uploaders" }, (line) =>
    process.stderr.write(`${line}\n`),
  );
  const store = new SqliteStore(config.dbPath);
  store.migrate();
  const fetcher = new HttpFetcher(config.fetchTimeoutMs);
  const now = new Date();
  const limit = Math.max(1, Number(values.limit) || 40);
  const perScene = Math.max(1, Number(values["per-scene"]) || 6);
  const windowDays = values.window ? Number(values.window) : config.matchDateWindowDays;
  // The band is a FILTER, so it is deliberately generous: the point of this
  // tool is to find accounts, and a near-length video on the right account is
  // still a lead. Anything tighter would hide the account that re-encodes.
  const minDelta = values["min-delta"] ? Number(values["min-delta"]) : 2;

  try {
    const from = dateOnly(new Date(now.getTime() - config.windowDays * DAY_MS));
    const to = dateOnly(now);
    const unlinked = store
      .listWindow(from, to)
      .filter((scene) => scene.videoUrls.length === 0)
      .map((scene) => buildMatchScene(scene, scene.labelId === "bang-originals"));
    const selected = values["scene-id"]
      ? unlinked.filter((scene) => scene.id === values["scene-id"])
      : unlinked;
    const queue = selected
      .filter((scene) => Number.isFinite(scene.durationSec) && (scene.durationSec ?? 0) > 0)
      .slice(0, limit);
    log.info("uploader discovery starting", {
      unlinked: unlinked.length,
      selected: selected.length,
      considered: queue.length,
      minDelta,
      windowDays,
    });

    const observations: UploaderObservation[] = [];
    let pagesFetched = 0;
    let pagesUnreadable = 0;

    await mapIsolated(
      queue,
      async (scene: MatchScene) => {
        const queries = buildQueries(scene);
        if (!queries.length) return;
        const rows: SearchRow[] = [];
        for (const query of queries) {
          const url = new URL(SEARCH_URL);
          url.searchParams.set("query", query);
          url.searchParams.set("per_page", "50");
          url.searchParams.set("page", "1");
          url.searchParams.set("order", "latest");
          url.searchParams.set("format", "json");
          // Explicit, never defaulted: the API's default is `lq=1`, which
          // INCLUDES low-quality content, and both reference repos omitted it.
          url.searchParams.set("lq", "0");
          try {
            const data = await fetcher.json<{ videos?: SearchRow[] }>(url.href, {
              headers: { accept: "application/json" },
            });
            for (const row of data.videos ?? []) rows.push(row);
          } catch (error) {
            log.debug("discovery search failed", {
              scene: scene.id,
              query,
              error: (error as Error).message,
            });
          }
        }

        // Queries overlap, so collapse them by video id before fetching pages.
        // Counting the same post once per matching query would make a prolific
        // query term look like an uploader repeatedly corroborated across
        // scenes, when it was only the same one video returned twice.
        const uniqueRows = [
          ...new Map(rows.map((row) => [videoIdOf(row.url, String(row.id ?? "")), row])).values(),
        ];

        // The cheap filters. Neither is a score, and neither decides anything on
        // its own - they only remove videos that could not be this scene.
        const usable = uniqueRows
          .filter((row) => {
            const duration = Number(row.length_sec);
            if (!Number.isFinite(duration) || !scene.durationSec) return false;
            return Math.abs(duration - scene.durationSec) <= minDelta;
          })
          .filter((row) => withinDateWindow(scene.releaseDate, row.added, windowDays) === true)
          .slice(0, perScene);

        for (const row of usable) {
          const id = videoIdOf(row.url, String(row.id ?? ""));
          if (!id) continue;
          // The account name is in the video page and nowhere else.
          let uploader: string | null = null;
          try {
            const html = await fetcher.text(row.url ?? `https://www.eporner.com/video-${id}/`, {
              headers: { accept: "text/html" },
            });
            pagesFetched += 1;
            uploader = parseVideoUploader(html);
          } catch (error) {
            pagesFetched += 1;
            log.debug("discovery page failed", {
              scene: scene.id,
              id,
              error: (error as Error).message,
            });
          }
          if (!uploader) {
            pagesUnreadable += 1;
            continue;
          }
          const agreement = scoreIdentityAgreement(scene, String(row.title ?? ""));
          observations.push({
            uploader,
            videoId: id,
            title: String(row.title ?? ""),
            views: viewsOf(row.views),
            sceneId: scene.id,
            sceneTitle: scene.title,
            performers: scene.performers,
            durationDeltaSec: Math.abs(Number(row.length_sec) - (scene.durationSec ?? 0)),
            agreement,
            score: evidenceScore(agreement),
          });
        }
      },
      SCENE_CONCURRENCY,
    );

    const proposals = proposeUploaders(observations, config.trustedUploaders);
    const candidates = proposals.filter((proposal) => !proposal.alreadyTrusted);

    if (values.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            generatedAt: now.toISOString(),
            windowDays,
            minDeltaSec: minDelta,
            unlinkedScenes: unlinked.length,
            selectedScenes: selected.length,
            scenesConsidered: queue.length,
            observations: observations.length,
            observationsWithEvidence: observations.filter((row) => row.score > 0).length,
            videoPagesFetched: pagesFetched,
            videoPagesWithoutUploader: pagesUnreadable,
            trustedUploaders: config.trustedUploaders,
            proposals,
            candidates: candidates.map((proposal) => proposal.uploader),
            wrote: false,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      const lines: string[] = [];
      lines.push(
        `Scanned ${queue.length} unlinked scenes (${unlinked.length} in window) and read ${pagesFetched} video pages.`,
      );
      lines.push(
        `${observations.length} candidate videos, ${observations.filter((row) => row.score > 0).length} of them naming the scene.`,
      );
      lines.push("");
      if (!candidates.length) {
        lines.push("No account outside the trusted list scored above zero. Nothing to propose.");
      }
      for (const proposal of candidates) {
        lines.push(
          `${proposal.uploader}  scenes=${proposal.distinctScenes}  pairs=${proposal.scoredPairs}  ` +
            `best=${proposal.bestScore.toFixed(2)} (${proposal.bestEvidence})  ` +
            `medianDelta=${proposal.medianDurationDeltaSec ?? "n/a"}s  views=${proposal.totalViews}`,
        );
        for (const sample of proposal.sample) {
          lines.push(`    ${sample.sceneId} <- ${sample.videoId}  ${sample.evidence}`);
          lines.push(`      ${sample.title.slice(0, 110)}`);
        }
      }
      lines.push("");
      lines.push("NOTHING WAS CHANGED. To accept, add the names above to LISZT_TRUSTED_UPLOADERS.");
      lines.push(
        "Check a proposal by hand first: a name here means 'this account posted something that",
        "looks like a scene we could not link', not 'this account is safe'.",
      );
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    log.info("uploader discovery finished", {
      observations: observations.length,
      candidates: candidates.length,
      pagesFetched,
    });
  } finally {
    store.close();
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  process.stderr.write(`discover-uploaders failed: ${(error as Error).message}\n`);
  process.exit(1);
}
