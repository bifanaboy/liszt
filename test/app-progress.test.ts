import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(
  /^import .*;\n/,
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
  insertAdjacentHTML() {}
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
const idle: Snapshot = { active: false, stage: "idle" };
const active: Snapshot = { active: true, stage: "populating", runId: "test" };
const catalogue = { scenes: [], sources: [], progress: idle, latestRun: { ok: true } };

async function dashboard(fetch: (url: string) => Promise<unknown>) {
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
  const timers = new Map<number, number>();
  let timerId = 0;
  const api = (await runInNewContext(
    `(async () => { ${source}\nreturn { renderProgress, applyProgress, pollProgress, apply, render }; })()`,
    {
      document: { querySelector: element, querySelectorAll: () => [], addEventListener() {} },
      Option: Element,
      fetch,
      renderSourceHealthSummary: () => "",
      renderSourceHealth: () => "",
      setTimeout: (_callback: unknown, delay: number) => {
        timers.set(++timerId, delay);
        return timerId;
      },
      clearTimeout: (id: number) => timers.delete(id),
      setInterval: () => ++timerId,
      clearInterval() {},
    },
  )) as {
    renderProgress(snapshot: Snapshot): void;
    applyProgress(snapshot: Snapshot): boolean;
    pollProgress(): Promise<void>;
    apply(data: unknown): void;
    render(): void;
  };
  return { ...api, element, timers };
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

test("HTML provides the empty-state text targets used by the dashboard", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<h3 id="empty-title">Loading catalogue…<\/h3>/);
  assert.match(html, /<p id="empty-message">Waiting for the catalogue response\.<\/p>/);
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
      return response({ ...catalogue, progress, stats: { total: loads } });
    });
    assert.equal(loads, 1, "the initial snapshot does not trigger another load");
    await app.pollProgress();
    assert.equal(loads, 1, "the unchanged idle snapshot does not reload");

    progress = { ...idle, runId: "missed-run" };
    await app.pollProgress();
    await settle();
    assert.equal(loads, 2);
    assert.equal(app.element("#stat-scenes").textContent, "2");
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
