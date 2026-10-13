#!/usr/bin/env node
// Claude Code status line: one line of spend, updated as the session runs.
//
//   ¥0.53 / ¥19.72 · β(t) ¥0.00/h · β ¥5.94/h · 5:21
//
// Claude Code invokes this with a JSON payload on stdin whose `transcript_path`
// points at the session's own JSONL, so everything here comes from the transcript
// the CLI is already writing — no hooks, no daemon, no DSH.
//
// The pricing engine lives in this project's own `lib/`, imported directly:
// DeepSeek's bundled two-currency table, the fetched third-party list, and the
// ECB rate — one engine, several hosts. It originates in dsh-budget-watcher and
// is copied here so this project stands alone; the two will drift on purpose.
//
// Speed matters: this runs constantly, so the hot path never touches the
// network. The rate card and the exchange rate live in an on-disk cache with the
// same TTL-and-backoff discipline the DSH plugin uses, and a stale cache is
// refreshed by a detached child so the line never waits on a stranger's server.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { burnPerHour, usageCost } from "../lib/cost.js";
import { createPriceBook, canonicalName, parseOpenRouterModels } from "../lib/pricing.js";
import { diffPricing, pricingRows, renderPricingDoc, summariseDiff } from "../src/pricing-doc.mjs";
import { parseEcbDaily } from "../lib/fx.js";
import { resolveConfig } from "../src/autostart.mjs";

const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

// Read once at load: the status line is spawned per render, and the same config file
// already decides the window's geometry and currency, so a burn window that lived
// only in this file would make the two renderers disagree about the same session.
const CONFIG = resolveConfig(homedir());

/** The same window the window's chart uses, and the DSH panel's own default. */
const BURN_WINDOW_MS = CONFIG.burnWindowMs;
/** How old the on-disk pricing cache may be before a refresh is kicked off. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** After a failed fetch, wait this long before trying again. */
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
/** An in-flight turn with nothing new for this long is treated as ended. */
// How long after the last settled step the turn is taken to be over. The window (src/figures.mjs)
// can afford 30s because a host there often reports its own lifecycle; a status line has no such
// signal, so it uses a shorter window to settle the clock sooner. Either way the frozen value is
// the turn's own end — a host that reports its duration outright (Codex) freezes on that number
// exactly, and this file has no such report to prefer.
const IDLE_IS_ENDED_MS = 8_000;

const CURRENCY = CONFIG.currency;
const SYMBOL = CURRENCY === "USD" ? "$" : "\u00a5";
const BETA = "\u03b2";
const CACHE_DIR = process.env.SPEND_WATCH_CACHE ?? join(homedir(), ".cache", "spend-watch");
const CACHE_PATH = join(CACHE_DIR, "claude-pricing.json");
/** The offline record: the rates themselves, and the document rendered from them. */
const ROWS_PATH = join(CACHE_DIR, "pricing-rows.json");
const DOC_PATH = join(CACHE_DIR, "pricing.md");

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

// ---------------------------------------------------------------- cache ----

function loadCache() {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    if (parsed === null || typeof parsed !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function saveCache(cache) {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache));
  } catch {
    // A cache that cannot be written costs one cold start later, nothing more.
  }
}

/** One canonical key per spelling, so cached entries meet the names sessions use. */
function flattenIndex(index) {
  const models = {};
  for (const [id, entry] of index.byId) {
    const bare = id.split("/").pop() ?? id;
    const flat = { currency: "USD", cacheHit: entry.cacheHit, cacheMiss: entry.cacheMiss, output: entry.output, label: entry.label };
    for (const key of new Set([id, bare, canonicalName(id), canonicalName(bare)])) {
      if (key !== "") models[key.toLowerCase()] = flat;
    }
  }
  return models;
}

/**
 * Fetch both sources and write the cache. Runs in a detached child, or inline once.
 *
 * A failed model fetch must not be recorded as a success. It used to be: the cache was written
 * with `models: {}` and a fresh `fetchedAt`, so for the next 24 hours the status line believed
 * it had a rate card, priced nothing, and reported `¥0.00` with every model "unpriced" — which
 * is exactly what a machine that cannot reach openrouter.ai sees. Two rules now:
 *
 *   * `fetchedAt` moves only when the model list actually arrived, so a failure leaves the cache
 *     stale and the next run tries again;
 *   * `models` is only replaced by a non-empty table, so a working rate card survives a
 *     transient failure instead of being wiped by it;
 *   * `lastAttemptAt` throttles the retries, because "stale" alone would mean one fetch per
 *     status-line render, each waiting out its own timeout.
 */
async function refreshCache() {
  const previous = loadCache() ?? {};
  const [ecbXml, list] = await Promise.all([
    fetch(ECB_DAILY_URL, { headers: { accept: "application/xml,text/xml" } })
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null),
    fetch(OPENROUTER_MODELS_URL, { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);
  const fx = ecbXml === null ? undefined : parseEcbDaily(ecbXml);
  const index = list === null ? undefined : parseOpenRouterModels(list);
  const fetched = index !== undefined && index.size > 0;
  const now = new Date().toISOString();
  // The FX rates come from a different endpoint and can succeed on their own; keep whatever
  // worked rather than discarding it with the part that did not.
  const usdToCny = fx?.usdToCny ?? previous.usdToCny ?? null;

  saveCache({
    fetchedAt: fetched ? now : (previous.fetchedAt ?? null),
    lastAttemptAt: now,
    usdToCny,
    usdToCnyDate: fx?.date ?? previous.usdToCnyDate ?? null,
    models: fetched ? flattenIndex(index) : (previous.models ?? {}),
    modelsFetchedAt: fetched ? now : (previous.modelsFetchedAt ?? null),
    lastError: fetched ? null : `could not fetch the model list from ${OPENROUTER_MODELS_URL}`,
  });

  if (fetched) recordPricing(now, usdToCny, pricingRows(index));
}

/**
 * Update the offline pricing record, and rewrite the document only when the list has moved.
 *
 * The record is written on every successful fetch, because "when was this last checked" is itself
 * worth knowing. The document is not: rewriting it each time would destroy the one thing it is
 * for — being able to see *when a rate last changed* — so it is rendered when the list differs, on
 * first run, or if it has gone missing.
 */
function recordPricing(now, usdToCny, rows) {
  try {
    const previous = loadRows();
    const diff = previous === undefined
      ? { added: rows.map((row) => row.id), removed: [], changed: [], empty: rows.length === 0 }
      : diffPricing(previous.rows, rows);
    const changedAt = previous === undefined || !diff.empty ? now : (previous.changedAt ?? now);
    // The change summary is kept in the record, not only in the rendered document, so
    // `acm pricing` can report what moved without parsing the Markdown back apart.
    const snapshot = {
      fetchedAt: now,
      changedAt,
      checkedAt: now,
      source: OPENROUTER_MODELS_URL,
      usdToCny,
      rows,
      lastChange: summariseDiff(diff),
    };

    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(ROWS_PATH, JSON.stringify(snapshot));
    if (previous === undefined || !diff.empty || !existsSync(DOC_PATH)) {
      writeFileSync(DOC_PATH, renderPricingDoc({ rows, fetchedAt: now, changedAt, checkedAt: now, source: OPENROUTER_MODELS_URL, usdToCny, diff }));
    }
  } catch {
    // A record that cannot be written is a lost convenience, not a broken status line.
  }
}

/** The offline record, or undefined when nothing has ever been fetched. */
function loadRows() {
  try {
    const parsed = JSON.parse(readFileSync(ROWS_PATH, "utf8"));
    return parsed !== null && typeof parsed === "object" && Array.isArray(parsed.rows) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function refreshInBackground() {
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--refresh"], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // A refresh that cannot start costs one cold line later, not a crash.
  }
}

// ------------------------------------------------------------- transcript ----

/**
 * Fold a transcript into priced units.
 *
 * One unit per assistant entry that reports usage, keyed to the turn it belongs
 * to. A turn starts at a genuine user prompt: tool results also arrive as `user`
 * entries and must not be mistaken for one, or every tool call would read as a
 * fresh turn and the average burn would be nonsense.
 *
 * @param {string[]} raw transcript lines
 * @param {number} fallbackNow used when a timestamp will not parse
 * @returns {{units: object[], lastTurn: number, awaitingToolResult: boolean, turnStartedAt: number|null}}
 */
export function collectUnits(raw, fallbackNow = Date.now()) {
  const units = [];
  const seenIds = new Map();
  let turn = 0;
  // True while the transcript ends with a tool call whose result has not been written.
  // A long command is otherwise indistinguishable from an ended turn, and treating it as
  // ended froze the clock and zeroed the live rate in the middle of a running turn.
  let awaitingToolResult = false;
  // When the current turn actually began: the prompt's own timestamp, not the first billed
  // call's, which lands seconds later and made every turn look shorter than it was.
  let turnStartedAt = null;

  for (const line of raw) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const time = Number.isFinite(Date.parse(entry.timestamp)) ? Date.parse(entry.timestamp) : fallbackNow;

    if (entry.type === "user") {
      if (entry.isSidechain !== true && isUserPrompt(entry)) {
        turn += 1;
        awaitingToolResult = false;
        turnStartedAt = time;
        continue;
      }
      // A tool result also arrives as a `user` entry. It closes the wait; it never opens
      // a turn, or every tool call would read as a fresh one and the average would be
      // nonsense.
      if (hasBlock(entry, "tool_result")) awaitingToolResult = false;
      continue;
    }
    if (entry.type !== "assistant") continue;

    // Set before the usage check: the entry that requests a tool is exactly the one that
    // may carry no usage at all.
    if (entry.isSidechain !== true) awaitingToolResult = hasBlock(entry, "tool_use");

    const usage = entry.message?.usage;
    if (usage === undefined || usage === null || typeof usage !== "object") continue;

    // One API response can be logged more than once. Summing repeats would
    // double the bill, so an id that recurs keeps its largest output count —
    // a repeat either restates the same usage or carries a partial one.
    const id = entry.message?.id;
    const unit = {
      turn,
      time,
      model: String(entry.message?.model ?? ""),
      sidechain: entry.isSidechain === true,
      usage: {
        inputTokens: Number(usage.input_tokens) || 0,
        outputTokens: Number(usage.output_tokens) || 0,
        cacheReadTokens: Number(usage.cache_read_input_tokens) || 0,
        cacheWriteTokens: Number(usage.cache_creation_input_tokens) || 0,
      },
    };
    if (typeof id === "string" && id !== "") {
      const prev = seenIds.get(id);
      if (prev !== undefined) {
        if (unit.usage.outputTokens > prev.usage.outputTokens) {
          prev.usage = unit.usage;
          prev.turn = unit.turn;
          prev.time = unit.time;
          prev.model = unit.model;
        }
        continue;
      }
      seenIds.set(id, unit);
    }
    units.push(unit);
  }
  return { units, lastTurn: turn, awaitingToolResult, turnStartedAt };
}

/** Does this entry's content contain a block of the given type? */
function hasBlock(entry, type) {
  const content = entry.message?.content;
  return Array.isArray(content) && content.some((block) => block?.type === type);
}

/** A tool result arrives as a `user` entry; only a real prompt opens a turn. */
function isUserPrompt(entry) {
  const content = entry.message?.content;
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "");
}

// ----------------------------------------------------------------- render ----

function money(amount) {
  return SYMBOL + (Number.isFinite(amount) ? amount : 0).toFixed(2);
}

function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The one line, assembled from the figures the engine produced. */
export function renderLine({ units, now, usdToCny, lookup, pricingNote = "" }) {
  let sessionCost = 0;
  let windowCost = 0;
  let turnCost = 0;
  let turnStart = null;
  let lastActivity = null;

  for (const unit of units) {
    // An unpriced model is unknown spend, not free: it adds nothing here, and
    // reporting it as unpriced is the DSH panel's job, not a status line's.
    const cost = usageCost(unit.usage, unit.model, unit.time, CURRENCY, lookup)?.cost ?? 0;
    sessionCost += cost;
    if (now - unit.time <= BURN_WINDOW_MS) windowCost += cost;
  }

  // The current turn is the last one that has a priced unit; its cost, start and
  // last activity come from its own units rather than from the transcript tail,
  // because a turn can end with tool calls that report no usage at all.
  let lastTurnNumber = -1;
  for (const unit of units) if (unit.turn > lastTurnNumber) lastTurnNumber = unit.turn;
  for (const unit of units) {
    if (unit.turn !== lastTurnNumber) continue;
    turnCost += usageCost(unit.usage, unit.model, unit.time, CURRENCY, lookup)?.cost ?? 0;
    if (turnStart === null || unit.time < turnStart) turnStart = unit.time;
    if (lastActivity === null || unit.time > lastActivity) lastActivity = unit.time;
  }

  // While the turn is live the elapsed clock keeps running; once it has gone
  // quiet the average freezes where the last activity left it, as the panel does.
  const live = lastActivity !== null && now - lastActivity < IDLE_IS_ENDED_MS;
  const turnElapsed = turnStart === null ? 0 : (live ? now : lastActivity) - turnStart;
  const average = turnElapsed > 0 ? burnPerHour(turnCost, turnElapsed) : 0;

  const parts = [
    `${money(turnCost)} / ${money(sessionCost)}`,
    `${BETA}(t) ${money(windowCost > 0 ? burnPerHour(windowCost, BURN_WINDOW_MS) : 0)}/h`,
    `${BETA} ${money(average)}/h`,
    clock(turnElapsed),
  ];
  // A line that reads ¥0.00 because there is no rate card is worse than one that says so: the
  // figures look like a cheap session rather than a missing price list. Only appended when
  // pricing is actually impaired, so the normal line stays a single row of numbers.
  if (pricingNote !== "") parts.push(`(${pricingNote})`);
  return parts.join(" \u00b7 ");
}

// ------------------------------------------------------------------- main ----

async function main() {
  let payload = {};
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    // No stdin payload: Claude Code did not run us as a status line.
  }

  if (process.argv.includes("--refresh")) {
    await refreshCache();
    process.exit(0);
  }

  const cache = loadCache();
  // A cache with no model table is not a rate card, however recently it was written. Treating
  // "fresh" as "written recently" is what made a failed fetch poison the next 24 hours: the
  // stamp was new, the table was empty, and every figure read ¥0.00 with nothing to explain it.
  const cachedModels = Object.keys(cache?.models ?? {}).length;
  const fresh =
    cache !== undefined &&
    cachedModels > 0 &&
    Number.isFinite(Date.parse(cache.fetchedAt)) &&
    Date.now() - Date.parse(cache.fetchedAt) < CACHE_TTL_MS;
  // A stale cache normally means "fetch again", but a cache that is stale because every fetch
  // has been failing would then trigger one attempt per render, each waiting out its own
  // timeout. So a failed attempt buys a quiet period before the next try.
  const attemptedAt = Date.parse(cache?.lastAttemptAt ?? "");
  const cooled = Number.isFinite(attemptedAt) && Date.now() - attemptedAt < RETRY_AFTER_FAILURE_MS;
  let pricingNote = "";
  if (!fresh && !cooled) {
    // Never wait for the network here. The first version fetched inline under a 2.5 s cap, and
    // the cap was a lie: the fetch kept the event loop alive until the socket gave up, so a cold
    // cache made this script take TEN SECONDS — far past the moment a status line must answer.
    // That is why a fresh install showed no line at all while the window opened normally.
    // Rendering from whatever is cached and refreshing in the background costs one unpriced
    // poll and cannot be late.
    refreshInBackground();
  } else if (!fresh) {
    // Said out loud rather than left as a silent `¥0.00`: figures missing a rate card are a
    // different thing from a session that cost nothing, and only one of them is good news.
    pricingNote = cache.lastError ?? "pricing is out of date";
  }

  const rate = loadCache();
  const usdToCny = rate?.usdToCny ?? 0;
  const priced = Object.keys(rate?.models ?? {}).length;
  if (pricingNote === "" && priced === 0) pricingNote = "no rate card";
  const book = createPriceBook({ enabled: false, bundled: rate?.models ?? {} });
  const lookup = (model, options) => book.lookup(model, { ...options, usdToCny });

  const transcriptPath = typeof payload?.transcript_path === "string" ? payload.transcript_path : "";
  let raw = [];
  if (transcriptPath !== "" && existsSync(transcriptPath)) {
    try {
      raw = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
    } catch {
      raw = [];
    }
  }

  const { units } = collectUnits(raw);
  process.stdout.write(renderLine({ units, now: Date.now(), usdToCny, lookup, pricingNote }) + "\n");
}

if (isMain) {
  main().catch(() => {
    // The status line is the one place a crash is definitely worse than a shrug.
    process.stdout.write(`${SYMBOL}0.00 / ${SYMBOL}0.00 \u00b7 ${BETA}(t) ${SYMBOL}0.00/h \u00b7 ${BETA} ${SYMBOL}0.00/h \u00b7 0:00\n`);
  });
}
