/** Remove common credential material and remote response bodies from diagnostics. */
export function sanitizeErrorMessage(value: unknown, secrets: readonly string[] = []): string {
  let message = value instanceof Error ? value.message : String(value);
  message = message
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /([?&](?:api[_-]?key|key|token|secret|password|authorization|auth)=)[^&#\s]*/gi,
      "$1[redacted]",
    )
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[redacted]@");
  for (const secret of secrets.filter((item) => item.length > 0))
    message = message.replaceAll(secret, "[redacted]");
  message = message.replace(/\s*<[^>]+>[\s\S]*$/, " [response body omitted]");
  message = message.replace(/\s*\{(?=\s*["'][^"']+["']\s*:)[\s\S]*$/, " [response body omitted]");
  return message.slice(0, 240);
}
