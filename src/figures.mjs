// The figures every renderer shows, from priced units.
//
// This lived inside window/serve.mjs, which listens on import and so cannot be tested.
// It is the arithmetic behind the headline numbers, including two behaviours that were
// wrong in ways only real use revealed:
//
//   * the series ended at the last settled point rather than at now, so a long tool call
//     left the chart's right edge minutes in the past — read as a frozen chart and a
//     wrong clock, when the truth was "nothing spent for three minutes";
//   * a turn with no new usage for 30 seconds was called ended, so a slow command froze
//     the clock and zeroed β(t) in the middle of a turn that was still running.

import { burnPerHour, usageCost } from "../lib/cost.js";

export const BURN_WINDOW_MS_DEFAULT = 15_000;
/** Nothing new for this long, with no tool call in flight, means the turn has ended. */
export const IDLE_IS_ENDED_MS = 30_000;

/**
 * @param {object[]} units priced units: {turn, time, model, usage}
 * @param {object} options
 * @param {number} options.now
 * @param {string} options.currency
 * @param {(model: string, o?: object) => object|undefined} options.lookup
 * @param {number} options.burnWindowMs
 * @param {boolean} [options.awaiting] the transcript ends with an unanswered tool call
 */
export function figuresFrom(units, { now, currency, lookup, burnWindowMs, awaiting = false, approximate = false, note = "" }) {
  const window = Number.isFinite(burnWindowMs) && burnWindowMs > 0 ? burnWindowMs : BURN_WINDOW_MS_DEFAULT;
  const price = (u) => usageCost(u.usage, u.model, u.time, currency, lookup);

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

  // A trailing window, not a running total: an accumulator that never removes aged-out
  // calls makes the line climb forever, which is the opposite of a burn rate.
  const costs = sorted.map((u) => price(u)?.cost ?? 0);
  const series = [];
  let windowCost = 0;
  let start = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    windowCost += costs[i];
    while (sorted[start].time < sorted[i].time - window) windowCost -= costs[start++];
    series.push({ atMs: sorted[i].time, amountPerHour: burnPerHour(windowCost, window) });
  }

  const liveBurn = burnPerHour(
    sorted.filter((u) => now - u.time <= window).reduce((sum, u) => sum + (price(u)?.cost ?? 0), 0),
    window,
  );

  let turnCost = 0;
  let turnStart = null;
  let lastActivity = null;
  for (const u of sorted) {
    if (u.turn !== lastTurn) continue;
    turnCost += price(u)?.cost ?? 0;
    if (turnStart === null || u.time < turnStart) turnStart = u.time;
    if (lastActivity === null || u.time > lastActivity) lastActivity = u.time;
  }

  // A tool call in flight is a running turn however long it takes: the transcript ends
  // with a `tool_use` whose result has not been written yet, so the absence of new usage
  // is the expected state, not evidence the turn is over.
  const live = awaiting || (lastActivity !== null && now - lastActivity < IDLE_IS_ENDED_MS);
  const elapsedMs = turnStart === null ? 0 : (live ? now : lastActivity) - turnStart;

  // The chart runs to now. Without this the axis ends at the last settled point, so a
  // three-minute tool call shows a chart whose right-hand label is three minutes stale —
  // which is a broken axis, not a quiet period.
  series.push({ atMs: now, amountPerHour: liveBurn });

  return {
    turnCost,
    sessionCost,
    liveBurn,
    averageBurn: elapsedMs > 0 ? burnPerHour(turnCost, elapsedMs) : 0,
    elapsedMs,
    live,
    turns: lastTurn,
    models: [...new Set(sorted.map((u) => u.model).filter((m) => m !== ""))].slice(0, 4),
    series: series.slice(-240),
    unpriced,
    approximate,
    note,
  };
}
