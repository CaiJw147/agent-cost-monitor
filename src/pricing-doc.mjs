// An offline copy of the rate card, and the change detection that keeps it honest.
//
// The lookup cache and this are two different jobs. The cache exists to price a session: its keys
// are aliases, its values are flat rates, and a failed fetch must never touch it. This is the
// record: one row per real model, in a file a person can read without a network, rewritten only
// when the fetched list has actually changed — so a provider quietly repricing a model is visible
// rather than being absorbed into the next number.
//
// Everything here is pure, so the diff and the document can be tested without a fetch.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the three files live.
 *
 * The fetch site (`claude/statusline.mjs`) writes them, `acm pricing` reads them, and one naming
 * convention in one place is what keeps those two from disagreeing about where a rate card is.
 */
export function pricingPaths(cacheDir = process.env.SPEND_WATCH_CACHE ?? join(homedir(), ".cache", "spend-watch")) {
  return {
    dir: cacheDir,
    cache: join(cacheDir, "claude-pricing.json"),
    rows: join(cacheDir, "pricing-rows.json"),
    doc: join(cacheDir, "pricing.md"),
  };
}

/** The offline record as written by the status line, or undefined when there is none. */
export function readPricingRecord(rowsPath) {
  try {
    const parsed = JSON.parse(readFileSync(rowsPath, "utf8"));
    return parsed !== null && typeof parsed === "object" && Array.isArray(parsed.rows) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** USD per million tokens, as the engine's rate card stores them. */
const rate = (value) => {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  return abs < 1 ? value.toFixed(4) : value.toFixed(2);
};

/**
 * The index from `parseOpenRouterModels`, as comparable rows: one per model id, sorted.
 *
 * `flattenIndex` deliberately fans a model out into every spelling a session might use — that is
 * right for lookups and wrong for a document, which would otherwise list the same model four
 * times. This reads `byId`, so one model is one row.
 */
export function pricingRows(index) {
  const rows = [];
  for (const [id, entry] of index?.byId ?? []) {
    rows.push({
      id,
      input: entry.cacheMiss,
      cachedInput: entry.cacheHit,
      cacheWrite: entry.cacheWrite,
      output: entry.output,
      label: typeof entry.label === "string" ? entry.label : "",
    });
  }
  return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** What changed between two snapshots, by model id. */
export function diffPricing(previous, next) {
  const before = new Map((previous ?? []).map((row) => [row.id, JSON.stringify(row)]));
  const after = new Map((next ?? []).map((row) => [row.id, JSON.stringify(row)]));
  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  const changed = [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id));
  return { added, removed, changed, empty: added.length === 0 && removed.length === 0 && changed.length === 0 };
}

/** One line for a log, a status command or a note in the document. */
export function summariseDiff(diff) {
  if (diff === undefined || diff.empty) return "no change";
  const bits = [];
  if (diff.added.length > 0) bits.push(`${diff.added.length} added`);
  if (diff.removed.length > 0) bits.push(`${diff.removed.length} removed`);
  if (diff.changed.length > 0) bits.push(`${diff.changed.length} repriced`);
  return bits.join(", ");
}

/**
 * The document.
 *
 * Written to be useful with the network unplugged: what the rates are, when they were fetched,
 * when they last changed, and what changed then. A reader who only ever sees this file should be
 * able to tell whether it is stale, which is the thing a bare table cannot say.
 */
export function renderPricingDoc({ rows, fetchedAt, changedAt, checkedAt, source, usdToCny, diff }) {
  const when = (value) => (typeof value === "string" && value !== "" ? value : "never");
  const hasCacheWrite = rows.some((row) => Number.isFinite(row.cacheWrite));
  const header = hasCacheWrite
    ? "| Model | Input | Cached input | Cache write | Output |"
    : "| Model | Input | Cached input | Output |";
  const rule = hasCacheWrite ? "|---|---|---|---|---|" : "|---|---|---|---|";

  const lines = [
    "# Model pricing — offline copy",
    "",
    "USD per million tokens, as published by the provider aggregator this project reads.",
    "Written automatically whenever that list is fetched successfully **and has changed**; it is",
    "never rewritten with an empty or partial list, so a network problem cannot erase it.",
    "",
    `- Models: **${rows.length}**`,
    `- Rates fetched: ${when(fetchedAt)}`,
    `- Rates last changed: ${when(changedAt)}`,
    `- Last checked: ${when(checkedAt)}`,
    `- Last change: ${summariseDiff(diff)}`,
    `- USD to CNY: ${Number.isFinite(usdToCny) ? usdToCny.toFixed(4) : "—"} (ECB daily)`,
    `- Source: ${source ?? "unknown"}`,
    "",
    "Regenerate with `acm pricing --refresh` (needs the network) or inspect it with `acm pricing`.",
    "",
    header,
    rule,
  ];

  for (const row of rows) {
    const cells = [`\`${row.id}\``, rate(row.input), rate(row.cachedInput)];
    if (hasCacheWrite) cells.push(rate(row.cacheWrite));
    cells.push(rate(row.output));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  if (rows.length === 0) lines.push(hasCacheWrite ? "| _(nothing fetched yet)_ | | | | |" : "| _(nothing fetched yet)_ | | | |");
  lines.push("");
  return lines.join("\n");
}
