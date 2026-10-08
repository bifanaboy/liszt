const DECORATION_WORDS = new Set(["new", "watch", "download"]);
const DAY_MS = 86_400_000;
export function repairMojibake(value) {
    const text = String(value ?? "");
    if (!/[\u0080-\u00ff]/.test(text))
        return text;
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (code > 0xff)
            return text;
        bytes[index] = code;
    }
    try {
        return new globalThis.TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    catch {
        return text;
    }
}
export function matchTokens(value) {
    return (repairMojibake(value)
        .normalize("NFKC")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .match(/[a-z0-9]+/g) ?? []);
}
export function normalizedText(value) {
    return matchTokens(value).join(" ");
}
export function calendarDateUtc(year, month, day) {
    if (!Number.isInteger(year) || year < 1 || year > 9999)
        return null;
    if (!Number.isInteger(month) || month < 1 || month > 12)
        return null;
    if (!Number.isInteger(day) || day < 1 || day > 31)
        return null;
    const time = Date.UTC(year, month - 1, day);
    const date = new Date(time);
    if (date.getUTCFullYear() !== year)
        return null;
    if (date.getUTCMonth() + 1 !== month)
        return null;
    if (date.getUTCDate() !== day)
        return null;
    return time;
}
function hasZoneDesignator(text) {
    return /(?:Z|z|[+-]\d{2}:?\d{2})$/.test(text.trim());
}
export function parseTimestamp(value) {
    const text = String(value ?? "").trim();
    if (!text)
        return null;
    const zoneless = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (zoneless) {
        const day = calendarDateUtc(Number(zoneless[1]), Number(zoneless[2]), Number(zoneless[3]));
        if (day === null)
            return null;
        const hour = Number(zoneless[4]);
        const minute = Number(zoneless[5]);
        const second = Number(zoneless[6] ?? 0);
        if (hour > 23 || minute > 59 || second > 59)
            return null;
        return day + hour * 3_600_000 + minute * 60_000 + second * 1000;
    }
    const dayOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dayOnly)
        return calendarDateUtc(Number(dayOnly[1]), Number(dayOnly[2]), Number(dayOnly[3]));
    if (!hasZoneDesignator(text) && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) {
        const pinned = Date.parse(`${text}Z`);
        if (Number.isFinite(pinned))
            return pinned;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
}
export function toIsoUtc(value) {
    const parsed = parseTimestamp(value);
    return parsed === null ? null : new Date(parsed).toISOString();
}
export function identityTier(scene, title) {
    const candidateTokens = matchTokens(title);
    const candidate = new Set(candidateTokens);
    const joined = ` ${candidateTokens.join(" ")} `;
    const sceneTitle = normalizedText(scene.title);
    if (sceneTitle.length > 0 && joined.includes(` ${sceneTitle} `))
        return 3;
    const code = matchTokens(scene.sceneCode);
    if (code.length > 0 && code.every((token) => candidate.has(token)))
        return 3;
    let best = 0;
    for (const name of scene.performers) {
        const tokens = matchTokens(name);
        if (!tokens.length)
            continue;
        if (tokens.every((token) => candidate.has(token)))
            return 2;
        const first = tokens[0];
        if (best < 1 &&
            (candidate.has(first) ||
                candidateTokens.some((token) => new RegExp(`^${first}\\d{3,4}$`).test(token)))) {
            best = 1;
        }
    }
    return best;
}
export function withinDateWindow(releaseDate, added, windowDays) {
    const release = parseTimestamp(releaseDate);
    if (release === null)
        return "unknown";
    const uploaded = parseTimestamp(added);
    if (uploaded === null)
        return "unknown";
    return uploaded >= release - DAY_MS && uploaded < release + (windowDays + 1) * DAY_MS;
}
export function titleStem(value) {
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
export const MATCH_DURATION_TOLERANCE_SEC = 1;
function resolveTolerance(value) {
    if (value === undefined)
        return MATCH_DURATION_TOLERANCE_SEC;
    return Number.isFinite(value) && value >= 0 ? value : MATCH_DURATION_TOLERANCE_SEC;
}
function viewCount(candidate) {
    const raw = candidate.views;
    if (typeof raw === "number")
        return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== "string")
        return null;
    const digits = raw.replace(/[,\s]/g, "").replace(/(?:views?|k|m)$/i, "");
    if (!/^\d+(\.\d+)?$/.test(digits))
        return null;
    const value = Number(digits);
    if (!Number.isFinite(value))
        return null;
    const suffix = /(k|m)$/i.exec(raw.trim());
    if (suffix)
        return value * (/^m$/i.test(suffix[1]) ? 1_000_000 : 1_000);
    return value;
}
export function pickHighestViews(candidates) {
    let best = null;
    let bestViews = null;
    for (const candidate of candidates) {
        const views = viewCount(candidate);
        if (best === null) {
            best = candidate;
            bestViews = views;
            continue;
        }
        const wins = (views !== null && bestViews === null) ||
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
function rank(scene, left, right) {
    if (left.tier !== right.tier)
        return right.tier - left.tier;
    const leftViews = viewCount(left.candidate);
    const rightViews = viewCount(right.candidate);
    if (leftViews !== rightViews) {
        if (leftViews === null)
            return 1;
        if (rightViews === null)
            return -1;
        return rightViews - leftViews;
    }
    if (left.lag !== right.lag)
        return left.lag - right.lag;
    return String(left.candidate.url || "").localeCompare(String(right.candidate.url || ""));
}
export function pickMatch(scene, candidates, options) {
    const tolerance = resolveTolerance(options.durationToleranceSec);
    const range = scene.durationRange;
    if (scene.durationReview)
        return null;
    if ((!Number.isFinite(scene.durationSec) || (scene.durationSec ?? 0) <= 0) &&
        (!range || range.minSec <= 0 || range.maxSec < range.minSec))
        return null;
    const release = parseTimestamp(scene.releaseDate);
    const bestByStem = new Map();
    for (const candidate of candidates) {
        const duration = Number(candidate.duration);
        if (!Number.isFinite(duration))
            continue;
        const delta = range
            ? Math.max(range.minSec - duration, 0, duration - range.maxSec)
            : Math.abs(duration - (scene.durationSec ?? 0));
        if (delta > tolerance)
            continue;
        if (options.dateWindowDays !== null) {
            if (withinDateWindow(scene.releaseDate, candidate.added, options.dateWindowDays) !== true) {
                continue;
            }
        }
        const stem = titleStem(candidate.title);
        if (!stem)
            continue;
        const uploaded = parseTimestamp(candidate.added);
        const scored = {
            candidate,
            tier: identityTier(scene, candidate.title),
            lag: release === null || uploaded === null ? Number.POSITIVE_INFINITY : uploaded - release,
        };
        const current = bestByStem.get(stem);
        if (!current || rank(scene, scored, current) < 0)
            bestByStem.set(stem, scored);
    }
    const best = survivors(scene, bestByStem, options);
    if (!best)
        return null;
    return {
        candidate: best.candidate,
        identityTier: best.tier,
        dateWindowApplied: options.dateWindowDays !== null,
    };
}
function survivors(scene, bestByStem, options) {
    const groups = [...bestByStem.values()];
    const eligible = options.requireIdentity ? groups.filter((scored) => scored.tier > 0) : groups;
    return eligible.sort((left, right) => rank(scene, left, right))[0];
}
