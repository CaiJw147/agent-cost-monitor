// The arithmetic behind every headline number.
//
// This was inside window/serve.mjs, which listens on import and therefore could not be
// tested at all — and two of its behaviours were wrong in ways only real use found: the
// series stopped at the last settled point (so a long tool call left the chart's axis
// minutes in the past) and a turn idle for 30 seconds was called ended (so a slow command
// froze the clock and zeroed β(t) mid-turn).
import assert from "node:assert/strict";
import test from "node:test";

import { BURN_WINDOW_MS_DEFAULT, IDLE_IS_ENDED_MS, figuresFrom } from "../src/figures.mjs";

/**
 * A flat rate card, so the expected numbers are arithmetic rather than a lookup table.
 *
 * The shape matters: `usageCost` wants per-million rates (`cacheHit`/`cacheMiss`/
 * `output`) and multiplies by the token counts itself — returning a finished cost here
 * produced NaN everywhere, which is how the first version of this test failed.
 */
const FLAT = { cacheHit: 1, cacheMiss: 1, output: 1 };
const lookup = (model) => (model === "test-model" ? FLAT : undefined);
const rateCard = { currency: "CNY", lookup };
const T0 = 1_700_000_000_000;

/** A unit costing exactly 1 CNY: 1M input tokens at 1 per million. */
const unit = (turn, time, tokens = 1_000_000) => ({
  turn,
  time,
  model: "test-model",
  usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
});

const options = (now, extra = {}) => ({ now, ...rateCard, burnWindowMs: BURN_WINDOW_MS_DEFAULT, ...extra });

test("costs are summed, and an unknown model is counted as unpriced rather than as free", () => {
  const f = figuresFrom(
    [unit(1, T0), unit(1, T0 + 1000), { turn: 1, time: T0 + 2000, model: "mystery", usage: { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
    options(T0 + 2000),
  );
  assert.equal(f.sessionCost, 2);
  assert.equal(f.turnCost, 2);
  assert.equal(f.unpriced, 1, "and it is not silently counted as zero cost");
});

test("the series is timed from the turn's own start, like the panel's", () => {
  // The panel's ledger records `atMs` relative to the turn, and two renderers of one idea
  // must agree about what the x axis means. This used to be wall-clock absolute, which also
  // meant a finished turn's chart slid out from under its own line.
  const f = figuresFrom([unit(1, T0), unit(1, T0 + 1000), unit(1, T0 + 9000)], options(T0 + 9000));
  assert.deepEqual(f.series.map((p) => p.atMs), [0, 1000, 9000]);
  assert.equal(f.elapsedMs, 9000);
});

test("the series covers the current turn, not the session", () => {
  // Both turns' units share one timeline, so mixing them would put turn 2's samples on top of
  // turn 1's.
  const f = figuresFrom([unit(1, T0), unit(1, T0 + 5000), unit(2, T0 + 60_000), unit(2, T0 + 62_000)], options(T0 + 62_000));
  assert.deepEqual(f.series.map((p) => p.atMs), [0, 2000], "timed from turn 2's own start");
  assert.equal(f.turns, 2);
});

test("the daemon does not append a point at now — the page owns that sample", () => {
  // The panel's client appends the trailing sample so a live line reaches the axis edge. If
  // both ends did it, a frozen chart would still creep forward.
  const f = figuresFrom([unit(1, T0)], options(T0 + 120_000));
  assert.equal(f.series.length, 1);
  assert.equal(f.series.at(-1).atMs, 0);
  assert.equal(f.ended, true, "and it says the turn is over, which is what freezes the axis");
});

test("a host that reports its own turn bounds is believed over the samples", () => {
  // The bug this fixed, measured on a real Codex rollout: the host called the turn 51.7s while
  // the first and last billed samples spanned 17.6s, because the first call lands well after
  // the turn begins. The window showed 0:18 and kept counting.
  const units = [unit(1, T0 + 30_000), unit(1, T0 + 48_000)];
  const guessed = figuresFrom(units, options(T0 + 48_000));
  assert.equal(guessed.elapsedMs, 18_000, "samples alone give the wrong figure");

  const told = figuresFrom(units, options(T0 + 51_700, { turnStartMs: T0, durationMs: 51_700, live: false }));
  assert.equal(told.elapsedMs, 51_700, "the host's own measurement wins");
  assert.equal(told.ended, true, "and it is over, so the axis is frozen");
  assert.equal(told.series[0].atMs, 30_000, "the series is timed from the turn's real start, so the chart covers the whole turn");
});

test("a host that says the turn is running overrides the idle guess", () => {
  // A Codex turn can sit quiet for minutes inside one command; its lifecycle events, not the
  // absence of billing, are what say whether it is still going.
  const f = figuresFrom([unit(1, T0)], options(T0 + 10 * 60_000, { turnStartMs: T0, live: true }));
  assert.equal(f.live, true);
  assert.equal(f.ended, false);
  assert.equal(f.elapsedMs, 10 * 60_000, "and the clock runs");
});

test("a tool call in flight keeps the turn running, however long it takes", () => {
  // The transcript ends with a tool_use whose result has not been written. That is the
  // expected state during a long command, not evidence the turn ended.
  const now = T0 + IDLE_IS_ENDED_MS + 90_000;
  const f = figuresFrom([unit(1, T0), unit(1, T0 + 1000)], options(now, { awaiting: true }));
  assert.equal(f.live, true);
  assert.equal(f.elapsedMs, now - T0, "the clock runs to now");
  assert.ok(f.averageBurn > 0, "and the average stays a real number instead of freezing");
});

test("with nothing in flight, an idle turn really has ended", () => {
  const now = T0 + IDLE_IS_ENDED_MS + 90_000;
  const f = figuresFrom([unit(1, T0), unit(1, T0 + 1000)], options(now));
  assert.equal(f.live, false);
  assert.equal(f.elapsedMs, T0 + 1000 - T0, "the clock stops at the last activity, not at now");
});

test("the live rate is a trailing window, not a running total", () => {
  // Three calls a second apart, each costing 1: inside a 15s window, three of them are
  // 3 CNY, which over 15 seconds is 720/h. An accumulator that never aged out would keep
  // climbing with every call for the rest of the session.
  const units = [unit(1, T0), unit(1, T0 + 1000), unit(1, T0 + 2000)];
  const f = figuresFrom(units, options(T0 + 2000));
  assert.equal(f.liveBurn, 720);
  assert.equal(f.series.at(-1).amountPerHour, 720);

  // Once the window has passed, the rate is zero even though the session spent 3.
  assert.equal(figuresFrom(units, options(T0 + 60_000)).liveBurn, 0);
  assert.equal(figuresFrom(units, options(T0 + 60_000)).sessionCost, 3);
});

test("only the last turn's cost counts as this turn's, and its clock is its own", () => {
  const f = figuresFrom([unit(1, T0), unit(1, T0 + 500), unit(2, T0 + 60_000)], options(T0 + 64_000));
  assert.equal(f.turns, 2);
  assert.equal(f.turnCost, 1, "the previous turn's spend is not this turn's");
  assert.equal(f.sessionCost, 3);
  assert.equal(f.elapsedMs, 4000, "measured from the second turn's own start");
});

test("an empty session produces zeros rather than NaN", () => {
  const f = figuresFrom([], options(T0));
  assert.deepEqual(
    { t: f.turnCost, s: f.sessionCost, l: f.liveBurn, a: f.averageBurn, e: f.elapsedMs, n: f.turns },
    { t: 0, s: 0, l: 0, a: 0, e: 0, n: 0 },
  );
  assert.equal(f.series.length, 0, "nothing to draw; the page anchors the origin itself");
});

test("a nonsense burn window falls back rather than producing Infinity", () => {
  for (const bad of [0, -1, Number.NaN, undefined]) {
    const f = figuresFrom([unit(1, T0)], options(T0, { burnWindowMs: bad }));
    assert.ok(Number.isFinite(f.liveBurn), `burnWindowMs=${String(bad)} produced ${f.liveBurn}`);
  }
});
