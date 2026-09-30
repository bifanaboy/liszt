/**
 * The madouqu.com lane - category 4 of 4. Nine explicit sub-labels, one
 * classifier, and no tube matching.
 *
 * Two things are inherited deliberately:
 *
 *  - The WordPress REST API. The default base is the `public-api.wordpress.com`
 *    mirror because `madouqu.com` itself sits behind a Cloudflare challenge
 *    from most egress IPs; `LISZT_MADOUQU_API_BASE` points at the direct
 *    `/wp-json` on a VPS with stable egress. Configurable rather than assumed.
 *  - The Mandarin classifier, ported wholesale from `liszt-codex`: ordered
 *    positive / review / exclusion patterns, a penetration-evidence
 *    requirement, and admit / review / excluded verdicts carrying an evidence
 *    snippet. The audit verdict rides in the scene's provenance, so the
 *    dashboard can show WHY a title was admitted.
 *
 * Category 1 (Royal Chinese) is shared and contaminated, so only posts whose
 * title or body carries the Royal Chinese prefix pass it.
 *
 * The lane sets `matcher: null`: it is metadata-only and never enters the tube
 * ladder.
 */
import type { RawScene, SourceAdapter, SourceContext, SourceResult } from "./types.ts";

const DAY_MS = 86_400_000;
const PER_PAGE = 100;

/**
 * The nine sub-labels, by explicit WordPress category id. There is deliberately
 * no generic "Madouqu" bucket: every emitted record carries a real label.
 */
export const STUDIO_CATEGORIES = [
  { id: 2, key: "madou", name: "Madou" },
  { id: 1, key: "royal-chinese", name: "Royal Chinese" },
  { id: 54, key: "peach", name: "Peach" },
  { id: 70, key: "jingdong", name: "Jingdong" },
  { id: 77, key: "tianmei", name: "Tianmei" },
  { id: 88, key: "jelly-91", name: "Jelly/91" },
  { id: 103, key: "xingkong", name: "Xingkong" },
  { id: 1116, key: "elephant", name: "Elephant" },
  { id: 1023, key: "aidou", name: "AiDou" },
] as const;

export type StudioCategory = (typeof STUDIO_CATEGORIES)[number];

/**
 * Classifier patterns.
 *
 * NO `g` FLAG, ANYWHERE IN THIS TABLE. `RegExp.prototype.test` on a global regex
 * reads and advances `lastIndex` on the shared instance, so the second call on
 * the same input starts from the first call's end offset and returns false.
 * With a module-level constant that means classification alternates
 * admit/exclude for identical text - the same post would flip verdict on every
 * poll, and the flip is invisible because each call looks correct in isolation.
 * `hits()` and the exclusion loop below both call `.test()`.
 */
const POSITIVE_PATTERNS: [string, RegExp][] = [
  ["肛交", /肛交/],
  ["肛", /肛/],
  ["後庭", /後庭/],
  ["后庭", /后庭/],
  ["菊", /菊(?:花|穴|門|门)?|爆菊/],
  ["屁眼", /屁眼/],
  ["開肛", /開肛/],
  ["开肛", /开肛/],
  ["anal", /\banal\b/i],
];
const REVIEW_PATTERNS: [string, RegExp][] = [
  ["雙穴", /雙穴/],
  ["双穴", /双穴/],
  ["雙洞", /雙洞/],
  ["双洞", /双洞/],
  ["兩洞齊開", /兩洞齊開/],
  ["两洞齐开", /两洞齐开/],
];
const EXCLUSION_PATTERNS: [string, RegExp][] = [
  ["enema", /灌肠|灌腸/],
  ["fisting", /拳交/],
  ["fingering-only", /(?:指(?:奸|插)|手指(?:进入|進入))/],
  ["plug-only", /肛塞/],
  ["trans-or-cross-dressing", /伪娘|偽娘|\bTS\b|人妖/i],
  ["pegging", /女攻男受|四爱|四愛/],
  ["male-male-or-male-trans", /男男|\bM\s*\+\s*M\b|\bM\s*\+\s*T\b|男\s*[＋+]\s*(?:男|T)/i],
  ["solo", /(?:單人|单人|獨自|独自|自慰|自摸|solo)/i],
];
const PENETRATION_PATTERNS: RegExp[] = [
  /肛交/,
  /開肛|开肛/,
  /後庭.{0,12}(?:操|插|干|肏|進|进|入|抽|爆)/,
  /(?:操|插|干|肏|進|进|入|抽|爆).{0,12}後庭/,
  /后庭.{0,12}(?:操|插|干|肏|进|入|抽|爆)/,
  /(?:操|插|干|肏|进|入|抽|爆).{0,12}后庭/,
  /屁眼.{0,12}(?:操|插|干|肏|進|进|入|抽|爆)/,
  /(?:操|插|干|肏|進|进|入|抽|爆).{0,12}屁眼/,
  /\banal\b/i,
];

/**
 * Decode one numeric HTML entity. `String.fromCodePoint` THROWS a RangeError
 * outside 0..0x10FFFF (and on a surrogate), and a title is attacker-controlled
 * text from a remote source, so an out-of-range entity would abort the whole
 * poll instead of degrading one character. An undecodable entity is dropped.
 */
function decodeCodePoint(code: number): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return "";
  // A lone surrogate is a code point the spec permits but no character exists
  // for, and splicing one into a title makes the string invalid UTF-16 - which
  // then propagates into the store, the JSON log line and the CSV export.
  if (code >= 0xd800 && code <= 0xdfff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Small HTML entity decoder sufficient for WordPress rendered title/body text. */
export function decodeRenderedHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => decodeCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => decodeCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function hits(text: string, patterns: [string, RegExp][]): string[] {
  return [...new Set(patterns.filter(([, regex]) => regex.test(text)).map(([label]) => label))];
}

function snippetAround(text: string, terms: string[], radius = 90): string {
  if (!terms.length) return text.slice(0, radius * 2).trim();
  const index = terms
    .map((term) => text.indexOf(term))
    .filter((value) => value >= 0)
    .sort((a, b) => a - b)[0];
  if (index === undefined) return text.slice(0, radius * 2).trim();
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return `${start ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

export type MadouquDecision = "admit" | "review" | "excluded";

export interface MadouquVerdict {
  decision: MadouquDecision;
  reason: string | null;
  matchedKeywords: string[];
  exclusionKeywords?: string[];
  snippet: string;
}

/**
 * Mandarin-first, ordered keyword classification with explicit evidence.
 * Order matters: an exclusion beats a review beats a review-keyword hit, and
 * penetration evidence is REQUIRED before a post is admitted.
 */
export function classifyScene(title: unknown, body: unknown): MadouquVerdict {
  const plainTitle = decodeRenderedHtml(title);
  const combined = `${plainTitle} ${decodeRenderedHtml(body)}`.trim();
  const positive = hits(combined, POSITIVE_PATTERNS);
  const review = hits(combined, REVIEW_PATTERNS);
  const exclusions = EXCLUSION_PATTERNS.filter(([, regex]) => regex.test(combined)).map(
    ([label]) => label,
  );
  const penetration = PENETRATION_PATTERNS.some((regex) => regex.test(combined));
  const evidence = [...positive, ...review];
  const snippet = snippetAround(combined, evidence.length ? evidence : exclusions);

  if (!evidence.length) {
    return { decision: "excluded", reason: "no-anal-keyword", matchedKeywords: [], snippet };
  }
  if (exclusions.length) {
    return {
      decision: "excluded",
      reason: exclusions.join(","),
      matchedKeywords: evidence,
      exclusionKeywords: exclusions,
      snippet,
    };
  }
  if (review.length) {
    return {
      decision: "review",
      reason: "low-confidence-double-penetration-keyword",
      matchedKeywords: evidence,
      snippet,
    };
  }
  if (!penetration) {
    return {
      decision: "excluded",
      reason: "penetration-not-evidenced",
      matchedKeywords: evidence,
      snippet,
    };
  }
  return { decision: "admit", reason: null, matchedKeywords: evidence, snippet };
}

interface WpPost {
  id?: unknown;
  link?: unknown;
  date?: unknown;
  date_gmt?: unknown;
  categories?: unknown;
  slug?: unknown;
  title?: { rendered?: unknown };
  content?: { rendered?: unknown };
  jetpack_featured_media_url?: unknown;
  _embedded?: { "wp:featuredmedia"?: { source_url?: unknown }[] };
}

/** Category 1 is shared/contaminated; only Royal Chinese posts pass it. */
export function categoryEligible(post: WpPost, categoryId: number): boolean {
  const categories = Array.isArray(post?.categories) ? post.categories : [];
  if (!categories.includes(categoryId)) return false;
  if (categoryId !== 1) return true;
  const fields = [decodeRenderedHtml(post.title?.rendered), decodeRenderedHtml(post.content?.rendered)];
  return fields.some((text) => /^(?:皇家|麻豆X皇家華人|麻豆X皇家华人)/.test(text.trim()));
}

export function parsePost(
  post: WpPost,
  category: StudioCategory,
  verdict: MadouquVerdict,
  { sourceUrl, base }: { sourceUrl: string; base: string },
): RawScene {
  const title = decodeRenderedHtml(post.title?.rendered);
  const body = decodeRenderedHtml(post.content?.rendered);
  const codeMatch = `${title}\n${body}`.match(/(?:番號|番号)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9._-]*)/);
  // `id` is the identity, but it is not guaranteed: without a fallback every
  // id-less post collapses onto the empty key `""`, and they then overwrite each
  // other in the dedupe map AND in the store's upsert. The permalink slug and
  // then the permalink itself are stable per post, so either is a usable key.
  const sourceSceneId = String(post.id ?? post.slug ?? post.link ?? "");
  const releaseUrl = String(post.link ?? "");
  return {
    sourceSceneId,
    title,
    releaseDate: String(post.date_gmt || post.date || "").slice(0, 10),
    performers: [],
    thumbnailUrl:
      (typeof post.jetpack_featured_media_url === "string" && post.jetpack_featured_media_url) ||
      (post._embedded?.["wp:featuredmedia"]?.[0]?.source_url as string | undefined) ||
      "",
    releaseUrl,
    source: "madouqu",
    studioCode: codeMatch?.[1] || undefined,
    tags: ["anal"],
    studioId: `madouqu-${category.key}`,
    studio: category.name,
    fieldProvenance: { decision: `madouqu:${verdict.decision}` },
    // A review post is kept in metadata and flagged, never silently admitted.
    metadataPoor: verdict.decision === "review",
    provenance: {
      source: "madouqu.com WordPress REST API",
      sourceUrl,
      recordUrl: releaseUrl,
      sourceSceneId,
      audit: {
        decision: verdict.decision,
        reason: verdict.reason ?? "matched",
        matchedKeywords: verdict.matchedKeywords.join(", "),
        category: category.name,
        categoryId: String(category.id),
        evidenceSnippet: verdict.snippet,
        base,
      },
    },
  };
}

/** Politeness-bounded JSON fetch: bounded spacing, 429 retry, hard error otherwise. */
export function createJsonFetcher({
  ctx,
  delayMs = 500,
  maxRetries = 3,
}: {
  ctx: SourceContext;
  delayMs?: number;
  maxRetries?: number;
}): (url: string) => Promise<{ json: unknown; headers: Headers }> {
  let lastRequest = 0;
  return async function fetchJson(url: string) {
    for (let attempt = 0; ; attempt += 1) {
      const wait = delayMs - (Date.now() - lastRequest);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastRequest = Date.now();
      const response = await ctx.fetcher.fetch(url, { headers: { accept: "application/json" } });
      if (response.status === 429 && attempt < maxRetries) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await new Promise((resolve) =>
          setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : Math.min(1000 * 2 ** attempt, 15_000)),
        );
        continue;
      }
      if (!response.ok) throw new Error(`madouqu request failed with HTTP ${response.status}`);
      return { json: await response.json(), headers: response.headers };
    }
  };
}

async function fetchCategoryPosts(
  category: StudioCategory,
  {
    fetchJson,
    postsUrl,
    after,
    maxPages = 1000,
  }: {
    fetchJson: (url: string) => Promise<{ json: unknown; headers: Headers }>;
    postsUrl: string;
    after: string;
    maxPages?: number;
  },
): Promise<WpPost[]> {
  const posts: WpPost[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(postsUrl);
    url.searchParams.set("categories", String(category.id));
    url.searchParams.set("per_page", String(PER_PAGE));
    url.searchParams.set("page", String(page));
    url.searchParams.set("_embed", "1");
    url.searchParams.set("after", after);
    url.searchParams.set("orderby", "date");
    url.searchParams.set("order", "desc");
    const { json, headers } = await fetchJson(url.href);
    if (!Array.isArray(json)) {
      throw new Error(`madouqu category ${category.id} returned a non-list response`);
    }
    const batch = json as WpPost[];
    posts.push(...batch);
    const totalPages = Number(headers.get("x-wp-totalpages")) || 1;
    if (page >= totalPages || batch.length === 0) break;
  }
  return posts;
}

export interface MadouquOptions {
  apiBase: string;
  maxPages?: number;
  delayMs?: number;
  /** Emit `review` verdicts in addition to `admit`. */
  includeReview?: boolean;
}

export function createMadouquStudio({
  apiBase,
  maxPages = 1000,
  delayMs = 500,
  includeReview = true,
}: MadouquOptions): SourceAdapter {
  const base = new URL(apiBase).origin;
  const postsUrl = `${apiBase.replace(/\/+$/, "")}/posts`;
  return {
    id: "madouqu",
    name: "Madouqu (mainland/Taiwan)",
    windowDays: 90,
    authority: { name: "madouqu.com WordPress REST API", url: postsUrl, role: "metadata catalogue" },
    // Metadata-only: this lane never enters the tube ladder.
    matcher: null,
    async fetch(windowStart, ctx): Promise<SourceResult> {
      const fetchJson = createJsonFetcher({ ctx, delayMs });
      const earliest = new Date(`${windowStart}T00:00:00Z`);
      const after = new Date(earliest.getTime() - DAY_MS).toISOString();
      const admitted = new Map<string, RawScene>();
      const review = new Map<string, RawScene>();

      for (const category of STUDIO_CATEGORIES) {
        const posts = await fetchCategoryPosts(category, { fetchJson, postsUrl, after, maxPages });
        for (const post of posts) {
          if (!categoryEligible(post, category.id)) continue;
          const verdict = classifyScene(post.title?.rendered, post.content?.rendered);
          if (verdict.decision === "excluded") {
            ctx.log(`madouqu: excluded post ${String(post.id)} (${verdict.reason})`, {
              category: category.name,
            });
            continue;
          }
          const scene = parsePost(post, category, verdict, { sourceUrl: postsUrl, base });
          if (!scene.sourceSceneId) {
            // No id, no slug and no permalink: there is nothing stable to key
            // this record on, and emitting it would collide with every other
            // keyless post. Skipped, loudly, rather than silently clobbered.
            ctx.log(`madouqu: skipped a post with no stable identity`, {
              category: category.name,
            });
            continue;
          }
          if (!scene.releaseDate) continue;
          const date = new Date(`${scene.releaseDate}T00:00:00Z`);
          if (Number.isNaN(date.getTime()) || date < earliest || date > ctx.now) continue;
          const key = `${category.key}:${scene.sourceSceneId}`;
          if (verdict.decision === "review") {
            admitted.delete(key);
            review.set(key, scene);
            continue;
          }
          if (!review.has(key) && !admitted.has(key)) admitted.set(key, scene);
        }
      }
      const reviewScenes = includeReview ? [...review.values()] : [];
      if (review.size && !includeReview) {
        ctx.log(`madouqu: ${review.size} review post(s) withheld`, {});
      }
      const scenes = [...admitted.values(), ...reviewScenes];
      return { scenes, verifiedEmpty: scenes.length === 0 };
    },
  };
}
