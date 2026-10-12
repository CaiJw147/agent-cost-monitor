// The figures every renderer shows, from priced units.
//
// This lived inside window/serve.mjs, which listens on import and so cannot be tested.
// It is the arithmetic behind the headline numbers, including three behaviours that were
// wrong in ways only real use revealed:
//
//   * the series ended at the last settled point rather than at the turn's current elapsed
//     time, so a long tool call left the chart's right edge minutes behind;
//   * a turn with no new usage for 30 seconds was called ended, so a slow command froze the
//     clock and zeroed β(t) in the middle of a turn that was still running;
//   * and the series was wall-clock absolute and spanned every turn, where the DSH panel's
//     is turn-relative and covers the current turn only. Two renderers of the same idea have
//     to agree about what the picture means, so this now matches the panel exactly: times are
//     measured from the turn's own start, and the axis stops when the turn does.

import { burnPerHour, usageCost } from "../lib/cost.js";

export const BURN_WINDOW_MS_DEFAULT = 15_000;
/** Nothing new for this long, with no tool call in flight, means the turn has ended. */
export const IDLE_IS_ENDED_MS = 30_000;
/** Cap on the plotted samples, the same cap the panel uses, so a fan-out cannot bloat it. */
export const SERIES_CAP = 240;

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

  // The current turn, which is what the chart draws.
  let turnCost = 0;
  let turnStart = null;
  let lastActivity = null;
  const turnUnits = sorted.filter((u) => u.turn === lastTurn);
  for (const u of turnUnits) {
    turnCost += price(u)?.cost ?? 0;
    if (turnStart === null || u.time < turnStart) turnStart = u.time;
    if (lastActivity === null || u.time > lastActivity) lastActivity = u.time;
  }

  // A tool call in flight is a running turn however long it takes: the transcript ends with
  // a `tool_use` whose result has not been written yet, so the absence of new usage is the
  // expected state, not evidence the turn is over.
  const live = awaiting || (lastActivity !== null && now - lastActivity < IDLE_IS_ENDED_MS);
  const elapsedMs = turnStart === null ? 0 : (live ? now : lastActivity) - turnStart;
  const origin = turnStart ?? now;

  // A trailing window over the turn's own steps, sampled at each settled step and timed from
  // the turn's start — the panel's `series`, in the panel's units. An accumulator that never
  // removed aged-out calls would make the line climb forever, which is the opposite of a
  // burn rate.
  const costs = turnUnits.map((u) => price(u)?.cost ?? 0);
  const series = [];
  let windowCost = 0;
  let start = 0;
  for (let i = 0; i < turnUnits.length; i += 1) {
    windowCost += costs[i];
    while (turnUnits[start].time < turnUnits[i].time - window) windowCost -= costs[start++];
    series.push({ atMs: turnUnits[i].time - origin, amountPerHour: burnPerHour(windowCost, window) });
  }

  const liveBurn = burnPerHour(
    sorted.filter((u) => now - u.time <= window).reduce((sum, u) => sum + (price(u)?.cost ?? 0), 0),
    window,
  );

  return {
    turnCost,
    sessionCost,
    liveBurn,
    averageBurn: elapsedMs > 0 ? burnPerHour(turnCost, elapsedMs) : 0,
    elapsedMs,
    live,
    ended: !live,
    turns: lastTurn,
    models: [...new Set(sorted.map((u) => u.model).filter((m) => m !== ""))].slice(0, 4),
    // Relative to the turn's start, and deliberately without a trailing point: the page adds
    // the sample at the current elapsed time, exactly as the panel's client does.
    series: series.slice(-SERIES_CAP),
    unpriced,
    approximate,
    note,
  };
}
