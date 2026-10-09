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
