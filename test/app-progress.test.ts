import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { sourceScenes, studioChoices, visibleSourceStatuses } from "../public/source-health.js";
import {
  ASIAN_CATALOGUE,
  MAIN_CATALOGUE,
  catalogueId,
  catalogueScenes,
  catalogueStats,
  inCatalogue,
} from "../public/catalogues.js";

// Every `import ... from "./x.js";` block is dropped, not just the first one: a
// leftover import is a SyntaxError inside the VM, which would fail the whole
// dashboard suite rather than one case. The bindings they named are supplied as
// context globals below, which is also what proves the app only uses the
// exported surface.
const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(
  /^import[\s\S]*?from "\.\/[^"]+";\n/gm,
  "",
);

class Element {
  value = "all";
  textContent = "";
  innerHTML = "";
  hidden = false;
  disabled = false;
  style = {};
  options: Element[] = [];
  attributes = new Map<string, string>();
  classList = { toggle() {}, add() {} };
  addEventListener() {}
  insertAdjacentHTML(_position: string, html: string) {
    this.innerHTML += html;
  }
  replaceChildren(...options: Element[]) {
    this.options = options;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
}

type Snapshot = {
  active: boolean;
  stage: string;
  runId?: string;
  populate?: { done: number; total: number };
  link?: { done: number; total: number };
};

/**
 * A `[data-nav]` link, carrying the one thing `app.js` does to it: mark it
 * active or not. The ids and the default come from `index.html` rather than from
 * a list written out here, so adding or reordering a nav link fails a test
 * instead of quietly leaving this one checking a page that no longer exists.
 */
class NavLink {
  dataset: { nav: string };
  classes: Set<string>;
  constructor(dataset: { nav: string }, active = false) {
    this.dataset = dataset;
    this.classes = new Set(active ? ["active"] : []);
  }
  classList = {
    toggle: (name: string, on?: boolean) => {
      if (on) this.classes.add(name);
      else this.classes.delete(name);
      return on ?? this.classes.has(name);
    },
    add: (name: string) => this.classes.add(name),
  };
  addEventListener() {}
  get active() {
    return this.classes.has("active");
  }
}

const navMarkup = [
  ...readFileSync(new URL("../public/index.html", import.meta.url), "utf8").matchAll(
    /<a\b[^>]*\bdata-nav="([^"]+)"[^>]*>/g,
  ),
].map((match) => ({ nav: match[1]!, active: /\bclass="active"/.test(match[0]) }));
const idle: Snapshot = { active: false, stage: "idle" };
const active: Snapshot = { active: true, stage: "populating", runId: "test" };
const catalogue = { scenes: [], sources: [], progress: idle, latestRun: { ok: true } };

async function dashboard(fetch: (url: string) => Promise<unknown>, hash = "") {
  const elements = new Map<string, Element>();
  const element = (selector: string) => {
    if (!elements.has(selector)) {
      const created = new Element();
      if (selector === "#search") created.value = "";
      if (selector === "#sort") created.value = "newest";
      elements.set(selector, created);
    }
    return elements.get(selector)!;
  };
  const listeners = new Map<string, (event: unknown) => void>();
  // Window-level listeners live apart from the document's, because in a browser
  // they are not the same thing: `hashchange` is fired at the Window and does not
  // bubble, so a document listener for it never runs. Sharing one map would let
  // a handler on the wrong target pass the suite.
  const windowListeners = new Map<string, (event: unknown) => void>();
  const timers = new Map<number, number>();
  const callbacks = new Map<number, () => void>();
  let timerId = 0;
  // Fresh links per instance: `app.js` marks them, and one test's hash must not
  // leave the next one's page already lit.
  const links = navMarkup.map((link) => new NavLink({ nav: link.nav }, link.active));
  const place: { hash: string } = { hash };
  const api = (await runInNewContext(
    `(async () => { ${source}\nreturn { renderProgress, applyProgress, pollProgress, apply, render, showRow, selectCatalogue }; })()`,
    {
      document: {
        querySelector: element,
        querySelectorAll: (selector: string) => (selector === "[data-nav]" ? links : []),
        addEventListener(name: string, handler: (event: unknown) => void) {
          listeners.set(name, handler);
        },
      },
      addEventListener(name: string, handler: (event: unknown) => void) {
        windowListeners.set(name, handler);
      },
      location: place,
      URL,
      Option: Element,
      fetch,
      renderSourceHealthSummary: () => "",
      renderSourceHealth: () => "",
      sourceScenes,
      studioChoices,
      visibleSourceStatuses,
      ASIAN_CATALOGUE,
      MAIN_CATALOGUE,
      catalogueId,
      catalogueScenes,
      catalogueStats,
      inCatalogue,
      setTimeout: (callback: () => void, delay: number) => {
        timers.set(++timerId, delay);
        callbacks.set(timerId, callback);
        return timerId;
      },
      clearTimeout: (id: number) => {
        timers.delete(id);
        callbacks.delete(id);
      },
      setInterval: () => ++timerId,
      clearInterval() {},
      requestAnimationFrame: (callback: () => void) => callback(),
    },
  )) as {
    renderProgress(snapshot: Snapshot): void;
    applyProgress(snapshot: Snapshot): boolean;
    pollProgress(): Promise<void>;
    apply(data: unknown): void;
    render(): void;
    showRow(): void;
    selectCatalogue(id: string): void;
  };
  const runTimers = (delay: number) => {
    for (const [id, scheduledDelay] of [...timers]) {
      if (scheduledDelay !== delay) continue;
      const callback = callbacks.get(id)!;
      timers.delete(id);
      callbacks.delete(id);
      callback();
    }
  };
  const activeNav = () => links.filter((link) => link.active).map((link) => link.dataset.nav);
  /** Do what the browser does on a back/forward over these anchors: fire at the Window. */
  const setHash = (next: string) => {
    place.hash = next;
    windowListeners.get("hashchange")?.({});
  };
  return {
    ...api,
    element,
    timers,
    runTimers,
    listeners,
    windowListeners,
    links,
    activeNav,
    setHash,
  };
}

const response = (body: unknown) => ({ ok: true, json: async () => body });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const release = {
  title: "A release",
  label: "Studio",
  labelId: "studio",
  releaseDate: "2026-10-01",
  performers: [],
};

const asianRelease = {
  title: "桃",
  label: "Peach",
  labelId: "madouqu-peach",
  sourceId: "madouqu",
  releaseDate: "2026-10-02",
  performers: [],
};

test("the Asian page shows only the Asian lanes, and its figures are its own", async () => {
  const app = await dashboard(async () =>
    response({
      ...catalogue,
      asianSourceIds: ["fc2cmadb", "madouqu"],
      scenes: [{ ...release, sourceId: "lancelot-styles-evolution" }, asianRelease],
      sources: [
        {
          sourceId: "lancelot-styles-evolution",
          labelId: "lancelot-styles-evolution",
          name: "LSE",
        },
        { sourceId: "madouqu", labelId: "madouqu-peach", name: "Madouqu", label: "Peach" },
      ],
    }),
  );
  assert.equal(app.element("#catalogue-title").textContent, "Catalogue");
  assert.match(app.element("#list").innerHTML, /A release/);
  assert.doesNotMatch(app.element("#list").innerHTML, /桃/);
  assert.equal(app.element("#stat-scenes").textContent, "1");
  assert.equal(app.element("#stat-studios").textContent, "1");
  assert.equal(app.element("#link-rate").textContent, "0% of catalogue");

  app.selectCatalogue("asian");
  assert.equal(app.element("#catalogue-title").textContent, "Asian");
  assert.equal(app.element("#stat-scenes").textContent, "1");
  assert.equal(app.element("#stat-studios").textContent, "1");
  assert.equal(app.element("#link-rate").textContent, "0% of Asian catalogue");
  assert.match(app.element("#list").innerHTML, /桃/);
  assert.doesNotMatch(app.element("#list").innerHTML, /A release/);

  // A studio filter chosen on the other page names a label this page has no row
  // for, so it is dropped rather than left to empty the list.
  app.element("#studio").value = "madouqu-peach";
  app.selectCatalogue("catalogue");
  assert.match(app.element("#list").innerHTML, /A release/);

  // Sources is not a catalogue: it must not change the page behind it.
  app.selectCatalogue("sources");
  assert.match(app.element("#list").innerHTML, /A release/);
});

test("a #asian link opens the Asian page before the catalogue arrives", async () => {
  const app = await dashboard(async () => response(catalogue), "#asian");
  assert.equal(app.element("#catalogue-title").textContent, "Asian");
  assert.equal(app.element("#empty-title").textContent, "No releases in the catalogue");
});

test("the lit nav link follows the hash, not the last click", async () => {
  // A bookmarked `#asian` opened cold: the page is Asian, so the bar must say so
  // too, with no click having happened to light anything.
  const app = await dashboard(async () => response(catalogue), "#asian");
  assert.deepEqual(app.activeNav(), ["asian"]);

  // Sources lights itself, and leaves the page behind it alone...
  app.setHash("#sources");
  assert.deepEqual(app.activeNav(), ["sources"]);
  assert.equal(app.element("#catalogue-title").textContent, "Asian");

  // ...so going back lands on `#asian` with the catalogue already Asian. The
  // selection is unchanged, and the bar still has to follow.
  app.setHash("#asian");
  assert.deepEqual(app.activeNav(), ["asian"]);

  // No hash means the default link in the HTML stands.
  const plain = await dashboard(async () => response(catalogue));
  assert.deepEqual(plain.activeNav(), ["catalogue"]);
  plain.setHash("");
  assert.deepEqual(plain.activeNav(), ["catalogue"]);
});

test("cold-start empty state explains rebuilding and possible snapshot lag", async () => {
  const app = await dashboard(async () =>
    response({
      ...catalogue,
      refreshing: true,
      latestRun: null,
      progress: { ...active, stage: "indexing" },
    }),
  );
  assert.equal(app.element("#empty").hidden, false);
  assert.equal(app.element("#empty-title").textContent, "Building the catalogue…");
  assert.match(
    app.element("#empty-message").textContent,
    /reloading may show releases already collected/,
  );
  assert.doesNotMatch(app.element("#empty-message").textContent, /filter/);
  assert.equal(app.element("#refresh-state").textContent, "Refresh in progress…");
  app.applyProgress({ ...active, stage: "populating" });
  assert.equal(app.element("#empty-title").textContent, "Building the catalogue…");
});

test("a populated catalogue filtered to zero retains the filter guidance during refresh", async () => {
  const app = await dashboard(async () => response({ ...catalogue, scenes: [release] }));
  assert.equal(app.element("#empty").hidden, true);
  app.element("#search").value = "unmatched search";
  app.render();
  assert.equal(app.element("#empty-title").textContent, "No releases found");
  app.applyProgress(active);
  assert.equal(
    app.element("#empty-message").textContent,
    "Try a different search or studio filter.",
  );
  assert.equal(app.element("#empty").hidden, false);
  app.element("#search").value = "";
  app.element("#studio").value = "different-studio";
  app.render();
  assert.equal(app.element("#empty-title").textContent, "No releases found");
  app.element("#studio").value = "all";
  app.render();
  assert.equal(app.element("#empty").hidden, true);
  app.applyProgress(active);
  assert.equal(app.element("#empty").hidden, true, "progress cannot hide populated rows");
});

test("completed empty catalogue and failed initial run have distinct explanations", async () => {
  const app = await dashboard(async () => response(catalogue));
  assert.equal(app.element("#empty-title").textContent, "No releases in the catalogue");
  assert.doesNotMatch(app.element("#empty-message").textContent, /filter/);
  app.apply({ ...catalogue, latestRun: { ok: false } });
  assert.equal(app.element("#empty-title").textContent, "Refresh failed to populate the catalogue");
  assert.match(app.element("#empty-message").textContent, /Check Sources/);
  app.apply({ ...catalogue, latestRun: null, progress: { active: false, stage: "error" } });
  assert.equal(app.element("#empty-title").textContent, "Refresh failed to populate the catalogue");
  app.apply({ ...catalogue, latestRun: null });
  assert.equal(app.element("#empty-title").textContent, "Waiting for the first refresh");
});

test("an active retry takes precedence over a previous failed run", async () => {
  const app = await dashboard(async () =>
    response({
      ...catalogue,
      latestRun: { ok: false },
      refreshing: true,
      progress: active,
    }),
  );
  assert.equal(app.element("#empty-title").textContent, "Building the catalogue…");
});

test("a completed catalogue response does not request the catalogue again", async () => {
  let loads = 0;
  const app = await dashboard(async () => {
    loads += 1;
    return response(catalogue);
  });
  app.applyProgress(active);

  app.apply({ ...catalogue, refreshing: false, progress: active });
  await settle();

  assert.equal(loads, 1);
  assert.equal(app.element("#empty-title").textContent, "No releases in the catalogue");
});

test("completion waits for the latest catalogue before showing rows or a final empty state", async () => {
  let loads = 0;
  let finishLoad!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finishLoad = resolve;
  });
  const app = await dashboard(async () => {
    loads += 1;
    return loads === 1
      ? response({ ...catalogue, refreshing: true, latestRun: null, progress: active })
      : pending;
  });
  app.applyProgress(idle);
  assert.equal(app.element("#empty-title").textContent, "Loading refreshed catalogue…");
  finishLoad(response({ ...catalogue, scenes: [release] }));
  await settle();
  assert.equal(app.element("#empty").hidden, true);
  assert.match(app.element("#list").innerHTML, /A release/);
});

test("a failed completion fetch explains the stale empty snapshot and recovers on retry", async () => {
  let loads = 0;
  const app = await dashboard(async (url) => {
    if (url === "/api/progress") return response({ progress: idle });
    loads += 1;
    if (loads === 2) throw new Error("offline");
    return response(
      loads === 1
        ? { ...catalogue, refreshing: true, latestRun: null, progress: active }
        : catalogue,
    );
  });
  app.applyProgress(idle);
  await settle();
  assert.equal(app.element("#empty-title").textContent, "Unable to load refreshed catalogue");
  await app.pollProgress();
  assert.equal(app.element("#empty-title").textContent, "No releases in the catalogue");
});

for (const [name, latestRun, expectedSummary] of [
  ["success", { ok: true }, "Catalogue up to date"],
  [
    // The suffix came with #67: a run that errored names the resolver as one of
    // the reasons, and the expected string below was left behind by it.
    "source and resolver failures",
    { ok: false, resolverHealth: { errored: 1 } },
    "Source and resolver failures · resolver unavailable",
  ],
] as const) {
  test(`a completed ${name} snapshot clears stale active progress`, async () => {
    const app = await dashboard(async (url) =>
      response(url === "/api/progress" ? { progress: active } : catalogue),
    );
    app.applyProgress({
      ...active,
      stage: "verifying",
      link: { done: 25, total: 25, verifyDone: 14, verifyTotal: 25 },
    } as Snapshot);
    app.showRow();
    assert.equal(app.element("#progress-row").hidden, false);

    app.apply({
      ...catalogue,
      refreshing: false,
      latestRun,
      progress: {
        ...active,
        stage: "verifying",
        link: { done: 25, total: 25, verifyDone: 14, verifyTotal: 25 },
      },
    });

    assert.equal(app.element("#progress-row").hidden, true);
    assert.equal(app.element("#refresh-state").textContent, expectedSummary);

    await app.pollProgress();
    app.runTimers(1200);
    assert.equal(app.element("#progress-row").hidden, true);
    assert.equal(app.element("#refresh").disabled, false);
    assert.equal(app.element("#refresh-state").textContent, expectedSummary);
    assert.deepEqual([...app.timers.values()], [20000]);
  });
}

test("a new run remains visible after completion and a delayed snapshot of the completed run", async () => {
  let progress = active;
  const app = await dashboard(async (url) =>
    response(url === "/api/progress" ? { progress } : catalogue),
  );
  app.applyProgress(active);
  app.runTimers(1200);
  app.applyProgress(idle);
  await settle();
  assert.equal(app.element("#progress-row").hidden, true);

  await app.pollProgress();
  app.runTimers(1200);
  assert.equal(app.element("#progress-row").hidden, true);
  assert.equal(app.element("#progress-live").textContent, "Refresh finished");

  progress = { ...active, runId: "new-run", stage: "finishing" };
  await app.pollProgress();
  app.runTimers(1200);
  assert.equal(app.element("#progress-row").hidden, false);
  assert.equal(app.element("#refresh").disabled, true);
  assert.equal(app.element("#overall-note").textContent, "Finishing up");
  assert.equal(app.element("#progress-live").textContent, "Refresh started");

  progress = active;
  await app.pollProgress();
  assert.equal(app.element("#progress-row").hidden, false);
  assert.equal(app.element("#overall-note").textContent, "Finishing up");
  assert.deepEqual([...app.timers.values()], [2000]);
});

test("HTML provides the empty-state text targets used by the dashboard", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<h3 id="empty-title">Loading catalogue…<\/h3>/);
  assert.match(html, /<p id="empty-message">Waiting for the catalogue response\.<\/p>/);
});

test("studio totals count visible cards and dropdown options follow scene labels", async () => {
  const statuses = [
    { sourceId: "vixen-anal", labelId: "vixen-anal", name: "Vixen", lastError: null },
    { sourceId: "vixen-anal", labelId: "tushy", name: "Vixen", label: "Tushy" },
    { sourceId: "madouqu", labelId: "madouqu", name: "Madouqu" },
  ];
  const app = await dashboard(async () =>
    response({
      ...catalogue,
      sources: statuses,
      scenes: [
        { ...release, sourceId: "vixen-anal", labelId: "tushy", label: "Tushy" },
        { ...release, sourceId: "madouqu", labelId: "madouqu-peach", label: "Peach" },
      ],
    }),
  );
  assert.equal(app.element("#stat-studios").textContent, "2");
  assert.doesNotMatch(app.element("#studio").innerHTML, /value="vixen-anal"/);
  assert.match(app.element("#studio").innerHTML, /value="tushy">Tushy · 1/);
  assert.match(app.element("#studio").innerHTML, /value="madouqu-peach">Peach · 1/);
});

test("overall progress uses only stages with known totals", async () => {
  const app = await dashboard(async () => response(catalogue));
  for (const [sources, links, expected] of [
    [50, null, "50"],
    [null, 60, "60"],
    [50, 60, "55"],
    [0, null, "0"],
    [null, null, undefined],
  ] as const) {
    app.renderProgress({
      ...active,
      populate: { done: sources ?? 0, total: sources === null ? 0 : 100 },
      link: { done: links ?? 0, total: links === null ? 0 : 100 },
    });
    assert.equal(app.element("#overall-track").attributes.get("aria-valuenow"), expected);
  }
});

test("idle polling retries failed completion reloads and stops reloading after success", async () => {
  let loads = 0;
  const app = await dashboard(async (url) => {
    if (url === "/api/progress") return response({ progress: idle });
    loads += 1;
    if (loads === 2 || loads === 3) throw new Error("catalogue unavailable");
    return response(catalogue);
  });
  app.applyProgress(active);
  app.applyProgress(idle);
  await settle();
  assert.equal(loads, 2);
  assert.equal(app.element("#progress-live").textContent, "Refresh finished");
  await app.pollProgress();
  assert.equal(loads, 3);
  await app.pollProgress();
  assert.equal(loads, 4);
  assert.equal(app.element("#refresh-state").textContent, "Catalogue up to date");
  await app.pollProgress();
  assert.equal(loads, 4, "ordinary idle polls do not reload the catalogue");
  assert.deepEqual([...app.timers.values()], [20000]);
});

for (const previousRun of [undefined, "previous-run"]) {
  test(`idle polling reloads a missed run after ${previousRun ?? "no previous run"}`, async () => {
    let progress = { ...idle, runId: previousRun };
    let loads = 0;
    const app = await dashboard(async (url) => {
      if (url === "/api/progress") return response({ progress });
      loads += 1;
      // The stat tiles are counted from the rows the page shows, so the reload
      // has to carry the rows: the second response brings the first release.
      return response({ ...catalogue, progress, scenes: loads > 1 ? [release] : [] });
    });
    assert.equal(loads, 1, "the initial snapshot does not trigger another load");
    await app.pollProgress();
    assert.equal(loads, 1, "the unchanged idle snapshot does not reload");

    progress = { ...idle, runId: "missed-run" };
    await app.pollProgress();
    await settle();
    assert.equal(loads, 2);
    assert.equal(app.element("#stat-scenes").textContent, "1");
    assert.equal(app.element("#progress-live").textContent, "");
    await app.pollProgress();
    assert.equal(loads, 2, "the completed run only reloads once");
  });
}

test("idle polling retries a failed reload for a missed run", async () => {
  const completed = { ...idle, runId: "missed-run" };
  let loads = 0;
  const app = await dashboard(async (url) => {
    if (url === "/api/progress") return response({ progress: completed });
    loads += 1;
    if (loads === 2) throw new Error("catalogue unavailable");
    return response({ ...catalogue, progress: loads === 1 ? idle : completed });
  });
  await app.pollProgress();
  await settle();
  assert.equal(loads, 2);
  await app.pollProgress();
  assert.equal(loads, 3);
  await app.pollProgress();
  assert.equal(loads, 3, "successful retry stops catalogue reloads");
});

test("a direct poll cancels its scheduled timer before awaiting the response", async () => {
  let resolvePoll!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    resolvePoll = resolve;
  });
  const app = await dashboard(async (url) =>
    url === "/api/scenes" ? response(catalogue) : pending,
  );
  assert.equal(app.timers.size, 1);
  const poll = app.pollProgress();
  assert.equal(app.timers.size, 0, "the old timer cannot fire during this request");
  await app.pollProgress();
  resolvePoll(response({ progress: active }));
  await poll;
  // The other timer is the delayed reveal of the progress row.
  assert.deepEqual(
    [...app.timers.values()].sort((a, b) => a - b),
    [1200, 2000],
  );
});

test("an initial catalogue error still schedules idle progress polling", async () => {
  let polls = 0;
  const app = await dashboard(async (url) => {
    if (url === "/api/scenes") throw new Error("offline");
    polls += 1;
    return response({ progress: idle });
  });
  assert.equal(app.element("#refresh-state").textContent, "Unable to load catalogue");
  assert.deepEqual([...app.timers.values()], [20000]);
  await app.pollProgress();
  assert.equal(polls, 1);
  assert.deepEqual([...app.timers.values()], [20000]);
});

test("a truncated search is shown as its own outcome, not as a clean refresh", async () => {
  // The reader has one line describing the last run, so a truncated search that
  // reads "Catalogue up to date" is indistinguishable from an exhaustive one -
  // which is exactly the coverage problem the counter was added to expose.
  for (const [resolverHealth, expected] of [
    [{ incomplete: 3 }, "Catalogue up to date · search truncated"],
    [{ noMatch: 12 }, "Catalogue up to date"],
    [
      { errored: 2, incomplete: 3 },
      "Catalogue up to date · resolver unavailable · search truncated",
    ],
  ] as const) {
    const app = await dashboard(async () => response(catalogue));
    app.apply({ ...catalogue, latestRun: { ok: true, resolverHealth } });
    assert.equal(app.element("#refresh-state").textContent, expected);
  }
});

test("a failed refresh still reports truncation alongside its source failures", async () => {
  const app = await dashboard(async () => response(catalogue));
  app.apply({
    ...catalogue,
    latestRun: { ok: false, resolverHealth: { incomplete: 1 } },
  });
  assert.equal(
    app.element("#refresh-state").textContent,
    "Last refresh had source failures · search truncated",
  );
});

test("the last run says how much of its match count was a guess", async () => {
  // "Catalogue up to date" says nothing about whether the links it found were
  // identified. A run where 56 of 69 winners were the terminal fallback's flagged
  // guesses reads as a clean refresh, and the only way to see the difference was
  // to reconstruct it from other counters.
  for (const [resolverHealth, expected] of [
    [{ winnerFallback: 56 }, "Catalogue up to date · 56 low-confidence guesses"],
    [{ winnerPool: 13, winnerSxyprn: 0, winnerFallback: 0 }, "Catalogue up to date"],
    // A named match is not a verdict either: how much of it was a guess is.
    [
      { winnerPool: 9, winnerSxyprn: 4, winnerFallback: 1 },
      "Catalogue up to date · 1 low-confidence guess",
    ],
  ] as const) {
    const app = await dashboard(async () => response(catalogue));
    app.apply({ ...catalogue, latestRun: { ok: true, resolverHealth } });
    assert.equal(app.element("#refresh-state").textContent, expected);
  }
});

test("the last run says what the slow source cost, and what went wrong with it", async () => {
  // A clean run is not always a cheap one: the ladder tries the fast pool first,
  // and every scene it could not resolve there costs a ten-second wait at the
  // slow source. Without that number on screen, a refresh that took twenty
  // minutes reads exactly like one that took twenty seconds.
  for (const [resolverHealth, expected] of [
    [{ sxyprnSearches: 4, sxyprnDetails: 11 }, "Catalogue up to date · 15 slow-source lookups"],
    [{ sxyprnSearches: 0, sxyprnDetails: 0 }, "Catalogue up to date"],
    // Nothing was spent, so there is nothing to say, however bad the run was.
    [
      { errored: 2, incomplete: 1 },
      "Catalogue up to date · resolver unavailable · search truncated",
    ],
  ] as const) {
    const app = await dashboard(async () => response(catalogue));
    app.apply({ ...catalogue, latestRun: { ok: true, resolverHealth } });
    assert.equal(app.element("#refresh-state").textContent, expected);
  }
});

test("FC2 links display verified part numbers while alternative uploads keep neutral labels", async () => {
  const app = await dashboard(async () => response(catalogue), "#asian");
  app.apply({
    ...catalogue,
    asianSourceIds: ["fc2cmadb"],
    scenes: [
      {
        ...asianRelease,
        sourceId: "fc2cmadb",
        labelId: "fc2cmadb",
        videoUrls: [
          { source: "eporner", url: "https://www.eporner.com/video-abc123/", part: 2 },
          { source: "eporner", url: "https://www.eporner.com/video-def456/", part: 1 },
        ],
      },
    ],
  });
  let html = app.element("#list").innerHTML;
  assert.match(html, /video-abc123\/[^>]*>[^<]*Part 2/);
  assert.match(html, /video-def456\/[^>]*>[^<]*Part 1/);
  app.apply({
    ...catalogue,
    asianSourceIds: ["fc2cmadb"],
    scenes: [
      {
        ...asianRelease,
        sourceId: "fc2cmadb",
        labelId: "fc2cmadb",
        videoUrls: [
          { source: "eporner", url: "https://www.eporner.com/video-abc123/" },
          { source: "eporner", url: "https://www.eporner.com/video-def456/" },
        ],
      },
    ],
  });
  html = app.element("#list").innerHTML;
  assert.doesNotMatch(html, /Part [12]/);
  assert.match(html, /eporner 1/);
  assert.match(html, /eporner 2/);
});
