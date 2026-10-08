declare module "*public/source-health.js" {
  /** How a source's last refresh went, judged from its error text. */
  export type SourceStatus = "ok" | "config" | "failing" | "unimplemented";

  /** The card badge state: both setup-gap statuses share SETUP REQUIRED. */
  export type SourceCardState = "ok" | "setup" | "error";

  export interface SourceHealth {
    label: SourceStatus;
    sceneCount: number;
    liveCount: number;
    matchPercent: number | null;
    lastSuccessAt: string | null;
  }

  export interface StudioChoice {
    labelId: string;
    label: string;
    sceneCount: number;
  }

  export function sourceScenes<T>(source: unknown, scenes: readonly T[]): T[];
  export function sourceHealth(source: unknown, scenes: readonly unknown[]): SourceHealth;
  export function classifySourceStatus(error: unknown): SourceStatus;
  export function sourceCardState(error: unknown): SourceCardState;
  export function sourceStateLabel(error: unknown): string;
  export function renderSourceHealth(source: unknown, scenes: readonly unknown[]): string;
  export function renderSourceHealthSummary(sources: readonly unknown[]): string;
  export function studioChoices(scenes: readonly unknown[]): StudioChoice[];
  export function visibleSourceStatuses<T>(sources: readonly T[]): T[];
}
