/**
 * The explicit boundaries between pure logic and the outside world. `core/`
 * imports only these; adapters implement them. This is what keeps the matching
 * core callable with no network and makes every adapter fixture-testable.
 */

/** What a source adapter emits, before normalisation. */
export interface RawScene {
  sourceSceneId: string;
  title: string;
  releaseDate: string;
  performers: string[];
  durationSec?: number | null;
  thumbnailUrl?: string;
  releaseUrl?: string;
  /** The label's own release code, e.g. madouqu `xb6340`. */
  studioCode?: string;
  tags?: string[];
  source?: string;
  provenance?: {
    source: string;
    sourceUrl?: string;
    recordUrl?: string;
    sourceSceneId?: string;
    /** An audit trail for the source's own decision, e.g. a classifier verdict. */
    audit?: Record<string, string>;
  };
  /** Per-field provenance, e.g. `{ durationSec: "studio-site" }`. */
  fieldProvenance?: Record<string, string>;
  metadataPoor?: boolean;
  /** A sub-label identity, when one source emits several studio labels. */
  studioId?: string;
  studio?: string;
}

export interface FetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
}

/** A minimal fetch surface with real failure semantics (timeout, classification). */
export interface Fetcher {
  fetch(url: string, options?: FetchOptions): Promise<Response>;
  text(url: string, options?: FetchOptions): Promise<string>;
  json<T = unknown>(url: string, options?: FetchOptions): Promise<T>;
}

/** The context every adapter and tube source receives. */
export interface SourceContext {
  fetcher: Fetcher;
  log(message: string, fields?: Record<string, unknown>): void;
  /** The injected clock, so window arithmetic is deterministic under test. */
  now: Date;
  /** Politeness bounds for the traxxx client (spacing + cache TTL). */
  traxxx?: { minIntervalMs?: number; cacheTtlMs?: number };
  /** Bound the fan-out of any adapter-local concurrency. */
  mapWithConcurrency<T, R>(items: T[], task: (item: T, index: number) => Promise<R>): Promise<R[]>;
  /**
   * The same fan-out with a PRIVATE counter. An adapter's own fan-out runs
   * inside the cycle's per-source fan-out, so it must not draw from the shared
   * (non-re-entrant) pool above - at the limit the inner acquire would wait for
   * work only the inner acquire can start.
   */
  mapIsolated<T, R>(items: T[], task: (item: T, index: number) => Promise<R>): Promise<R[]>;
}

/** The result of one source fetch. */
export interface SourceLabel {
  labelId: string;
  label: string;
  sceneCount: number;
}

export interface SourceResult {
  scenes: RawScene[];
  /**
   * Explicitly true when the source really has no matching records. A result
   * with no scenes and `verifiedEmpty: false` is treated as suspicious and
   * fails the run, which keeps the source's last-good records.
   */
  verifiedEmpty: boolean;
  /** Child labels emitted by one parent polling lane. */
  labels?: SourceLabel[];
}

/**
 * A catalogue source for one lane. "Source" is the canonical term: one source
 * may emit several studio labels.
 */
export interface SourceAdapter {
  readonly id: string;
  readonly name: string;
  readonly authority: { name: string; url: string; role: string };
  /** `null` declares a metadata-only lane: no tube matching is attempted. */
  readonly matcher: string | null;
  /** A creator studio builds performer-only queries. */
  readonly creatorStudio?: boolean;
  /** Fetch this lane's releases within the window. Throw to preserve last-good. */
  fetch(windowStart: string, ctx: SourceContext): Promise<SourceResult>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A fixed clock for tests. */
export function fixedClock(at: string): Clock {
  const date = new Date(at);
  return { now: () => new Date(date) };
}
