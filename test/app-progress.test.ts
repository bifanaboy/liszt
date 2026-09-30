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
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector)!;
  };
  const timers = new Map<number, number>();
  let timerId = 0;
  const api = (await runInNewContext(
    `(async () => { ${source}\nreturn { renderProgress, applyProgress, pollProgress }; })()`,
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
  };
  return { ...api, element, timers };
}

const response = (body: unknown) => ({ ok: true, json: async () => body });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

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
