/**
 * fc2cmadb.com - a DELIBERATE STUB, not an oversight.
 *
 * The site's interface is unconfirmed: it is absent from both reference repos,
 * and it may be a keyless JSON API, a key/login-gated API, or an HTML scrape.
 * Rather than guess, the lane ships as a full `SourceAdapter` with a real
 * registry entry, a real health card, and fixture tests - but a `throw` body.
 *
 * Two properties are load-bearing and are asserted in `test/fc2cmadb.test.ts`:
 *  - It never reports `verifiedEmpty: true`. A stub that "found nothing" would
 *    look like a source that genuinely has no FC2 releases, and the retention
 *    rule would then delete the lane's last-good records. Throwing keeps them.
 *  - It fails with a NAMED, calm message. A missing interface is a setup
 *    problem, not an outage, and the dashboard renders it as SETUP REQUIRED.
 *
 * To finish the lane: replace `fetch` with a real client, keep
 * `verifiedEmpty` honest, and add a fixture under `test/fixtures/`.
 */
import type { SourceAdapter, SourceContext, SourceResult } from "./types.ts";

export const FC2CMADB_ID = "fc2cmadb";
export const FC2CMADB_LANE = "FC2";

/** Thrown by the stub. Distinct so a test and the health card can name it. */
export class Fc2CmadbNotImplementedError extends Error {
  constructor() {
    super(
      "fc2cmadb.com is not implemented: its interface is unconfirmed. This is a setup gap, not a source outage; the FC2 lane has no records and the other lanes are unaffected.",
    );
    this.name = "Fc2CmadbNotImplementedError";
  }
}

export function createFc2CmadbStudio(): SourceAdapter {
  return {
    id: FC2CMADB_ID,
    name: "FC2 (fc2cmadb)",
    authority: {
      name: "fc2cmadb.com",
      url: "https://fc2cmadb.com",
      role: "unconfirmed - stub",
    },
    // A real matcher lane: FC2 releases are not filtered out of tube matching
    // on the assumption that they will not resolve.
    matcher: "sxyprn+eporner",
    async fetch(_windowStart: string, _ctx: SourceContext): Promise<SourceResult> {
      throw new Fc2CmadbNotImplementedError();
    },
  };
}
