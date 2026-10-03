export const MAIN_CATALOGUE: "catalogue";
export const ASIAN_CATALOGUE: "asian";

/** A catalogue page id, or null when the value names no page (e.g. `#sources`). */
export function catalogueId(value: unknown): "catalogue" | "asian" | null;
/** Asian membership is decided by `sourceId`, so sub-labels follow their source. */
export function isAsian(row: unknown, asianSourceIds: readonly string[]): boolean;
export function inCatalogue(
  row: unknown,
  catalogue: string,
  asianSourceIds: readonly string[],
): boolean;
export function catalogueScenes<T>(scenes: readonly T[], catalogue: string, asianSourceIds: readonly string[]): T[];
export interface CatalogueStats {
  total: number;
  live: number;
  matchPercent: number | null;
}
export function catalogueStats(
  scenes: readonly unknown[],
  catalogue: string,
  asianSourceIds: readonly string[],
): CatalogueStats;
