export const systemClock = { now: () => new Date() };
export function fixedClock(at) {
  const date = new Date(at);
  return { now: () => new Date(date) };
}
