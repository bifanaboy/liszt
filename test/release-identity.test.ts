import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseIdentity } from "../src/pipeline/release-identity.ts";

test("the same page reached by different routes is one identity", () => {
  // The whole point: a Traxxx lane and the TPDB lane both emit the studio's own
  // release page, so the identity has to survive case, trailing slashes and
  // fragments.
  const a = "https://darkkotv.com/scenes/lana-analise-gaping-interracial-anal_vids.html";
  const b = "https://DarkKoTV.com/scenes/lana-analise-gaping-interracial-anal_vids.html/";
  assert.equal(releaseIdentity({ releaseUrl: a }), releaseIdentity({ releaseUrl: b }));
  assert.equal(
    releaseIdentity({ releaseUrl: `${a}#player` }),
    releaseIdentity({ releaseUrl: a }),
    "a fragment addresses a position in the page, not a different page",
  );
});

test("different pages are different identities", () => {
  assert.notEqual(
    releaseIdentity({ releaseUrl: "https://x.test/a" }),
    releaseIdentity({ releaseUrl: "https://x.test/b" }),
  );
  assert.notEqual(
    releaseIdentity({ releaseUrl: "https://x.test/scene?a=1" }),
    releaseIdentity({ releaseUrl: "https://x.test/scene?a=2" }),
    "a query string can distinguish two pages on one path",
  );
});

test("a record with no usable URL has no identity and is never a duplicate", () => {
  assert.equal(releaseIdentity({ releaseUrl: undefined }), undefined);
  assert.equal(releaseIdentity({ releaseUrl: "" }), undefined);
  assert.equal(releaseIdentity({ releaseUrl: "   " }), undefined);
});

test("an unparseable URL is still usable as evidence of sameness", () => {
  // Dropping an unidentifiable record would discard a release; two identical
  // unparseable strings are still evidence they are the same one.
  assert.equal(releaseIdentity({ releaseUrl: "not a url" }), "not a url");
  assert.notEqual(
    releaseIdentity({ releaseUrl: "not a url" }),
    releaseIdentity({ releaseUrl: "other" }),
  );
});
