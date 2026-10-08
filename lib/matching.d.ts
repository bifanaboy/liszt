export interface SceneIdentity {
  title: string;
  performers: string[];
  releaseDate: string;
  durationSec: number | null;
  durationRange?: { minSec: number; maxSec: number };
  durationReview?: boolean;
  sceneCode?: string | null;
}
export interface TubeCandidate {
  title: string;
  duration?: number | string | null;
  url?: string;
  uploader?: unknown;
  user?: unknown;
  author?: unknown;
  username?: unknown;
  views?: number | string | null;
  added?: string | null;
}
export type IdentityTier = 0 | 1 | 2 | 3;
export type DateCheck = true | false | "unknown";
export interface PickOptions {
  durationToleranceSec?: number;
  dateWindowDays: number | null;
  requireIdentity?: boolean;
}
export interface PickResult {
  candidate: TubeCandidate;
  identityTier: IdentityTier;
  dateWindowApplied: boolean;
}
export const MATCH_DURATION_TOLERANCE_SEC: number;
export function repairMojibake(value: string | null | undefined): string;
export function matchTokens(value: string | null | undefined): string[];
export function normalizedText(value: string | null | undefined): string;
export function calendarDateUtc(year: number, month: number, day: number): number | null;
export function parseTimestamp(value: string | null | undefined): number | null;
export function toIsoUtc(value: string | null | undefined): string | null;
export function identityTier(scene: SceneIdentity, title: string): IdentityTier;
export function withinDateWindow(
  releaseDate: string,
  added: string | null | undefined,
  windowDays: number,
): DateCheck;
export function titleStem(value: string | null | undefined): string;
export function pickHighestViews(candidates: readonly TubeCandidate[]): TubeCandidate | null;
export function pickMatch(
  scene: SceneIdentity,
  candidates: TubeCandidate[],
  options: PickOptions,
): PickResult | null;
