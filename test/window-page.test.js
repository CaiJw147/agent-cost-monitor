// The window's own script, executed.
//
// The page is one HTML file with inline JavaScript, which means nothing in the build
// or the test suite ever ran it. That is how `warn is not defined` — a variable read
// from a different function's scope — shipped and was found by the user instead of by
// a test: the served HTML was inspected, the expression's text was compared, and the
// text was right. Reading source is not running it.
//
// So this loads index.html, extracts the inline script and runs it against a stub DOM.
// No browser, no network, no fixture files: the payloads are written out in full.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "window", "index.html"), "utf8");
const SCRIPT = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");

/**
 * The page's script, in a scope with just enough DOM to run.
 *
 * `fetch` never settles so the page's own polling `tick()` cannot land mid-test and
 * overwrite what an assertion is looking at; every render below is the test's.
 */
function loadPage() {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { id, style: {}, textContent: "", innerHTML: "" });
      return elements.get(id);
    },
  };
  const factory = new Function(
    "document",
    "location",
    "fetch",
    "setInterval",
    `${SCRIPT}\nreturn { render, chart, money, clock };`,
  );
  const page = factory(document, { search: "" }, () => new Promise(() => {}), () => 0);
  return { page, elements };
}

/** A payload shaped exactly like the daemon's, so the page is tested against its real contract. */
const okPayload = (over = {}) => ({
  state: "ok",
  source: "codex",
  sourceDetail: "rollout-2026-10-11T10-58-47.jsonl \u00b7 cli 0.162.1 \u00b7 openai",
  symbol: "\u00a5",
  currency: "CNY",
  turnCost: 1.4139,
  sessionCost: 3.3825,
  liveBurn: 3.45,
  averageBurn: 100.5,
  elapsedMs: 65_000,
  turns: 2,
  models: ["gpt-6-sol"],
  series: [{ atMs: 1, amountPerHour: 10 }],
  warnPerHour: 15,
  unpriced: 0,
  approximate: false,
  note: "",
  attempts: [{ source: "codex", ok: true, reason: "" }],
  ...over,
});

test("the page renders a real payload without throwing", () => {
  const { page } = loadPage();
  assert.doesNotThrow(() => page.render(okPayload()));
});

test("the dot is green below the warning rate, amber above, and returns to green", () => {
  // The reported bug: it went amber on any spend at all and stayed amber until the rate
  // hit exactly zero. 3.45/h against a 15/h threshold must be green.
  const { page, elements } = loadPage();
  page.render(okPayload({ liveBurn: 3.45, warnPerHour: 15 }));
  assert.equal(elements.get("dot").style.background, "#3fb950", "a fifth of the threshold is not a warning");

  page.render(okPayload({ liveBurn: 20, warnPerHour: 15 }));
  assert.equal(elements.get("dot").style.background, "#d9a441", "above the threshold it warns");

  page.render(okPayload({ liveBurn: 3.45, warnPerHour: 15 }));
  assert.equal(elements.get("dot").style.background, "#3fb950", "and it comes back — the point of the report");
});

test("the threshold is the payload's, not a constant baked into the page", () => {
  const { page, elements } = loadPage();
  const payload = okPayload({ liveBurn: 3.45 });
  page.render({ ...payload, warnPerHour: 1 });
  assert.equal(elements.get("dot").style.background, "#d9a441", "the same rate warns when the user lowers the bar");
  page.render({ ...payload, warnPerHour: 50 });
  assert.equal(elements.get("dot").style.background, "#3fb950", "and stops warning when they raise it");
});

test("the host being read is named on screen, not implied", () => {
  const { page, elements } = loadPage();
  page.render(okPayload({ source: "codex" }));
  assert.match(elements.get("source").innerHTML, /Codex/);
  page.render(okPayload({ source: "claude-code" }));
  assert.match(elements.get("source").innerHTML, /Claude Code/);
});

test("the spend line carries the turn, the session, both rates and the clock", () => {
  const { page, elements } = loadPage();
  page.render(okPayload({ turnCost: 1.4139, sessionCost: 3.3825, liveBurn: 3.45, averageBurn: 100.5, elapsedMs: 65_000 }));
  const line = elements.get("line").innerHTML;
  assert.match(line, /\u00a51\.41/, "this turn");
  assert.match(line, /\u00a53\.38/, "this session");
  assert.match(line, /\u00a53\.45\/h/, "the live rate");
  assert.match(line, /\u00a5100\.50\/h/, "the average rate");
  assert.match(line, /1:05/, "and the turn's clock, mm:ss");
});

test("no data paints the dot red and says which sources were tried and why", () => {
  const { page, elements } = loadPage();
  page.render({
    state: "nodata",
    requested: "codex",
    hint: "nothing to read yet",
    attempts: [
      { source: "codex", ok: false, reason: "no rollout under ~/.codex/sessions" },
      { source: "dsh", ok: false, reason: "HTTP 404" },
    ],
  });
  assert.equal(elements.get("dot").style.background, "#d9534f");
  assert.match(elements.get("line").innerHTML, /nothing to read yet/);
  const sub = elements.get("sub").textContent;
  assert.match(sub, /no rollout under/, "the reason is on screen, not just in the payload");
  assert.match(sub, /HTTP 404/);
  assert.equal(elements.get("chartwrap").innerHTML, "", "and no stale chart is left behind");
});

test("an approximation is labelled with its reason", () => {
  const { page, elements } = loadPage();
  page.render(okPayload({ approximate: true, note: "priced from the thread total" }));
  assert.match(elements.get("approx").textContent, /priced from the thread total/);
  page.render(okPayload({ approximate: false, note: "" }));
  assert.equal(elements.get("approx").textContent, "", "and cleared when the figure is exact again");
});

test("the chart renders the burn series against the warning line", () => {
  const { page } = loadPage();
  const svg = page.chart(okPayload({ series: [{ atMs: 1, amountPerHour: 10 }, { atMs: 2, amountPerHour: 30 }] }));
  assert.match(svg, /<svg/);
  assert.match(svg, /class="burn"/, "the burn line");
  assert.match(svg, /class="warn"/, "the dashed warning line");
});

test("an empty series does not break the chart", () => {
  const { page } = loadPage();
  assert.doesNotThrow(() => page.chart(okPayload({ series: [] })));
  assert.doesNotThrow(() => page.chart(okPayload({ series: undefined })));
});
