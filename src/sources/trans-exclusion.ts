/** Shared title/tag terms for the existing trans and cross-dressing exclusion. */
export const TRANS_EXCLUSION_TERMS: readonly string[] = Object.freeze([
  "トランスジェンダー",
  "性転換",
  "女装",
  "女装家",
  "偽娘",
  "男の娘",
  "女体化",
  "MtF",
  "FtM",
  "drag queen",
  "crossdress",
  "transgender",
  // Gay male content terms (Japanese)
  "マッチョ",
  "ゲイ",
  "男男",
  "ノンケ",
  "雄交尾",
  "雄穴",
]);

const TRANS_EXCLUSION_WORD_TERMS: readonly string[] = Object.freeze(["ts", "trans"]);
// ponytail: one prebuilt alternation over two static terms; a per-call RegExp
// per record is pure waste here. Build dynamically if the term list grows.
const TRANS_EXCLUSION_WORD_PATTERN = new RegExp(
  `(^|[^0-9a-z])(${TRANS_EXCLUSION_WORD_TERMS.join("|")})([^0-9a-z]|$)`,
  "i",
);

/** Return the first matching shared substring or whole-word exclusion term. */
export function findTransExclusion(text: string): string | null {
  const lower = text.toLowerCase();
  for (const term of TRANS_EXCLUSION_TERMS) {
    if (lower.includes(term.toLowerCase())) return term;
  }
  const wordMatch = text.match(TRANS_EXCLUSION_WORD_PATTERN);
  return wordMatch ? wordMatch[2]!.toLowerCase() : null;
}

// --------------------------------------------------------------- safety terms

/**
 * The safety exclusion, shared by the FC2 lane and anything else that reads a
 * title.
 *
 * Kept SEPARATE from the trans terms because they answer a different question:
 * these are the records the lane must never admit whatever the site's badge
 * says, while the trans terms are the studio's content preference.
 */
export const SAFETY_EXCLUSION_TERMS: readonly string[] = Object.freeze([
  "小学生",
  "中学生",
  "高校生",
  "幼児",
  "幼女",
  "児童",
  "子供",
  "子ども",
  "女の子",
  "未成年",
  "ロリ",
  "ペド",
  "loli",
  "lolicon",
  "shota",
  "underage",
]);

/** Whole-token Latin alternatives, so an unrelated word cannot satisfy them. */
const SAFETY_EXCLUSION_WORD_TERMS: readonly string[] = Object.freeze([
  "child",
  "children",
  "teen",
  "teens",
  "schoolgirl",
  "schoolboy",
  "femboy",
]);

/** A Latin substring match, so Japanese text cannot accidentally satisfy it. */
function matchesSafetyWord(haystack: string, term: string): boolean {
  return new RegExp(
    `(^|[^0-9a-z])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^0-9a-z]|$)`,
    "i",
  ).test(haystack);
}

/** Return the first safety exclusion present in a title, or null. */
export function findSafetyExclusion(text: string): string | null {
  const lower = text.toLowerCase();
  for (const term of SAFETY_EXCLUSION_TERMS) {
    if (lower.includes(term.toLowerCase())) return term;
  }
  for (const term of SAFETY_EXCLUSION_WORD_TERMS) {
    if (matchesSafetyWord(text, term)) return term;
  }
  return null;
}
