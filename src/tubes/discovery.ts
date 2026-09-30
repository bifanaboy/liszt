/**
 * Uploader discovery - which accounts SHOULD be trusted, proposed rather than
 * adopted.
 *
 * THE GAP THIS EXISTS TO CLOSE, MEASURED. Over the 46 links the live service held
 * on 2026-09-30, 45 came from the trusted pool and one from open search, and
 * that one was uploaded by `Chrishunter1836` - a 12,613-subscriber account that
 * is not in `LISZT_TRUSTED_UPLOADERS`. The pool never indexed it, so every
 * other video that account uploaded inside the window went unlinked too. And
 * the two API endpoints that could have found it both refuse to say who uploaded
 * anything: `video/search/` and `video/id/` return no uploader field at all.
 * The uploader appears in exactly one place, the video page's
 * `<li class="vit-uploader">`. That is the entire gap.
 *
 * WHY IT IS A CLI AND NOT A STAGE. A wrong uploader admitted wholesale is how
 * decoys enter the pool - every video on that account becomes a candidate, and
 * the pool is scanned by duration alone. So this proposes and never writes: it
 * prints a ranked list, and a human adds the accounts it names. There is
 * deliberately no code path from this module to `LISZT_TRUSTED_UPLOADERS`, to
 * `pool_videos`, or to a link. If you are adding one, you are undoing the point.
 *
 * WHY THE SCORE IS NOT DURATION. This is the one design decision worth stating
 * twice, because the obvious version is wrong. Duration-and-date agreement is a
 * FILTER here, never a score: with the band at a second, unrelated half-hour
 * videos collide constantly, so an account that scores well on that signal may
 * be scoring well because they upload long videos. The score is agreement
 * between the video's TITLE and the scene's identity - a performer token, the
 * studio's own scene code, or the scene title reused verbatim. An account whose
 * videos repeatedly name the performers of scenes we could not link is an
 * account that reposts studio scenes. One that merely has similar-length videos
 * is not, and this module cannot tell those apart by design.
 */
import {
  identityTier,
  matchTokens,
  type IdentityTier,
  type SceneIdentity,
} from "../core/matching.ts";
import type { MatchScene } from "./types.ts";

/**
 * The uploader account name from a video page, or null.
 *
 * THE MARKUP, MEASURED LIVE on 2026-09-30:
 *
 *   `<li class="vit-uploader"><a href="/profile/DYaM/" title="Uploader">DYaM</a></li>`
 *
 * The account name is read from the LINK's `href` rather than its text, because
 * the text is display text: it is localised, truncated on long names, and
 * decorated. `href` is the same string the profile index walks, so a name taken
 * from the href is directly usable as a `LISZT_TRUSTED_UPLOADERS` entry - which
 * is the whole point, since a proposal the human has to translate is a proposal
 * that gets mistyped.
 *
 * `title="Uploader"` is checked because eporner's video page carries several
 * other `/profile/` links - "more from this uploader", related accounts, and
 * navigation - and only this one names the account that uploaded THIS video.
 * Without the check the function returns whichever profile link happens to come
 * first, which is a confidently wrong account.
 *
 * A page with no such element is null, not a guess. A page served as an
 * anti-bot wall has no uploader, and inventing one is exactly the failure this
 * module exists to avoid.
 */
export function parseVideoUploader(html: string): string | null {
  const source = String(html);
  const element =
    /<li\b[^>]*class=["'][^"']*\bvit-uploader\b[^"']*["'][^>]*>([\s\S]{0,600}?)<\/li>/i.exec(
      source,
    )?.[1] ?? null;
  if (element === null) return null;
  const href = /<a\b[^>]*href=["']\/profile\/([^/"']+)\/?["']/i.exec(element)?.[1];
  if (!href) return null;
  // A display-text fallback, for a page that renders the name without the link.
  const text = element
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return decodeURIComponent(href) || text || null;
}

/** How a candidate's title identifies the scene, and on what evidence. */
export interface IdentityAgreement {
  tier: IdentityTier;
  /** The scene code's tokens the title carries. */
  codeTokens: string[];
  /** A full performer name, every token present. */
  namedPerformers: string[];
  /** Performer first names present as standalone tokens. */
  firstNames: string[];
  /** Fraction of the scene's own title tokens the candidate reuses. */
  titleOverlap: number;
}

/**
 * Score a candidate title against a scene, on identity alone.
 *
 * `tier` is the shared `identityTier`, so discovery and the ladder cannot
 * disagree about what "names the performer" means. The extra fields are the
 * evidence BEHIND the tier, and they are what the ranking sorts on: tier 2 and
 * tier 1 both mean "a performer is named" but a full name is worth more than a
 * first name, and a candidate that reuses the studio's own scene code is worth
 * more than either because the code is not something an unrelated upload
 * collides with.
 */
export function scoreIdentityAgreement(scene: MatchScene, title: string): IdentityAgreement {
  const candidateTokens = new Set(matchTokens(title));
  const sceneTitleTokens = matchTokens(scene.title).filter((token) => token.length > 2);
  const shared = sceneTitleTokens.filter((token) => candidateTokens.has(token));
  const codeTokens = matchTokens(scene.sceneCode ?? "").filter((token) =>
    candidateTokens.has(token),
  );
  const namedPerformers: string[] = [];
  const firstNames: string[] = [];
  for (const name of scene.performers) {
    const tokens = matchTokens(name);
    if (!tokens.length) continue;
    if (tokens.every((token) => candidateTokens.has(token))) namedPerformers.push(name);
    else if (candidateTokens.has(tokens[0] as string)) firstNames.push(tokens[0] as string);
  }
  return {
    tier: identityTier(scene, title),
    codeTokens,
    namedPerformers,
    firstNames,
    titleOverlap: sceneTitleTokens.length ? shared.length / sceneTitleTokens.length : 0,
  };
}

/**
 * How much one (scene, candidate) observation is worth.
 *
 * Weighted rather than a plain count, because the tiers are not equally strong
 * evidence and a tally that treats them alike would rank an account whose
 * titles reuse studio scene codes below one that happens to contain a common
 * first name. The weights are ordinal - they only have to preserve the ranking
 * of evidence strength, not calibrate to anything.
 */
export function evidenceScore(agreement: IdentityAgreement): number {
  let score = 0;
  if (agreement.tier > 0) {
    score = 1;
    if (agreement.tier >= 2) score += 2;
    // A first name is weaker than a full name but real, and the trusted pool's
    // retitles routinely carry first names alone, so it is counted rather than
    // thrown away.
    if (agreement.tier === 1) score += 0.5;
    score += agreement.namedPerformers.length * 0.5;
    score += agreement.firstNames.length * 0.25;
  }
  // The scene code is the strongest single signal available: it is the studio's
  // own retrieval key, and an unrelated upload does not carry it by accident.
  score += agreement.codeTokens.length * 1.5;
  // Reusing the studio's wording is real but weak evidence - studios share
  // phrasing, and the same phrase recurs across a catalogue.
  // Scene wording is weaker than a performer or code but still the plan's
  // specified identity signal. Keep it below a single named performer so a
  // generic phrase can never outrank a candidate that names the cast.
  score += agreement.titleOverlap * 0.25;
  return score;
}

/** One candidate video, and whose account posted it. */
export interface UploaderObservation {
  uploader: string;
  videoId: string;
  title: string;
  /** Search-reported views, or null. Used for reporting, never for scoring. */
  views: number | null;
  sceneId: string;
  sceneTitle: string;
  performers: string[];
  /** Whole seconds the candidate's length differs from the scene's. */
  durationDeltaSec: number;
  agreement: IdentityAgreement;
  score: number;
}

/** One account's tally, ranked. */
export interface UploaderProposal {
  uploader: string;
  /** Observations carrying identity evidence. */
  scoredPairs: number;
  /** Distinct scenes those observations covered. */
  distinctScenes: number;
  /** The strongest single piece of evidence found for this account. */
  bestScore: number;
  bestEvidence: string;
  /** Accounts the proposal must not duplicate. */
  alreadyTrusted: boolean;
  /** Median duration delta, so a reader can see it is not a length artefact. */
  medianDurationDeltaSec: number | null;
  totalViews: number;
  sample: { sceneId: string; videoId: string; title: string; evidence: string }[];
}

/** Median of a numeric list, or null when it is empty. */
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** A one-line description of what earned a candidate its score. */
export function describeEvidence(agreement: IdentityAgreement): string {
  const parts: string[] = [];
  if (agreement.namedPerformers.length) parts.push(`names ${agreement.namedPerformers[0]}`);
  if (agreement.firstNames.length) parts.push(`first name "${agreement.firstNames[0]}"`);
  if (agreement.codeTokens.length) parts.push(`scene code "${agreement.codeTokens.join("")}"`);
  if (agreement.titleOverlap > 0)
    parts.push(`reuses ${Math.round(agreement.titleOverlap * 100)}% of the title`);
  return parts.join(" + ") || "no identity evidence";
}

/**
 * Tally observations into a ranked proposal per account.
 *
 * Observations with NO identity evidence contribute nothing, and that is the
 * load-bearing filter: an account whose videos merely share a running time is
 * invisible here, which is the intended answer. Accounts already in the trusted
 * list are reported but marked, so a re-run does not look like a discovery.
 */
export function proposeUploaders(
  observations: UploaderObservation[],
  trustedUploaders: readonly string[],
): UploaderProposal[] {
  const trusted = new Set(trustedUploaders);
  const byUploader = new Map<string, UploaderObservation[]>();
  for (const observation of observations) {
    if (observation.score <= 0) continue;
    const bucket = byUploader.get(observation.uploader);
    if (bucket) bucket.push(observation);
    else byUploader.set(observation.uploader, [observation]);
  }

  const proposals: UploaderProposal[] = [];
  for (const [uploader, rows] of byUploader) {
    const best = rows.reduce((winner, row) => (row.score > winner.score ? row : winner));
    const scenes = new Set(rows.map((row) => row.sceneId));
    proposals.push({
      uploader,
      scoredPairs: rows.length,
      distinctScenes: scenes.size,
      bestScore: best.score,
      bestEvidence: describeEvidence(best.agreement),
      alreadyTrusted: trusted.has(uploader),
      medianDurationDeltaSec: median(rows.map((row) => row.durationDeltaSec)),
      totalViews: rows.reduce((total, row) => total + (row.views ?? 0), 0),
      sample: rows.slice(0, 3).map((row) => ({
        sceneId: row.sceneId,
        videoId: row.videoId,
        title: row.title,
        evidence: describeEvidence(row.agreement),
      })),
    });
  }
  return proposals.sort(
    (left, right) =>
      right.distinctScenes - left.distinctScenes ||
      right.bestScore - left.bestScore ||
      right.totalViews - left.totalViews ||
      left.uploader.localeCompare(right.uploader),
  );
}

/**
 * The identity fields discovery reads from a scene, so the module does not
 * depend on the pipeline's `Scene` shape.
 */
export function discoveryIdentity(scene: MatchScene): SceneIdentity {
  return scene;
}
