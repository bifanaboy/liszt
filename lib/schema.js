import { z } from "./validation.js";
export const DateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected a date-only value (YYYY-MM-DD)")
  .refine((value) => {
    const [y, m, d] = value.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }, "not a real calendar date");
export const IsoTimestamp = z.string().datetime({ offset: true });
export const VideoLinkSource = z.enum(["sxyprn", "eporner", "eporner-pool"]);
export const VideoLink = z.object({
  source: VideoLinkSource,
  url: z.string().url(),
  verifiedAt: IsoTimestamp,
  verifyFailures: z.number().int().nonnegative().default(0),
  part: z.number().int().positive().optional(),
});
export const DeadVideoLink = z.object({
  source: VideoLinkSource,
  url: z.string().url(),
  deadAt: IsoTimestamp,
  deadReason: z.string().min(1),
});
export const VideoMatching = z.object({
  lane: z.string().min(1),
  matchedAt: IsoTimestamp,
  rule: z.string().min(1),
  confidence: z.enum(["high", "low"]).default("high"),
});
export const Provenance = z.object({
  source: z.string().min(1),
  fetchedAt: IsoTimestamp,
  sourceUrl: z.string().optional(),
  recordUrl: z.string().optional(),
  sourceSceneId: z.string().optional(),
  audit: z.record(z.string(), z.string()).optional(),
});
export const SceneBase = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  source: z.string().min(1),
  labelId: z.string().min(1),
  label: z.string().default(""),
  title: z.string().min(1),
  performers: z.array(z.string().min(1)).default([]),
  releaseDate: DateOnly,
  durationSec: z.number().int().positive().nullable().default(null),
  durationRange: z
    .object({ minSec: z.number().int().positive(), maxSec: z.number().int().positive() })
    .refine((range) => range.minSec <= range.maxSec, "duration range is reversed")
    .optional(),
  durationReview: z.boolean().default(false),
  thumbnailUrl: z.string().default(""),
  releaseUrl: z.string().url().optional(),
  storeId: z.string().regex(/^\d+$/).optional(),
  launchDate: IsoTimestamp.optional(),
  previewUrl: z.string().url().optional(),
  price: z
    .object({
      regular: z.string().regex(/^\d+(?:\.\d+)?$/),
      onSale: z.boolean(),
      free: z.boolean(),
    })
    .optional(),
  studioCode: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).default([]),
  provenance: z.array(Provenance).min(1),
  fieldProvenance: z.record(z.string(), z.string()).default({}),
  metadataPoor: z.boolean().default(false),
  studioIdentityMissing: z.boolean().default(false),
  videoUrls: z.array(VideoLink).default([]),
  deadVideoUrls: z.array(DeadVideoLink).default([]),
  studioMetadataCheckedAt: IsoTimestamp.nullable().default(null),
  videoCheckedAt: IsoTimestamp.nullable().default(null),
  videoMatching: VideoMatching.nullable().default(null),
});
export const Scene = SceneBase;
export const SourceStatus = z.object({
  sourceId: z.string().min(1),
  name: z.string().default(""),
  labelId: z.string().min(1),
  label: z.string().default(""),
  authority: z
    .object({
      name: z.string().min(1),
      url: z.string(),
      role: z.string().default("Catalogue source"),
    })
    .nullable()
    .default(null),
  creatorStudio: z.boolean().default(false),
  windowDays: z.number().int().positive().default(90),
  matcher: z.string().min(1).nullable().default(null),
  lastSuccessAt: IsoTimestamp.nullable().default(null),
  lastError: z.string().min(1).nullable().default(null),
  sceneCount: z.number().int().nonnegative().default(0),
});
export const RunOutcome = z.object({
  source: z.string().min(1),
  ok: z.boolean(),
  count: z.number().int().nonnegative().default(0),
  error: z.string().min(1).optional(),
});
export const RunKind = z.enum(["sync"]);
export const Fc2Status = z.enum(["accepted", "excluded", "pending"]);
export function parseAtBoundary(schema, value, boundary) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new SchemaBoundaryError(boundary, detail);
  }
  return result.data;
}
export class SchemaBoundaryError extends Error {
  boundary;
  constructor(boundary, detail) {
    super(`Schema violation at ${boundary}: ${detail}`);
    this.name = "SchemaBoundaryError";
    this.boundary = boundary;
  }
}
