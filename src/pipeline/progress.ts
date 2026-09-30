/**
 * Live progress for one refresh cycle, in memory only.
 *
 * WHY NOT SQLITE. The counters move on every completed unit of work - six
 * sources, then one step per link, up to ~121 of them, then a re-verify slice -
 * and every one of those is a write against the same database the cycle is
 * already using. Persisting progress would turn an in-memory tally into several
 * hundred transactions per cycle, and the numbers would be wrong the moment the
 * process restarted. The run ledger keeps the OUTCOME; the tracker keeps the
 * now, and a restart legitimately shows no bar until the next cycle.
 *
 * WHY ONE TRACKER. `createSync` is the only entry point for all three refresh
 * triggers - the boot sync, the interval, and `POST /api/refresh` - because
 * `app.ts` wraps the pool index and the sync in one single-flight runner. A
 * second refresh joins the first, so there is only ever one run to describe.
 * `begin()` resets everything, which is what makes that true.
 *
 * WHY CLAMPS. The dashboard renders these straight into `aria-valuenow` and
 * into a percentage width. A counter that could exceed its own total - or go
 * backwards - would render as a bar past 100% and read as a bug in the app
 * rather than in the network it was watching.
 */

export type SyncStage =
  "idle" | "indexing" | "populating" | "linking" | "verifying" | "finishing" | "error";

/** One step per trusted pool account. */
export interface IndexProgress {
  done: number;
  total: number;
  /** The account most recently completed; empty until one finishes. */
  current: string;
}

/** One step per configured source, counted on completion whether it passed or failed. */
export interface PopulateProgress {
  done: number;
  total: number;
  /** Sources currently in flight, for the caption. */
  current: string[];
}

export interface LinkProgress {
  /** Eligible scenes resolved. */
  done: number;
  /** The queue length actually processed, after `lookups.limit`. */
  total: number;
  /** Resolutions that produced a verified link. */
  matched: number;
  substage: "resolve" | "verify";
  verifyDone: number;
  verifyTotal: number;
}

export interface SyncProgress {
  active: boolean;
  runId: string | null;
  startedAt: string | null;
  stage: SyncStage;
  index: IndexProgress;
  populate: PopulateProgress;
  link: LinkProgress;
}

export interface ProgressTracker {
  /** Reset every counter and mark the run active. One cycle, one call. */
  begin(runId: string, startedAt: string, totals: { sources: number; uploaders: number }): void;
  stage(stage: Exclude<SyncStage, "idle" | "error">): void;
  /** One trusted pool account finished, successfully or not. */
  indexStep(done: number, total: number, uploader: string): void;
  /** A source entered the fan-out. */
  sourceStart(sourceId: string): void;
  /** A source left the fan-out. Counted as an ATTEMPT, not a success. */
  sourceDone(sourceId: string): void;
  /** The resolve queue is known; its length is the denominator. */
  linkStart(total: number): void;
  /** One resolve finished. `done` is a completion count, never an index. */
  linkStep(done: number, total: number, matched: number): void;
  verifyStart(total: number): void;
  verifyStep(done: number, total: number): void;
  /** The cycle threw. The counters stay as they were, for the caption. */
  fail(): void;
  /** The cycle completed. `active` goes false and the snapshot stops moving. */
  finish(): void;
  /** A deep copy, so a response can never observe a half-written object. */
  snapshot(): SyncProgress;
}

function emptyProgress(): SyncProgress {
  return {
    active: false,
    runId: null,
    startedAt: null,
    stage: "idle",
    index: { done: 0, total: 0, current: "" },
    populate: { done: 0, total: 0, current: [] },
    link: { done: 0, total: 0, matched: 0, substage: "resolve", verifyDone: 0, verifyTotal: 0 },
  };
}

function clone(progress: SyncProgress): SyncProgress {
  return {
    ...progress,
    index: { ...progress.index },
    populate: { ...progress.populate, current: [...progress.populate.current] },
    link: { ...progress.link },
  };
}

/**
 * Clamp `value` to `[0, max]`, rounded to an integer, mapping anything
 * unparseable to 0. A negative or fractional count is a caller bug, and a bar
 * that renders it faithfully is worse than one that renders nothing.
 */
function count(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const whole = Math.floor(value);
  return Number.isFinite(max) && max > 0 ? Math.min(whole, max) : whole;
}

/**
 * A denominator, or 0. `Math.max(0, Math.floor(NaN))` is `NaN`, not 0 - and a
 * `NaN` total reaches the browser as a `NaN` percentage and a bar with no width.
 */
function denominator(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function createProgressTracker(): ProgressTracker {
  let state = emptyProgress();

  return {
    begin(runId, startedAt, totals) {
      // Reset here, not in `finish()`: a crashed cycle must not leave counters
      // behind for the next reader to mistake for a live run.
      state = emptyProgress();
      state.active = true;
      state.runId = runId;
      state.startedAt = startedAt;
      state.stage = "indexing";
      state.index.total = denominator(totals.uploaders);
      state.populate.total = denominator(totals.sources);
    },

    stage(stage) {
      if (!state.active) return;
      state.stage = stage;
    },

    indexStep(done, total, uploader) {
      if (!state.active) return;
      state.index.total = denominator(total);
      state.index.done = count(done, state.index.total);
      state.index.current = uploader;
    },

    sourceStart(sourceId) {
      if (!state.active) return;
      if (!state.populate.current.includes(sourceId)) state.populate.current.push(sourceId);
    },

    sourceDone(sourceId) {
      if (!state.active) return;
      state.populate.current = state.populate.current.filter((id) => id !== sourceId);
      state.populate.done = Math.min(
        state.populate.total || Number.MAX_SAFE_INTEGER,
        state.populate.done + 1,
      );
    },

    linkStart(total) {
      if (!state.active) return;
      state.link.substage = "resolve";
      state.link.total = denominator(total);
      state.link.done = 0;
      state.link.matched = 0;
    },

    linkStep(done, total, matched) {
      if (!state.active) return;
      state.link.substage = "resolve";
      state.link.total = denominator(total);
      state.link.done = count(done, state.link.total);
      state.link.matched = count(matched, state.link.total);
    },

    verifyStart(total) {
      if (!state.active) return;
      state.link.substage = "verify";
      state.link.verifyTotal = denominator(total);
      state.link.verifyDone = 0;
    },

    verifyStep(done, total) {
      if (!state.active) return;
      state.link.substage = "verify";
      state.link.verifyTotal = denominator(total);
      state.link.verifyDone = count(done, state.link.verifyTotal);
    },

    fail() {
      if (!state.active) return;
      state.stage = "error";
      state.active = false;
    },

    finish() {
      if (!state.active) return;
      state.active = false;
      state.stage = "idle";
    },

    snapshot() {
      return clone(state);
    },
  };
}

/** An inactive snapshot, for callers that have no tracker. */
export function idleProgress(): SyncProgress {
  return emptyProgress();
}
