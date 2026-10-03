export interface SourceHealth {
  label: "ok" | "config" | "failing";
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
export function studioChoices(scenes: readonly unknown[]): StudioChoice[];
export function visibleSourceStatuses<T>(sources: readonly T[]): T[];
