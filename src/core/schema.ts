/**
 * The canonical domain schema. Every record crosses exactly one parse boundary
 * (`parseAtBoundary`); nothing downstream re-validates.
 *
 * Three shapes here are load-bearing, and each fixes a bug a previous
 * implementation shipped by structure rather than by convention:
 *
 *  - Release dates are date-only UTC (`DateOnly`). A full timestamp does not
 *    parse, so a timestamp can never be silently dropped by window arithmetic.
 *  - Scene identity is the id, `<source-id>:<source-scene-id>`. Upserts
 *    converge on repeat syncs instead of duplicating.
 *  - Provenance is required. A scene without a record of where it came from is
 *    a parse failure, not a row with an empty array.
 */
import { z } from "zod";

/** `YYYY-MM-DD`, no time component, validated as a real calendar date. */
export const DateOnly = z.iso.date();

export const IsoTimestamp = z.string().datetime({ offset: true });

export const VideoLinkSource = z.enum(["sxyprn", "eporner"]);
export type VideoLinkSource = z.infer<typeof VideoLinkSource>;

export const VideoLink = z.object({
  source: VideoLinkSource,
  url: z.string().url(),
  verifiedAt: IsoTimestamp,
  /** How many consecutive definitive re-verify failures this link has taken. */
  verifyFailures: z.number().int().nonnegative().default(0),
  /**
   * Position within a verified multipart release, 1-based. OPTIONAL, and never
   * present outside FC2.
   *
   * FC2 releases are routinely uploaded to eporner as several files by one
   * account, and the lane is allowed to link all of them. It may only call them
   * parts when every grouped upload carries the SAME uploader and a DIFFERENT
   * duration - two uploads from different accounts are two releases that happen
   * to share a code, and two uploads of identical length are the same file
   * twice. Absent means "not part of a verified group", which is the state of
   * every ordinary link and of an FC2 link with a single exact-code result.
   */
  part: z.number().int().positive().optional(),
});
export type VideoLink = z.infer<typeof VideoLink>;

export const DeadVideoLink = z.object({
  source: VideoLinkSource,
  url: z.string().url(),
  deadAt: IsoTimestamp,
  deadReason: z.string().min(1),
});
export type DeadVideoLink = z.infer<typeof DeadVideoLink>;

/**
 * The evidence behind a resolved link.
 *
 * `confidence` is the winner's IDENTITY TIER, collapsed to two values:
 * `low` means tier 0 - the candidate's title carried no evidence naming the
 * performer or reusing the scene's own wording. Those are the legacy links
 * worth eyeballing by hand; the current ladder's identity gate does not create
 * them; the terminal fallback now creates them only after all tubes have
 * declined to produce a named match. Tiers 1, 2 and 3 all read `high`, because a
 * first-name-only match is a real match and flagging those as suspect would
 * swamp the signal.
 *
 * Note what this is NOT: a date measurement. Every stored link cleared the same
 * duration band and the same upload window, so "how close was the upload" says
 * nothing about whether the link is right.
 */
export const VideoMatching = z.object({
  /** The rung that produced the link, or `none` for a metadata-only lane. */
  lane: z.string().min(1),
  matchedAt: IsoTimestamp,
  /** The eligibility rule and ranking chain that admitted it. */
  rule: z.string().min(1),
  confidence: z.enum(["high", "low"]).default("high"),
});
export type VideoMatching = z.infer<typeof VideoMatching>;

export const Provenance = z.object({
  source: z.string().min(1),
  fetchedAt: IsoTimestamp,
  sourceUrl: z.string().optional(),
  recordUrl: z.string().optional(),
  sourceSceneId: z.string().optional(),
  /** An audit trail for the source's own decision (e.g. a classifier verdict). */
  audit: z.record(z.string(), z.string()).optional(),
});
export type Provenance = z.infer<typeof Provenance>;

export const SceneBase = z.object({
  /** `<source-id>:<source-scene-id>`. Identity, and the upsert key. */
  id: z.string().min(1),
  /** The lane's sub-label id when one source emits several labels. */
  sourceId: z.string().min(1),
  source: z.string().min(1),
  /** The sub-label id; equal to `sourceId` for a source's primary label. */
  labelId: z.string().min(1),
  /** The display label; a lane may emit one per sub-label. */
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
  /** The label's own release code, e.g. madouqu `xb6340`. */
  studioCode: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).default([]),
  /** Never empty: a scene without provenance is a parse failure. */
  provenance: z.array(Provenance).min(1),
  /** Per-field provenance, e.g. `{ durationSec: "studio-site" }`. */
  fieldProvenance: z.record(z.string(), z.string()).default({}),
  /** True when the source page could not supply a field the gate needs. */
  metadataPoor: z.boolean().default(false),
  /** Split-mode feed record omitted both its studio id and display name. */
  studioIdentityMissing: z.boolean().default(false),
  videoUrls: z.array(VideoLink).default([]),
  deadVideoUrls: z.array(DeadVideoLink).default([]),
  /** Last attempt to read the studio's own release details, when applicable. */
  studioMetadataCheckedAt: IsoTimestamp.nullable().default(null),
  videoCheckedAt: IsoTimestamp.nullable().default(null),
  videoMatching: VideoMatching.nullable().default(null),
});

export const Scene = SceneBase;
export type Scene = z.infer<typeof Scene>;

/** Per-source health. `sourceId` is canonical; one source may emit labels. */
export const SourceStatus = z.object({
  sourceId: z.string().min(1),
  name: z.string().default(""),
  /** The sub-label id, equal to `sourceId` for the source's own primary label. */
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
  /** The matcher lane declares, or `null` for a metadata-only lane. */
  matcher: z.string().min(1).nullable().default(null),
  lastSuccessAt: IsoTimestamp.nullable().default(null),
  lastError: z.string().min(1).nullable().default(null),
  sceneCount: z.number().int().nonnegative().default(0),
});

export type SourceStatus = z.infer<typeof SourceStatus>;
/** The pre-default input shape, so callers may omit defaulted fields. */
export type SourceStatusInput = z.input<typeof SourceStatus>;

export const RunOutcome = z.object({
  source: z.string().min(1),
  ok: z.boolean(),
  count: z.number().int().nonnegative().default(0),
  error: z.string().min(1).optional(),
});
export type RunOutcome = z.infer<typeof RunOutcome>;

export const RunKind = z.enum(["sync"]);
export type RunKind = z.infer<typeof RunKind>;

/** Parse helper that names the boundary in the error, so failures are legible. */
export function parseAtBoundary<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  boundary: string,
): z.infer<S> {
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
  readonly boundary: string;

  constructor(boundary: string, detail: string) {
    super(`Schema violation at ${boundary}: ${detail}`);
    this.name = "SchemaBoundaryError";
    this.boundary = boundary;
  }
}
