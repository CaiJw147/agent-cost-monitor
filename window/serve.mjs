// The window's daemon: one page, one JSON endpoint, no framework.
//
// Two data sources, in order. The DSH plugin's own HTTP route if it is answering
// — that is the dsh-tui path, and it already carries the balance and the burn
// series. Otherwise the newest Claude Code transcript, priced by the same engine,
// so the window is useful before DSH is wired up rather than being a blank frame.
//
// Every figure here is display-only. The status line computes its own, and the DSH
// panel computes its own; three renderers over one engine is the design, so this
// file deliberately does not try to become a shared library.

import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { burnPerHour, usageCost } from "../lib/cost.js";
import { createPriceBook } from "../lib/pricing.js";
import { collectUnits } from "../claude/statusline.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ACM_WINDOW_PORT ?? 7420);
const CURRENCY = (process.env.SPEND_WATCH_CURRENCY ?? "CNY").toUpperCase() === "USD" ? "USD" : "CNY";
const SYMBOL = CURRENCY === "USD" ? "$" : "\u00a5";
const BURN_WINDOW_MS = 15_000;
const CACHE = process.env.SPEND_WATCH_CACHE ?? join(homedir(), ".cache", "spend-watch");
const DSH_URL = process.env.ACM_DSH_URL ?? "http://127.0.0.1:19387/dsh-budget-watcher/balance";

const json = (res, body, status = 200) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

const loadPricing = () => {
  try {
    const cache = JSON.parse(readFileSync(join(CACHE, "claude-pricing.json"), "utf8"));
    return { usdToCny: cache.usdToCny ?? 0, models: cache.models ?? {} };
  } catch {
    return { usdToCny: 0, models: {} };
  }
};

/** Newest Claude Code transcript that actually reports usage. */
function newestTranscript() {
  const root = join(homedir(), ".claude", "projects");
  const found = [];
  (function walk(dir, depth = 0) {
    if (depth > 5) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.endsWith(".jsonl")) found.push({ full, m: statSync(full).mtimeMs });
    }
  })(root);
  found.sort((a, b) => b.m - a.m);
  for (const { full } of found.slice(0, 12)) {
    try {
      if (readFileSync(full, "utf8").includes('"input_tokens"')) return full;
    } catch {
      /* unreadable */
    }
  }
  return undefined;
}

/** The same figures the status line prints, plus the series the chart needs. */
function fromTranscript(now) {
  const path = newestTranscript();
  if (path === undefined) return undefined;
  const { usdToCny, models } = loadPricing();
  const book = createPriceBook({ enabled: false, bundled: models });
  const lookup = (model, options) => book.lookup(model, { ...options, usdToCny });

  const raw = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const { units } = collectUnits(raw);
  if (units.length === 0) return undefined;
  units.sort((a, b) => a.time - b.time);

  const price = (u) => usageCost(u.usage, u.model, u.time, CURRENCY, lookup)?.cost ?? 0;
  let sessionCost = 0;
  let lastTurn = -1;
  for (const u of units) {
    sessionCost += price(u);
    if (u.turn > lastTurn) lastTurn = u.turn;
  }

  // The chart is the windowed rate at each settled point, exactly as the panel's
  // series is: cost inside the trailing window, projected to an hour.
  const series = [];
  let start = 0;
  let windowCost = 0;
  for (const u of units) {
    const cost = price(u);
    windowCost += cost;
    while (units[start].time < u.time - BURN_WINDOW_MS) windowCost -= price(units[start++]);
    series.push({ atMs: u.time, amountPerHour: burnPerHour(windowCost, BURN_WINDOW_MS) });
  }

  let turnCost = 0;
  let turnStart = null;
  let lastActivity = null;
  for (const u of units) {
    if (u.turn !== lastTurn) continue;
    turnCost += price(u);
    if (turnStart === null || u.time < turnStart) turnStart = u.time;
    if (lastActivity === null || u.time > lastActivity) lastActivity = u.time;
  }
  const live = lastActivity !== null && now - lastActivity < 30_000;
  const elapsed = turnStart === null ? 0 : (live ? now : lastActivity) - turnStart;

  const recent = units.slice(-30).map((u) => ({ atMs: u.time, amountPerHour: 0 }));
  return {
    state: "ok",
    source: "claude-code",
    sourceDetail: path,
    currency: CURRENCY,
    symbol: SYMBOL,
    balance: null,
    balanceNote: "the balance is DeepSeek's, and only the DSH plugin reads it",
    turnCost,
    sessionCost,
    // The headline rate is "now", not "at the last settled point": the series is
    // history, but an idle session must read zero or the window looks like it is
    // still spending.
    liveBurn: burnPerHour(
      units.filter((u) => now - u.time <= BURN_WINDOW_MS).reduce((sum, u) => sum + price(u), 0),
      BURN_WINDOW_MS,
    ),
    averageBurn: elapsed > 0 ? burnPerHour(turnCost, elapsed) : 0,
    elapsedMs: elapsed,
    turns: lastTurn + 1,
    models: [...new Set(units.map((u) => u.model))].slice(0, 4),
    series: series.slice(-240),
    warnPerHour: Number(process.env.ACM_WARN_PER_HOUR ?? 15),
    unpriced: units.filter((u) => usageCost(u.usage, u.model, u.time, CURRENCY, lookup) === undefined).length,
    recent,
  };
}

/** The DSH plugin already answers all of this; pass it through in one shape. */
async function fromDsh() {
  const response = await fetch(DSH_URL, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) return undefined;
  const body = await response.json();
  if (body?.ok !== true) return undefined;
  const cost = body.cost ?? {};
  const turn = cost.thisTurn ?? {};
  const session = cost.session ?? {};
  const currency = cost.currency ?? "CNY";
  return {
    state: "ok",
    source: "dsh",
    sourceDetail: DSH_URL,
    currency,
    symbol: currency === "USD" ? "$" : "\u00a5",
    balance: body.featured
      ? { amount: Number(body.featured.total ?? body.featured.toppedUp ?? 0), currency: body.featured.currency ?? currency }
      : null,
    balanceNote: `pluginVersion ${body.pluginVersion ?? "?"}`,
    turnCost: turn.amount ?? turn.cost ?? 0,
    sessionCost: session.amount ?? session.cost ?? 0,
    liveBurn: cost.liveBurnPerHour ?? cost.liveAmountPerHour ?? 0,
    averageBurn: cost.averageBurnPerHour ?? cost.averageAmountPerHour ?? 0,
    elapsedMs: turn.durationMs ?? 0,
    turns: session.turns ?? 0,
    models: turn.models ?? [],
    series: turn.series ?? [],
    warnPerHour: cost.warnPerHour ?? 0,
    unpriced: session.unpricedTurns ?? 0,
    recent: (cost.recent ?? []).map((r) => ({ atMs: r.atMs ?? 0, amountPerHour: r.amountPerHour ?? 0 })),
  };
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/data") {
    try {
      const dsh = await fromDsh();
      if (dsh !== undefined) return json(res, dsh);
    } catch {
      /* the DSH host is not running, or its plugin is not installed: fall through */
    }
    const local = fromTranscript(Date.now());
    if (local !== undefined) return json(res, local);
    return json(res, {
      state: "nodata",
      currency: CURRENCY,
      symbol: SYMBOL,
      hint: `no DSH route at ${DSH_URL} and no Claude Code transcript with usage yet`,
    });
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const file = join(HERE, "index.html");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(readFileSync(file));
  }
  json(res, { error: "not found" }, 404);
}).listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`agent-cost-monitor window on http://127.0.0.1:${PORT}\n`);
});
