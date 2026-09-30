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
  stop(): void;
  /** True while a cycle is in flight. Read by the refresh endpoint/read model. */
  busy(): boolean;
}

export interface SchedulerOptions {
  intervalMs: number;
  run: () => Promise<unknown>;
  log: Logger;
}

export function createScheduler({ intervalMs, run, log }: SchedulerOptions): Scheduler {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  const tick = (): void => {
    running = true;
    run()
      .catch((error) => log.error("scheduled cycle failed", { error: (error as Error).message }))
      .finally(() => {
        running = false;
      });
  };
  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
      log.info("scheduler started", { intervalMs });
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    busy: () => running,
  };
}