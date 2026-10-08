export function parseClockDuration(value) {
  const match = String(value ?? "")
    .trim()
    .match(/^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match) return null;
  const [, first, second, third] = match;
  const seconds =
    third === undefined
      ? Number(first) * 60 + Number(second)
      : Number(first) * 3600 + Number(second) * 60 + Number(third);
  return seconds > 0 ? seconds : null;
}
