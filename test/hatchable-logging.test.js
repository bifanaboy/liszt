import assert from "node:assert/strict";
import test from "node:test";
import { logProviderFailure, sanitizeFailureSummary } from "../lib/logging.js";

test("stored provider failure summaries remove credentials and truncate response bodies", () => {
  assert.equal(
    sanitizeFailureSummary(
      "Bearer top-secret https://example.com/?token=also-secret <html>private body</html>",
      ["top-secret", "also-secret"],
    ),
    "Bearer [redacted] https://example.com/?token=[redacted] [response body omitted]",
  );
  assert.equal(
    sanitizeFailureSummary('Provider returned {"private":"page body"}'),
    "Provider returned [response body omitted]",
  );
});

test("provider failures use a bounded native log entry and redact secrets", () => {
  const entries = [];
  const restore = console.error;
  console.error = (entry) => entries.push(entry);
  try {
    logProviderFailure(
      {
        runId: "run-1",
        provider: "tpdb",
        stage: "fetch",
        occurredAt: "2026-10-08T00:00:00.000Z",
        summary: "Bearer top-secret request https://example.com/?api_key=also-secret returned 503",
      },
      { secrets: ["top-secret", "also-secret"] },
    );
  } finally {
    console.error = restore;
  }
  assert.equal(entries.length, 1);
  assert.deepEqual(JSON.parse(entries[0]), {
    event: "provider_failure",
    runId: "run-1",
    provider: "tpdb",
    stage: "fetch",
    occurredAt: "2026-10-08T00:00:00.000Z",
    summary: "Bearer [redacted] request https://example.com/?api_key=[redacted] returned 503",
  });
});

test("provider failure logs reject invalid labels and cap summaries", () => {
  const entries = [];
  const restore = console.error;
  console.error = (entry) => entries.push(entry);
  try {
    assert.throws(() => logProviderFailure({ runId: "bad\nvalue" }));
    logProviderFailure({
      runId: "run-2",
      provider: "provider",
      stage: "fetch",
      occurredAt: "2026-10-08T00:00:00.000Z",
      summary: "x".repeat(1000),
    });
  } finally {
    console.error = restore;
  }
  assert.equal(JSON.parse(entries[0]).summary.length, 240);
});
