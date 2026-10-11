// The window's daemon: one page, one JSON endpoint, no framework.
//
// Three sources, and the caller can say which it wants. A host is preferred with
// `?host=codex` (the launcher puts it in the URL), otherwise DSH is tried first
// because that route already carries everything, then Codex, then Claude Code.
//
// What it deliberately does NOT do any more: show a balance. The balance is
// DeepSeek's and only DSH can read it, so in a window that also serves Codex and
// Claude Code it was a figure about a different provider than the one being
// measured — and a number that silently never moves for two of the three hosts.
// Cost and burn rate are the whole job here.
//
// Every figure is display-only; the status line and the DSH panel compute their own.
// Three renderers over one engine is the design, so this file does not try to become
// a shared library.

import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { burnPerHour, usageCost } from "../lib/cost.js";
import { createPriceBook } from "../lib/pricing.js";
import { collectUnits } from "../claude/statusline.mjs";
import { parseRollout, readNewestRollout, readThreadTotals } from "../src/codex.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ACM_WINDOW_PORT ?? 7420);
const CURRENCY = (process.env.SPEND_WATCH_CURRENCY ?? "CNY").toUpperCase() === "USD" ? "USD" : "CNY";
const SYMBOL = CURRENCY === "USD" ? "$" : "\u00a5";
const BURN_WINDOW_MS = 15_000;
const IDLE_IS_ENDED_MS = 30_000;
const CACHE = process.env.SPEND_WATCH_CACHE ?? join(homedir(), ".cache", "spend-watch");
const DSH_URL = process.env.ACM_DSH_URL ?? "http://127.0.0.1:19387/dsh-budget-watcher/balance";
const WARN = Number(process.env.ACM_WARN_PER_HOUR ?? 15);

const json = (res, body, status = 200) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

function loadPricing() {
  try {
    const cache = JSON.parse(readFileSync(join(CACHE, "claude-pricing.json"), "utf8"));
    return { usdToCny: cache.usdToCny ?? 0, models: cache.models ?? {} };
  } catch {
    return { usdToCny: 0, models: {} };
  }
}

/** One price lookup, shared by every source. */
function makeLookup() {
  const { usdToCny, models } = loadPricing();
  const book = createPriceBook({ enabled: false, bundled: models });
  return (model, options) => book.lookup(model, { ...options, usdToCny });
}

/**
 * The figures, from priced units. Shared by Codex and Claude Code, which is the
 * point: one engine, one shape of answer, two adapters.
 */
function figuresFrom(units, { now, lookup, approximate = false, note = "" }) {
  const price = (u) => usageCost(u.usage, u.model, u.time, CURRENCY, lookup);

  const sorted = units.filter((u) => Number.isFinite(u.time)).sort((a, b) => a.time - b.time);
  let sessionCost = 0;
  let unpriced = 0;
  let lastTurn = 0;
  for (const u of sorted) {
    const priced = price(u);
    if (priced === undefined) unpriced += 1;
    else sessionCost += priced.cost;
    if (u.turn > lastTurn) lastTurn = u.turn;
  }

  // The chart is the windowed rate at each settled point, as the DSH panel's series
  // is. A trailing window, not a running total: adding every call to one accumulator
  // and never removing the ones that aged out made the line climb forever, which is
  // both wrong and the opposite of what a burn rate is for. (Caught by reading an
  // implausible axis label off a screenshot, not by a test.)
  const costs = sorted.map((u) => price(u)?.cost ?? 0);
  const series = [];
  let windowCost = 0;
  let start = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    windowCost += costs[i];
    while (sorted[start].time < sorted[i].time - BURN_WINDOW_MS) windowCost -= costs[start++];
    series.push({ atMs: sorted[i].time, amountPerHour: burnPerHour(windowCost, BURN_WINDOW_MS) });
  }

  let turnCost = 0;
  let turnStart = null;
  let lastActivity = null;
  for (const u of sorted) {
    if (u.turn !== lastTurn) continue;
    turnCost += price(u)?.cost ?? 0;
    if (turnStart === null || u.time < turnStart) turnStart = u.time;
    if (lastActivity === null || u.time > lastActivity) lastActivity = u.time;
  }
  const live = lastActivity !== null && now - lastActivity < IDLE_IS_ENDED_MS;
  const elapsedMs = turnStart === null ? 0 : (live ? now : lastActivity) - turnStart;

  return {
    turnCost,
    sessionCost,
    // The headline rate is "now", not "at the last settled point": the series is
    // history, but an idle session must read zero or it looks like it is still spending.
    liveBurn: burnPerHour(
      sorted.filter((u) => now - u.time <= BURN_WINDOW_MS).reduce((sum, u) => sum + (price(u)?.cost ?? 0), 0),
      BURN_WINDOW_MS,
    ),
    averageBurn: elapsedMs > 0 ? burnPerHour(turnCost, elapsedMs) : 0,
    elapsedMs,
    turns: lastTurn,
    models: [...new Set(sorted.map((u) => u.model).filter((m) => m !== ""))].slice(0, 4),
    series: series.slice(-240),
    unpriced,
    approximate,
    note,
  };
}

// --------------------------------------------------------------- sources -----

/** The DSH plugin already answers all of this; pass it through in one shape. */
async function fromDsh() {
  const response = await fetch(DSH_URL, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) return { ok: false, reason: `HTTP ${response.status} from ${DSH_URL}` };
  const body = await response.json();
  if (body?.ok !== true) return { ok: false, reason: `${DSH_URL} did not return ok` };
  const cost = body.cost ?? {};
  const turn = cost.thisTurn ?? {};
  const session = cost.session ?? {};
  const currency = cost.currency ?? CURRENCY;
  return {
    ok: true,
    payload: {
      state: "ok",
      source: "dsh",
      sourceDetail: `dsh-budget-watcher ${body.pluginVersion ?? "?"}`,
      currency,
      symbol: currency === "USD" ? "$" : "\u00a5",
      turnCost: turn.amount ?? turn.cost ?? 0,
      sessionCost: session.amount ?? session.cost ?? 0,
      liveBurn: cost.liveBurnPerHour ?? cost.liveAmountPerHour ?? 0,
      averageBurn: cost.averageBurnPerHour ?? cost.averageAmountPerHour ?? 0,
      elapsedMs: turn.durationMs ?? 0,
      turns: session.turns ?? 0,
      models: turn.models ?? [],
      series: turn.series ?? [],
      warnPerHour: cost.warnPerHour ?? WARN,
      unpriced: session.unpricedTurns ?? 0,
      approximate: false,
      note: "live from the DSH host plugin",
    },
  };
}

async function fromCodex(now, lookup) {
  const rollout = readNewestRollout();
  if (rollout === undefined) return { ok: false, reason: "no rollout under ~/.codex/sessions" };
  const parsed = parseRollout(rollout.lines);
  const where = rollout.path.split(/[\\/]/).slice(-1)[0];

  if (parsed.sawUsage) {
    return {
      ok: true,
      payload: {
        state: "ok",
        source: "codex",
        sourceDetail: `${where} \u00b7 cli ${parsed.cliVersion || "?"} \u00b7 ${parsed.provider || "?"}`,
        currency: CURRENCY,
        symbol: SYMBOL,
        ...figuresFrom(parsed.units, { now, lookup }),
        warnPerHour: WARN,
      },
    };
  }

  // No per-call usage in the rollout. That is what a refused turn looks like — a
  // subscription limit leaves nothing to record — and Codex keeps a whole-thread
  // total anyway, so report that, labelled, rather than reporting zero spend.
  const totals = await readThreadTotals();
  const match = totals.find((t) => t.rolloutPath.endsWith(where)) ?? totals.find((t) => t.tokensUsed > 0);
  if (match === undefined || match.tokensUsed === 0) {
    return { ok: false, reason: `no usage in ${where}, and no thread total to fall back on` };
  }
  return {
    ok: true,
    payload: {
      state: "ok",
      source: "codex",
      sourceDetail: `${where} \u00b7 totals from state_5.sqlite`,
      currency: CURRENCY,
      symbol: SYMBOL,
      ...figuresFrom(
        [{ turn: 1, time: now, model: match.model, usage: { inputTokens: match.tokensUsed, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } }],
        { now, lookup, approximate: true, note: `${match.tokensUsed.toLocaleString()} tokens priced as uncached input \u2014 the cache split was not recorded` },
      ),
      warnPerHour: WARN,
    },
  };
}

function fromClaudeCode(now, lookup) {
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
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith(".jsonl")) found.push({ full, mtimeMs: statSync(full).mtimeMs });
    }
  })(root);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const { full } of found.slice(0, 12)) {
    try {
      const text = readFileSync(full, "utf8");
      if (!text.includes('"input_tokens"')) continue;
      const { units } = collectUnits(text.split("\n").filter(Boolean));
      if (units.length === 0) continue;
      return {
        ok: true,
        payload: {
          state: "ok",
          source: "claude-code",
          sourceDetail: full.split(/[\\/]/).slice(-1)[0],
          currency: CURRENCY,
          symbol: SYMBOL,
          ...figuresFrom(units, { now, lookup }),
          warnPerHour: WARN,
        },
      };
    } catch {
      /* try the next transcript */
    }
  }
  return { ok: false, reason: "no Claude Code transcript with usage found" };
}

const SOURCES = { dsh: fromDsh, codex: fromCodex, claude: fromClaudeCode, "claude-code": fromClaudeCode };

/** Try the requested host first, then the rest, and say why each one failed. */
async function resolveData(prefer, now, lookup) {
  const order = ["dsh", "codex", "claude"];
  const wanted = prefer === "dsh-tui" ? "dsh" : prefer;
  const keys = SOURCES[wanted] !== undefined ? [wanted, ...order.filter((k) => k !== wanted)] : order;

  const attempts = [];
  for (const key of keys) {
    // `await` rather than `.catch()` on the call: one source is synchronous (it only
    // reads files) and chaining a promise method onto its result threw, which took
    // every other source down with it and reported "no data" for a host that was
    // sitting right there.
    let result;
    try {
      result = await SOURCES[key](now, lookup);
    } catch (error) {
      result = { ok: false, reason: String(error?.message ?? error) };
    }
    attempts.push({ source: key === "claude" ? "claude-code" : key, ok: result.ok, reason: result.ok ? "" : result.reason });
    if (result.ok) return { ...result.payload, requested: wanted || "auto", attempts };
  }
  return {
    state: "nodata",
    requested: wanted || "auto",
    currency: CURRENCY,
    symbol: SYMBOL,
    attempts,
    hint: "nothing to read yet \u2014 run Codex, start dsh-tui, or use Claude Code",
  };
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/data") {
    const now = Date.now();
    const lookup = makeLookup();
    const prefer = (url.searchParams.get("host") ?? process.env.ACM_PREFER_HOST ?? "").trim().toLowerCase();
    try {
      return json(res, await resolveData(prefer, now, lookup));
    } catch (error) {
      return json(res, { state: "error", hint: String(error?.message ?? error) });
    }
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(readFileSync(join(HERE, "index.html")));
  }
  json(res, { error: "not found" }, 404);
}).listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`agent-cost-monitor window on http://127.0.0.1:${PORT}\n`);
});
