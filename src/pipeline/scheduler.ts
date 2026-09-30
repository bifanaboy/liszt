/**
 * Scheduling primitives for the polling cycle.
 *
 * `createSingleFlight` is the one that matters: the boot sync, the interval,
 * and `POST /api/refresh` all funnel through the SAME in-flight promise, so two
 * cycles can never run at once against the same SQLite file. A request that
 * arrives mid-cycle simply joins the running one instead of starting a second.
 *
 * `createScheduler` is a thin `setInterval` wrapper with a real `stop()` so
 * shutdown can clear the timer before closing the store.
 */
import type { Logger } from "../core/logger.ts";

/**
 * Collapse concurrent calls into one in-flight run. Every caller receives the
 * same promise; when it settles, the next call starts fresh.
 */
export function createSingleFlight<T>(task: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const started = task();
    // Keep an unawaited rejection from surfacing as an unhandled rejection; the
    // real caller still observes the rejection through the returned promise.
    started.catch(() => {});
    const run = started.finally(() => {
      if (inFlight === run) inFlight = null;
    });
    inFlight = run;
    return run;
  };
}

export interface Scheduler {
  start(): void;
  /** Clear the timer and, by default, wait for the in-flight cycle. */
  stop(): Promise<void>;
  /** True while a cycle is in flight. Read by the refresh endpoint/read model. */
  busy(): boolean;
}

export interface SchedulerOptions {
  intervalMs: number;
  run: () => Promise<unknown>;
  log: Logger;
  /**
   * Called on `stop()` with the signal for the in-flight cycle, so a caller that
   * can cancel work early may do so. The current composition root does not - a
   * cycle is bounded by per-request timeouts, and the store close is deferred
   * until `stop()` resolves - so this is an extension point rather than a
   * dependency. The wait below happens with or without it.
   */
  onStop?: (signal: AbortSignal) => void;
  /** How long `stop()` waits for the in-flight cycle before giving up. */
  stopTimeoutMs?: number;
}

const DEFAULT_STOP_TIMEOUT_MS = 30_000;

export function createScheduler({
  intervalMs,
  run,
  log,
  onStop,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
}: SchedulerOptions): Scheduler {
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let controller: AbortController | null = null;

  const tick = (): void => {
    if (inFlight) return;
    const current = new AbortController();
    controller = current;
    const settled: Promise<void> = run()
      .then(() => {})
      .catch((error) => log.error("scheduled cycle failed", { error: (error as Error).message }))
      .finally(() => {
        if (inFlight === settled) inFlight = null;
        if (controller === current) controller = null;
      });
    inFlight = settled;
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
      log.info("scheduler started", { intervalMs });
    },
    /**
     * Stop, and WAIT for the cycle that is already running.
     *
     * `clearInterval` alone stopped the NEXT cycle and left the current one
     * running: shutdown then closed the SQLite file underneath an in-flight
     * sync, which surfaces as `SQLITE_BUSY` or a write on a closed handle
     * rather than as a clean exit. The abort signal is offered first so a
     * cooperative cycle can wind down, and the wait is bounded so a wedged
     * source cannot hold shutdown open forever.
     */
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      const pending = inFlight;
      if (!pending) return;
      onStop?.(controller?.signal ?? new AbortController().signal);
      let guardTimer: NodeJS.Timeout | undefined;
      const guard = new Promise<void>((resolve) => {
        guardTimer = setTimeout(() => {
          log.warn("scheduler: cycle still running at stop, giving up on it", { stopTimeoutMs });
          resolve();
        }, stopTimeoutMs);
        guardTimer.unref?.();
      });
      try {
        await Promise.race([pending, guard]);
      } finally {
        if (guardTimer) clearTimeout(guardTimer);
      }
    },
    busy: () => inFlight !== null,
  };
}