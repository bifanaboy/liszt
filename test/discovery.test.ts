/**
 * Uploader discovery: the uploader parser, the identity score, and the tally.
 *
 * Offline. The page markup is transcribed from a live video page fetched
 * 2026-09-30, and the scene is the reported one - a 1847s Brazilian scene whose
 * real video turned out to be posted by `DYaM`, an account outside
 * `LISZT_TRUSTED_UPLOADERS`. That single case is the whole reason this module
 * exists, so it is the fixture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeEvidence,
  evidenceScore,
  parseVideoUploader,
  proposeUploaders,
  scoreIdentityAgreement,
  type UploaderObservation,
} from "../src/tubes/discovery.ts";
import { makeMatchScene } from "./helpers.ts";

test("the uploader is read from the video page's vit-uploader link, and only from there", () => {
  // The markup is transcribed from a live page fetched 2026-09-30. The page
  // carries SEVERAL `/profile/` links - this one plus a "more from this
  // uploader" list, a suggester carousel and navigation - so a parser that
  // simply took the first profile href would confidently name the wrong
  // account. Only `vit-uploader` is the account that posted THIS video.
  const page = `<!doctype html><html><body>
  <nav><a href="/profile/Grimrist/">some other account</a></nav>
  <ul>
    <li class="vit-category"><a href="/categories/anal/">anal</a></li>
    <li class="vit-uploader"><a href="/profile/DYaM/" title="Uploader">DYaM</a></li>
    <li class="vit-subscribe"><a href="/profile/DYaM/subscribe/">subscribe</a></li>
  </ul>
  <div class="vit-suggester"><a href="/profile/Vovick17/">more like this</a></div>
  </body></html>`;
  assert.equal(parseVideoUploader(page), "DYaM");
  // Attribute order and extra classes must not matter: the class list is a set.
  assert.equal(
    parseVideoUploader(
      '<li class="row vit-uploader boxed"><a href="/profile/Vovick17/">Vovick17</a></li>',
    ),
    "Vovick17",
  );
  // A page with no uploader element is null, never a guess. An anti-bot wall
  // has no uploader, and inventing one is the exact failure this tool exists to
  // avoid - it would put a fabricated account on the trusted list.
  assert.equal(parseVideoUploader("<html><body>Just a moment...</body></html>"), null);
  assert.equal(parseVideoUploader(""), null);
  // A `vit-uploader` element with no profile link in it is also null.
  assert.equal(parseVideoUploader('<li class="vit-uploader">deleted</li>'), null);
});

test("the uploader name comes from the href, not the display text", () => {
  // The href is what the profile index walks, so a name taken from it is
  // directly usable as a `LISZT_TRUSTED_UPLOADERS` entry. The display text is
  // localised, truncated and decorated, so a name taken from it has to be
  // translated by a human - and a proposal that needs translating is a proposal
  // that gets mistyped onto the trusted list.
  const page =
    '<li class="vit-uploader"><a href="/profile/Chrishunter1836/" title="Uploader">Chrishunter1836 (12,613 subs)</a></li>';
  assert.equal(parseVideoUploader(page), "Chrishunter1836");
});

const scene = makeMatchScene({
  id: "mambo-perv:725786",
  title: "Brazilian ebony hot wife, Vivian Fernandes fucked by a big black dick OB670",
  performers: ["Vivian Fernandes"],
  sceneCode: "OB670",
  releaseDate: "2026-09-26",
  durationSec: 1847,
});

test("identity is what scores a candidate, and duration is not", () => {
  // The reason this tool is not "find videos of the right length". At a
  // one-second band, unrelated half-hour videos collide constantly: measured
  // over 46 live links, 20 of the 46 winners were the wrong video and every one
  // of them was within two seconds. Duration says "plausible"; only the title
  // says "this is the scene".
  const decoy = scoreIdentityAgreement(scene, "Aceita Dupla Penetracao");
  assert.equal(decoy.tier, 0);
  assert.equal(evidenceScore(decoy), 0, "a plausible-length decoy is worth nothing");

  // Shared studio wording is allowed as weaker identity evidence even when it
  // does not name a performer or carry the scene code. Duration is still not
  // part of the score.
  const wording = scoreIdentityAgreement(scene, "Brazilian ebony compilation");
  assert.equal(wording.tier, 0);
  assert.ok(evidenceScore(wording) > 0);

  const firstNameOnly = scoreIdentityAgreement(scene, "Vivian compilation 03");
  assert.equal(firstNameOnly.tier, 1);
  assert.ok(evidenceScore(firstNameOnly) > 0, "a first name is weak but real evidence");

  const fullName = scoreIdentityAgreement(scene, "Vivian Fernandes Brazilian ebony");
  assert.equal(fullName.tier, 2);
  assert.deepEqual(fullName.namedPerformers, ["Vivian Fernandes"]);

  // The scene code is the strongest single signal: it is the studio's own
  // retrieval key, and an unrelated upload does not carry it by accident.
  const code = scoreIdentityAgreement(scene, "Brazilian ebony OB670 4some");
  assert.equal(code.tier, 3);
  assert.deepEqual(code.codeTokens, ["ob670"]);
  assert.ok(evidenceScore(code) > evidenceScore(fullName), "code evidence outranks a bare name");
  // And reusing the studio's wording adds to the total without carrying it
  // alone: two unrelated videos could share phrasing.
  assert.ok(describeEvidence(code).includes("scene code"));
  assert.equal(describeEvidence(decoy), "no identity evidence");
});

test("an account is proposed only from evidence, and a trusted one is marked", () => {
  const observation = (over: Partial<UploaderObservation> & { uploader: string }) => ({
    videoId: "v1",
    title: "Vivian Fernandes OB670",
    views: 500,
    sceneId: scene.id,
    sceneTitle: scene.title,
    performers: scene.performers,
    durationDeltaSec: 0,
    agreement: scoreIdentityAgreement(scene, "Vivian Fernandes OB670"),
    score: 5,
    ...over,
  });

  const proposals = proposeUploaders(
    [
      // A real signal: this account keeps posting things that name the scene.
      observation({ uploader: "DYaM", videoId: "v1" }),
      observation({ uploader: "DYaM", videoId: "v2", sceneId: "other:1" }),
      // No identity evidence at any duration, so it contributes nothing -
      // including the observation where the duration is a perfect match.
      observation({
        uploader: "LongVideoGuy",
        videoId: "v3",
        title: "Aceita Dupla Penetracao",
        durationDeltaSec: 0,
        agreement: scoreIdentityAgreement(scene, "Aceita Dupla Penetracao"),
        score: 0,
      }),
      // Already trusted: reported, so a re-run is not mistaken for a discovery.
      observation({ uploader: "Vovick17", videoId: "v4" }),
    ],
    ["Vovick17", "KJUIUI"],
  );

  const names = proposals.map((proposal) => proposal.uploader);
  assert.ok(names.includes("DYaM"), "an account with evidence is proposed");
  assert.ok(!names.includes("LongVideoGuy"), "an account with only length agreement is not");
  // Already-trusted accounts ARE reported, marked, and filtered out by the
  // caller. Hiding them would make a re-run indistinguishable from a fresh
  // discovery, which is what the `alreadyTrusted` flag exists to prevent.
  const dYaM = proposals.find((proposal) => proposal.uploader === "DYaM")!;
  assert.equal(dYaM.alreadyTrusted, false);
  assert.equal(dYaM.distinctScenes, 2, "two distinct scenes, not two rows");
  assert.equal(
    proposals.find((proposal) => proposal.uploader === "Vovick17")!.alreadyTrusted,
    true,
  );
  // Accounts with no evidence never reach the tally at all, so `LongVideoGuy`
  // has no entry to be missing from - the filter is upstream of the sort.
  assert.equal(proposals.length, 2);
  assert.deepEqual(
    proposals.filter((proposal) => !proposal.alreadyTrusted).map((proposal) => proposal.uploader),
    ["DYaM"],
    "only untrusted accounts are candidates",
  );
});

test("a duration artefact is visible in the proposal, so a reader can catch it", () => {
  // A median delta of 0 across every observation is what a genuine match looks
  // like. Surfacing it is a cheap check against the failure mode the module
  // cannot rule out on its own: an account whose videos are all about as long
  // as the scenes we missed would also produce deltas near zero if any of its
  // titles happened to collide with a performer name.
  const rows = [0, 0, 1, 2, 4].map((delta, index) => ({
    uploader: "Someone",
    videoId: `v${index}`,
    title: "Vivian Fernandes",
    views: 10,
    sceneId: scene.id,
    sceneTitle: scene.title,
    performers: scene.performers,
    durationDeltaSec: delta,
    agreement: scoreIdentityAgreement(scene, "Vivian Fernandes"),
    score: 2,
  }));
  assert.equal(proposeUploaders(rows, [])[0]!.medianDurationDeltaSec, 1);
  assert.equal(proposeUploaders([], [])[0], undefined, "an empty tally proposes nothing");
});

test("profile escapes decode when valid and fall back to display text when malformed", () => {
  assert.equal(
    parseVideoUploader('<li class="vit-uploader"><a href="/profile/Some%20Name/">display</a></li>'),
    "Some Name",
  );
  assert.equal(
    parseVideoUploader(
      '<li class="vit-uploader"><a href="/profile/bad%ZZ/">  Display Name </a></li>',
    ),
    "Display Name",
  );
  assert.equal(
    parseVideoUploader('<li class="vit-uploader"><a href="/profile/bad%ZZ/"></a></li>'),
    null,
  );
});
