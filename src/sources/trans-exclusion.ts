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

/** Return the first matching shared substring or whole-word exclusion term. */
export function findTransExclusion(text: string): string | null {
  const lower = text.toLowerCase();
  for (const term of TRANS_EXCLUSION_TERMS) {
    if (lower.includes(term.toLowerCase())) return term;
  }
  for (const term of TRANS_EXCLUSION_WORD_TERMS) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^0-9a-z])${escaped}([^0-9a-z]|$)`, "i").test(text)) return term;
  }
  return null;
}
