/**
 * Resolve studio URLs into a checked-in declaration.
 *
 * Adding a studio to the watchlist means pasting the URLs you have - a Traxxx
 * listing and/or a ThePornDB studio page - and getting back the declaration the
 * app reads. This command does that against the live databases and prints the
 * result, so the answer is never a guess made by a language model:
 *
 *   npm run link-studios -- "https://traxxx.me/network/brazzers/scenes/latest/1" \
 *                              "https://theporndb.net/sites/brazzers"
 *
 * Rules it will not bend:
 *   - A studio that does not resolve to exactly one TPDB site is reported
 *     unresolved, with the candidates TPDB does have. It is not bound to a
 *     near-match. A wrong link files another studio's releases under this one.
 *   - A transport failure is reported as a failure, not as "no such studio".
 *
 * With `--write <file>` it merges the resolved studios into an existing
 * declaration file, so the file is the ongoing record rather than something
 * retyped by hand.
 */
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { HttpFetcher } from "../core/fetcher.ts";
import { parseTraxxxListingUrl, type TraxxxLaneSpec } from "../sources/traxxx-watchlist.ts";
import { buildDeclaration } from "./link-studios-declaration.ts";
import {
  auditStudioLinks,
  parseTpdbStudioUrl,
  resolveTpdbSite,
  studioAliases,
  TPDB_WEB_HOSTS,
  TRAXXX_WEB_HOSTS,
  type StudioLink,
} from "../sources/studio-identity.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    write: { type: "string" },
    name: { type: "string" },
    help: { type: "boolean" },
  },
});

const out = (line: string) => process.stdout.write(`${line}\n`);

if (values.help || positionals.length === 0) {
  out(
    "Usage: npm run link-studios -- [options] <traxxx-url> [tpdb-url] [name]\n\n" +
      "Resolves the pasted studio URLs against the live databases and prints a\n" +
      "declaration for LISZT_STUDIO_LINKS.\n\n" +
      "Options:\n" +
      "  --name <text>    Studio display name. Defaults to the Traxxx slug.\n" +
      "  --write <file>   Merge the resolved studios into a declaration file.\n" +
      "  --help           Show this message.\n\n" +
      "Either side may be omitted: a studio may exist on one side only.\n",
  );
  process.exit(values.help ? 0 : 1);
}

const config = loadConfig();
if (!config.tpdbApiKey) {
  throw new Error("TPDB_API_KEY is not set; cannot resolve a studio");
}
const fetcher = new HttpFetcher(config.fetchTimeoutMs);

const [traxxxUrl, tpdbUrl, positionalName] = positionals;
const displayName = values.name ?? positionalName;

// The two URLs are told apart by host, not by position. An operator pasting a
// TPDB-only studio should not have to remember which argument is which, and a
// Traxxx URL passed as the TPDB argument must not be silently resolved as one.
const urls = [traxxxUrl, tpdbUrl].filter((value): value is string => value !== undefined);
for (const url of urls) {
  const host = new URL(url).hostname;
  if (![...TRAXXX_WEB_HOSTS, ...TPDB_WEB_HOSTS].includes(host)) {
    throw new Error(
      `Unsupported studio URL host ${host}: expected a traxxx.me or theporndb.net URL`,
    );
  }
}
const traxxxInput = urls.find((url) => TRAXXX_WEB_HOSTS.includes(new URL(url).hostname));
const tpdbInput = urls.find((url) => TPDB_WEB_HOSTS.includes(new URL(url).hostname));

const lane: TraxxxLaneSpec | undefined = traxxxInput
  ? parseTraxxxListingUrl(traxxxInput)
  : undefined;
const lookup = tpdbInput ? parseTpdbStudioUrl(tpdbInput) : undefined;

const resolved = lookup
  ? await resolveTpdbSite(fetcher, config.tpdbApiKey, {
      candidates: lookup.candidates,
      ...(lookup.uuid ? { uuid: lookup.uuid } : {}),
      // The display name is what verifies a loose slug match. Without one the
      // lookup can only be exact, so a name is required for a name-only URL.
      ...(displayName ? { name: displayName } : lookup.name ? { name: lookup.name } : {}),
    })
  : undefined;

const studio = displayName ?? (lane ? lane.slug.replace(/-/g, " ") : undefined);
if (!studio) {
  throw new Error("A studio display name is required: pass --name, or a Traxxx URL to derive one");
}

// Either side may be omitted: a Traxxx-only paste is a valid declaration, so a
// missing TPDB side is not an error here.
const link: StudioLink = buildDeclaration({
  ...(lookup ? { lookup } : {}),
  ...(resolved?.site ? { resolved: resolved.site } : {}),
  ...(lane ? { lane } : {}),
  studioName: studio,
});

out(`studio       ${link.studio}`);
out(`studioId     ${link.studioId}`);
out(`aliases      ${studioAliases(link).join(" | ")}`);
if (link.traxxx) {
  out(
    `traxxx       ${link.traxxx.kind}/${link.traxxx.slug}${link.tags?.length ? ` tags=${link.tags.join(",")}` : ""}`,
  );
} else {
  out("traxxx       (none given)");
}
if (link.tpdb) {
  out(
    `tpdb         site ${link.tpdb.siteId} "${link.tpdb.name}" via ${resolved?.site?.resolvedBy}`,
  );
  if (link.tpdb.uuid) out(`             uuid ${link.tpdb.uuid}`);
} else if (resolved) {
  out(`tpdb         UNRESOLVED (${resolved.outcome})`);
  for (const candidate of resolved.candidates) {
    out(
      `             candidate ${candidate.id} "${candidate.name}"${candidate.shortName ? ` (${candidate.shortName})` : ""}`,
    );
  }
  out(
    "             Not bound. Add a TPDB URL for this studio, or a --name that matches TPDB exactly.",
  );
}

if (values.write) {
  let existing: StudioLink[] = [];
  try {
    existing = JSON.parse(readFileSync(values.write, "utf8"));
  } catch {
    // A missing file is the normal first run.
  }
  const merged = [...existing.filter((entry) => entry.studioId !== link.studioId), link];
  const conflicts = auditStudioLinks(merged);
  if (conflicts.length) {
    out("");
    out(`NOT WRITTEN - the merged declaration is inconsistent: ${conflicts.join("; ")}`);
    process.exit(1);
  }
  writeFileSync(values.write, `${JSON.stringify(merged, null, 2)}\n`);
  out("");
  out(`written      ${values.write} (${merged.length} studios)`);
  out("set          LISZT_STUDIO_LINKS=<that path>");
} else {
  out("");
  out("declaration:");
  out(JSON.stringify([link], null, 2));
}
