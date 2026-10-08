import { epornerVideoId, validEpornerUrl } from "./eporner.js";
const EPORNER_SEARCH = "https://www.eporner.com/api/v2/video/search/";
const EPORNER_WATCH = "https://www.eporner.com";
export const FC2_EPORNER_RULE =
  "fc2-eporner: exact release code as a whole token in the title; uploader read per candidate; multipart only from one uploader with distinct durations";
export const DEFAULT_FC2_SEARCH_PAGES = 3;
export const DEFAULT_FC2_SEARCH_PAGE_SIZE = 20;
export const DEFAULT_FC2_RELATED_BOUND = 6;
export const DEFAULT_FC2_EPORNER_INTERVAL_MS = 750;
export function fc2ReleaseCode(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return text;
  const labelled = text.match(/FC2[\s_-]*PPV[\s_-]*(\d{4,})/i);
  if (labelled) return labelled[1];
  const articles = text.match(/\/articles\/(\d{4,})(?:\b|$)/);
  if (articles) return articles[1];
  return null;
}
export function titleContainsExactCode(title, code) {
  if (!/^\d+$/.test(code)) return false;
  return new RegExp(`(?<!\\d)${code}(?!\\d)`).test(String(title ?? ""));
}
export function fc2EpornerSearchUrl(code, page, perPage) {
  const url = new URL(EPORNER_SEARCH);
  url.searchParams.set("query", code);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));
  url.searchParams.set("lq", "0");
  url.searchParams.set("format", "json");
  return url.href;
}
export const fc2EpornerWatchUrl = (id) => `${EPORNER_WATCH}/video-${id}/`;
function positiveSeconds(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}
function extractVideoRows(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const videos = body.videos;
    if (Array.isArray(videos)) return videos;
  }
  return [];
}
export function parseFc2EpornerSearch(body, code) {
  const out = [];
  const seen = new Set();
  for (const row of extractVideoRows(body)) {
    const id = row?.id === undefined || row?.id === null ? "" : String(row.id).trim();
    const title = typeof row?.title === "string" ? row.title : "";
    if (!id || !title) continue;
    if (typeof row.url !== "string" || !validEpornerUrl(row.url)) continue;
    if (seen.has(row.url) || !epornerVideoId(row.url)) continue;
    if (!titleContainsExactCode(title, code)) continue;
    seen.add(row.url);
    out.push({
      id,
      url: row.url,
      title,
      durationSec: positiveSeconds(row.length_sec),
      uploader: null,
    });
  }
  return out;
}
function stripComments(html) {
  return String(html ?? "").replace(/<!--[\s\S]*?-->/g, " ");
}
export function epornerUploaderFromPage(html) {
  const block =
    stripComments(html).match(
      /<li\b[^>]*class=["'][^"']*\bvit-uploader\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/i,
    )?.[1] ?? "";
  const account = block.match(
    /<a\b[^>]*href=["'][^"']*\/profile\/([A-Za-z0-9._~-]+)\/[^"']*["'][^>]*>/i,
  )?.[1];
  return account ?? null;
}
export function epornerDurationFromPage(html) {
  for (const meta of stripComments(html).matchAll(/<meta\b[^>]*>/gi)) {
    if (!/\bproperty=["']og:duration["']/i.test(meta[0])) continue;
    const seconds = meta[0].match(/\bcontent=["'](\d+)["']/i)?.[1];
    return seconds ? positiveSeconds(seconds) : null;
  }
  return null;
}
export function relatedFc2VideoIds(html, code, { bound = 6, exclude = new Set() } = {}) {
  const source = stripComments(html);
  const anchor =
    /<a\b[^>]*href=["']([^"']*\/(?:video-|hd-porn\/)([A-Za-z0-9]+)[^"']*)["'][^>]*>([\s\S]{0,400}?)<\/a>/g;
  const ids = [];
  const seen = new Set();
  let match;
  while (ids.length < bound && (match = anchor.exec(source)) !== null) {
    const id = match[2];
    if (!id || seen.has(id) || exclude.has(id)) continue;
    const slug =
      match[1].replace(/^.*\/(?:video-|hd-porn\/)[A-Za-z0-9]+\/?/, "").split(/[?#]/)[0] ?? "";
    const haystack = `${slug.replace(/[-_/]+/g, " ")} ${match[3].replace(/<[^>]+>/g, " ")}`;
    if (!titleContainsExactCode(haystack, code)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
function titlePartNumber(title, code) {
  const found = [];
  for (const match of title.matchAll(/(?:\bpart|パート)\s*[[._:-]*\s*([1-9]\d*)\b/gi))
    found.push(Number(match[1]));
  if (code && /^\d+$/.test(code)) {
    const suffix = new RegExp(`(?<!\\d)${code}[ _.-]+([1-9]\\d*)(?=$|[\\s\\[\\]()._-])`, "g");
    for (const match of title.matchAll(suffix)) found.push(Number(match[1]));
  }
  const distinct = new Set(found);
  return distinct.size === 1 && Number.isSafeInteger(found[0]) ? found[0] : null;
}
export function groupMultipart(candidates, code) {
  const parts = new Map();
  if (candidates.length < 2) return parts;
  const uploaders = new Set(candidates.map((candidate) => candidate.uploader ?? ""));
  if (uploaders.size !== 1 || uploaders.has("")) return parts;
  const durations = candidates.map((candidate) => candidate.durationSec);
  if (durations.some((duration) => duration === null)) return parts;
  if (new Set(durations).size !== durations.length) return parts;
  const releaseCode =
    code ??
    fc2ReleaseCode(candidates[0]?.title) ??
    candidates[0]?.title.match(/^\s*(\d{4,})(?:\D|$)/)?.[1] ??
    null;
  const numbers = candidates.map((candidate) => titlePartNumber(candidate.title, releaseCode));
  if (numbers.some((number) => number === null) || new Set(numbers).size !== numbers.length)
    return parts;
  candidates.forEach((candidate, index) => parts.set(candidate.url, numbers[index]));
  return parts;
}
const defaultSleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
export function createFc2EpornerResolver(
  fetcher,
  {
    searchPages = DEFAULT_FC2_SEARCH_PAGES,
    searchPageSize = DEFAULT_FC2_SEARCH_PAGE_SIZE,
    relatedBound = DEFAULT_FC2_RELATED_BOUND,
    minIntervalMs = DEFAULT_FC2_EPORNER_INTERVAL_MS,
    sleep = defaultSleep,
  } = {},
) {
  const gate = { at: 0 };
  let readTail = Promise.resolve();
  function read(url) {
    const result = readTail.then(() => pacedRead(url));
    readTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async function pacedRead(url) {
    const wait = minIntervalMs - (Date.now() - gate.at);
    if (wait > 0) await sleep(wait);
    gate.at = Date.now();
    try {
      const response = await fetcher.fetch(url, {
        headers: { accept: "application/json,text/html" },
      });
      if (!response.ok) return { error: `${url} -> HTTP ${response.status}` };
      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      if (type && !type.includes("json") && !type.includes("html")) {
        return { error: `${url} -> unusable body (${type})` };
      }
      return { body: await response.text() };
    } catch (error) {
      return { error: `${url} -> ${error.message}` };
    }
  }
  async function hydrateCandidate(candidate, code, related, budget) {
    const page = await read(candidate.url);
    if (!("body" in page)) return page.error;
    const title = titleFromPage(page.body);
    if (!title || !titleContainsExactCode(title, code))
      return `${candidate.url} -> no readable exact-code video`;
    candidate.uploader = epornerUploaderFromPage(page.body);
    candidate.durationSec = epornerDurationFromPage(page.body);
    if (related.length < budget) {
      related.push(
        ...relatedFc2VideoIds(page.body, code, {
          bound: budget - related.length,
          exclude: new Set([candidate.id]),
        }),
      );
    }
    return null;
  }
  return async function lookup(code) {
    const trimmed = fc2ReleaseCode(code);
    if (!trimmed)
      return { links: [], code: null, pagesRead: 0, candidatePagesRead: 0, relatedFollowed: 0 };
    const pages = Math.max(1, Math.floor(searchPages));
    const admitted = new Map();
    let pagesRead = 0;
    const searchRowsSeen = new Set();
    let firstError = null;
    for (let page = 1; page <= pages; page += 1) {
      const result = await read(fc2EpornerSearchUrl(trimmed, page, searchPageSize));
      if (!("body" in result)) {
        firstError = firstError ?? result.error;
        break;
      }
      let parsed;
      try {
        parsed = JSON.parse(result.body);
      } catch {
        firstError = firstError ?? "the eporner search response was not JSON";
        break;
      }
      if (
        !Array.isArray(parsed) &&
        (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.videos))
      ) {
        firstError = firstError ?? "the eporner API returned a malformed search response";
        break;
      }
      pagesRead += 1;
      const rawRows = extractVideoRows(parsed);
      if (!rawRows.length) break;
      const newRows = rawRows.filter((row) => !searchRowsSeen.has(String(row.id)));
      for (const row of rawRows) searchRowsSeen.add(String(row.id));
      if (!newRows.length) break;
      const rows = parseFc2EpornerSearch(parsed, trimmed);
      for (const row of rows) {
        if (admitted.has(row.id)) continue;
        admitted.set(row.id, row);
      }
    }
    if (!pagesRead) {
      return {
        links: [],
        code: trimmed,
        pagesRead: 0,
        candidatePagesRead: 0,
        relatedFollowed: 0,
        ...(firstError ? { error: firstError } : {}),
      };
    }
    const related = [];
    let candidatePagesRead = 0;
    for (const candidate of admitted.values()) {
      const error = await hydrateCandidate(candidate, trimmed, related, Math.max(0, relatedBound));
      candidatePagesRead += 1;
      firstError = firstError ?? error;
      if (error) admitted.delete(candidate.id);
    }
    let relatedFollowed = 0;
    const walked = new Set(admitted.keys());
    while (related.length > 0 && relatedFollowed < relatedBound) {
      const id = related.shift();
      if (walked.has(id)) continue;
      walked.add(id);
      relatedFollowed += 1;
      const page = await read(fc2EpornerWatchUrl(id));
      candidatePagesRead += 1;
      if (!("body" in page)) {
        firstError = firstError ?? page.error;
        continue;
      }
      const title = titleFromPage(page.body);
      if (title === null || !titleContainsExactCode(title, trimmed)) continue;
      const candidate = {
        id,
        url: fc2EpornerWatchUrl(id),
        title,
        durationSec: epornerDurationFromPage(page.body),
        uploader: epornerUploaderFromPage(page.body),
      };
      if (!admitted.has(candidate.id)) admitted.set(candidate.id, candidate);
      const remaining = Math.max(0, relatedBound - relatedFollowed - related.length);
      related.push(
        ...relatedFc2VideoIds(page.body, trimmed, { bound: remaining, exclude: walked }),
      );
    }
    const final = [...admitted.values()];
    const parts = groupMultipart(final, trimmed);
    return {
      links: final.map((candidate) => ({
        url: candidate.url,
        uploader: candidate.uploader,
        ...(parts.has(candidate.url) ? { part: parts.get(candidate.url) } : {}),
      })),
      code: trimmed,
      pagesRead,
      candidatePagesRead,
      relatedFollowed,
      ...(firstError ? { error: firstError } : {}),
    };
  };
}
export function titleFromPage(html) {
  const heading = stripComments(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const text = (heading ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}
