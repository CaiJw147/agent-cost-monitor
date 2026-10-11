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
/** An in-flight turn with nothing new for this long is treated as ended. */
const IDLE_IS_ENDED_MS = 30_000;

const CURRENCY = CONFIG.currency;
const SYMBOL = CURRENCY === "USD" ? "$" : "\u00a5";
const BETA = "\u03b2";
const CACHE_DIR = process.env.SPEND_WATCH_CACHE ?? join(homedir(), ".cache", "spend-watch");
const CACHE_PATH = join(CACHE_DIR, "claude-pricing.json");

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

/** Fetch both sources and write the cache. Runs in a detached child, or inline once. */
async function refreshCache() {
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
  saveCache({
    fetchedAt: new Date().toISOString(),
    usdToCny: fx?.usdToCny ?? null,
    usdToCnyDate: fx?.date ?? null,
    models: index === undefined || index.size === 0 ? {} : flattenIndex(index),
  });
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
 * @returns {{units: object[], lastTurn: number, awaitingToolResult: boolean}}
 */
export function collectUnits(raw, fallbackNow = Date.now()) {
  const units = [];
  const seenIds = new Map();
  let turn = 0;
  // True while the transcript ends with a tool call whose result has not been written.
  // A long command is otherwise indistinguishable from an ended turn, and treating it as
  // ended froze the clock and zeroed the live rate in the middle of a running turn.
  let awaitingToolResult = false;

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
  return { units, lastTurn: turn, awaitingToolResult };
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
export function renderLine({ units, now, usdToCny, lookup }) {
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
  const fresh = cache !== undefined && Number.isFinite(Date.parse(cache.fetchedAt)) && Date.now() - Date.parse(cache.fetchedAt) < CACHE_TTL_MS;
  if (cache === undefined) {
    // First ever run: one short inline fetch so the first line is already priced,
    // then everything goes through the detached child like every other poll.
    await Promise.race([refreshCache(), new Promise((resolve) => setTimeout(resolve, 2500))]);
  } else if (!fresh) {
    refreshInBackground();
  }

  const rate = loadCache();
  const usdToCny = rate?.usdToCny ?? 0;
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
  process.stdout.write(renderLine({ units, now: Date.now(), usdToCny, lookup }) + "\n");
}

if (isMain) {
  main().catch(() => {
    // The status line is the one place a crash is definitely worse than a shrug.
    process.stdout.write(`${SYMBOL}0.00 / ${SYMBOL}0.00 \u00b7 ${BETA}(t) ${SYMBOL}0.00/h \u00b7 ${BETA} ${SYMBOL}0.00/h \u00b7 0:00\n`);
  });
}
