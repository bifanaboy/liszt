/** Conservative audit associations. Originals stay separate; no provider wins. */
import { z } from "zod";
import { DateOnly, parseAtBoundary } from "./schema.ts";
import { normalizedText } from "./matching.ts";

export const CATALOGUE_PROVIDERS = ["tpdb", "stashdb", "traxxx", "manyvids"] as const;
export type CatalogueProvider = (typeof CATALOGUE_PROVIDERS)[number];
const RecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1),
  releaseDate: DateOnly,
  durationSec: z.number().int().positive().nullable().default(null),
});
export type CatalogueRecord = z.input<typeof RecordSchema>;
export type CoverageRecord = z.output<typeof RecordSchema> & { provider: CatalogueProvider };
export interface CatalogueCoverage {
  unionCount: number;
  ambiguousPairs: number;
  providers: Record<
    CatalogueProvider,
    { available: boolean; records: number; covered: number; coverage: number | null }
  >;
  groups: CoverageRecord[][];
}

function sameRelease(a: CoverageRecord, b: CoverageRecord): boolean {
  if (a.provider === b.provider || a.durationSec === null || b.durationSec === null) return false;
  if (Math.abs(a.durationSec - b.durationSec) > 3) return false;
  if (Math.abs(Date.parse(a.releaseDate) - Date.parse(b.releaseDate)) > 2 * 86_400_000)
    return false;
  const words = (value: string) => new Set(normalizedText(value).split(/\s+/).filter(Boolean));
  const left = words(a.title),
    right = words(b.title);
  const common = [...left].filter((word) => right.has(word)).length;
  const union = new Set([...left, ...right]).size;
  return union > 0 && common / union >= 0.8;
}

export function catalogueCoverage(
  input: Partial<Record<CatalogueProvider, readonly CatalogueRecord[]>>,
): CatalogueCoverage {
  const records = CATALOGUE_PROVIDERS.flatMap((provider) => {
    const seen = new Set<string>();
    return (input[provider] ?? [])
      .map((raw) => {
        const record = parseAtBoundary(RecordSchema, raw, `coverage.${provider}`);
        if (seen.has(record.id))
          throw new Error(`coverage.${provider}: duplicate record id ${record.id}`);
        seen.add(record.id);
        return { ...record, provider };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  });
  const candidates = records.map(() => new Map<CatalogueProvider, number[]>());
  const pairs: [number, number][] = [];
  for (let a = 0; a < records.length; a++) {
    for (let b = a + 1; b < records.length; b++) {
      if (!sameRelease(records[a]!, records[b]!)) continue;
      pairs.push([a, b]);
      for (const [from, to] of [
        [a, b],
        [b, a],
      ] as const) {
        const provider = records[to]!.provider;
        candidates[from]!.set(provider, [...(candidates[from]!.get(provider) ?? []), to]);
      }
    }
  }
  const groups = records.map((_, index) => [index]);
  let ambiguousPairs = 0;
  for (const [a, b] of pairs) {
    if (
      candidates[a]!.get(records[b]!.provider)!.length !== 1 ||
      candidates[b]!.get(records[a]!.provider)!.length !== 1
    ) {
      ambiguousPairs++;
      continue;
    }
    const left = groups.find((group) => group.includes(a))!;
    const right = groups.find((group) => group.includes(b))!;
    if (left === right) continue;
    // Every member must agree: do not bridge a chain of loosely related titles
    // or dates, and do not swallow two records from the same provider.
    if (!left.every((i) => right.every((j) => sameRelease(records[i]!, records[j]!)))) continue;
    left.push(...right);
    right.length = 0;
  }
  const result = groups
    .filter((group) => group.length)
    .map((group) => group.sort((a, b) => a - b).map((index) => records[index]!));
  const providers = Object.fromEntries(
    CATALOGUE_PROVIDERS.map((provider) => {
      const covered = result.filter((group) =>
        group.some((record) => record.provider === provider),
      ).length;
      return [
        provider,
        {
          available: input[provider] !== undefined,
          records: records.filter((record) => record.provider === provider).length,
          covered,
          coverage: input[provider] !== undefined && result.length ? covered / result.length : null,
        },
      ];
    }),
  ) as CatalogueCoverage["providers"];
  return { unionCount: result.length, ambiguousPairs, providers, groups: result };
}
