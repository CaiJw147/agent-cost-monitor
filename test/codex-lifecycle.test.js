// Codex's own turn boundaries.
//
// This is the fix for a turn Codex called 51 seconds being shown as 0:18 that kept counting
// upward: the window derived turns from usage samples, and the first *billed* call lands well
// after the turn begins. Codex records the truth — `event_msg/task_started` and
// `event_msg/task_complete`, with `started_at`, `completed_at` and `duration_ms` — so the
// adapter now reads it instead of guessing. Measured on a real rollout: 51.7 s by lifecycle,
// 17.6 s from samples alone.
import assert from "node:assert/strict";
import test from "node:test";

import { parseRollout } from "../src/codex.mjs";

const line = (o) => JSON.stringify(o);
const usage = { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 10 };
const billed = (timestamp) => ({ type: "response_item", timestamp, payload: { usage } });
const started = (timestamp, turn = "t1") => ({
  type: "event_msg",
  timestamp,
  payload: { type: "task_started", turn_id: turn, started_at: timestamp },
});
const completed = (timestamp, durationMs, turn = "t1") => ({
  type: "event_msg",
  timestamp,
  payload: { type: "task_complete", turn_id: turn, completed_at: timestamp, duration_ms: durationMs },
});

test("a turn is what task_started says it is, not what a turn_context happens to be", () => {
  // The real shape that exposed this: four turns, two turn_context entries.
  const lines = [
    line(started("2026-10-12T21:42:53.000Z", "t1")),
    line(billed("2026-10-12T21:43:25.000Z")),
    line(completed("2026-10-12T21:43:45.000Z", 51_700, "t1")),
    line({ type: "turn_context", timestamp: "2026-10-12T21:43:00.000Z", payload: { model: "gpt-6-sol" } }),
    line(started("2026-10-12T22:00:00.000Z", "t2")),
    line(billed("2026-10-12T22:00:30.000Z")),
  ];
  const parsed = parseRollout(lines);
  assert.equal(parsed.sawLifecycle, true);
  assert.deepEqual(parsed.units.map((u) => u.turn), [1, 2], "grouped by task, so turn_context cannot merge two of them");
  assert.equal(parsed.turnStartedAt, Date.parse("2026-10-12T22:00:00.000Z"), "the turn's real start");
  assert.equal(parsed.turnEndedAt, null, "and it is still running");
  assert.equal(parsed.turnDurationMs, null);
});

test("Codex's own duration is used, and a completed turn reports an end", () => {
  const parsed = parseRollout([line(started("2026-10-12T21:42:53.000Z")), line(billed("2026-10-12T21:43:25.000Z")), line(completed("2026-10-12T21:43:45.000Z", 51_700))]);
  assert.equal(parsed.turnDurationMs, 51_700, "not re-derived from the billed samples, which span 20s");
  assert.equal(parsed.turnStartedAt, Date.parse("2026-10-12T21:42:53.000Z"));
  assert.equal(parsed.turnEndedAt, Date.parse("2026-10-12T21:43:45.000Z"));
});

test("a new turn forgets the previous turn's duration", () => {
  const parsed = parseRollout([line(started("2026-10-12T21:42:53.000Z", "t1")), line(completed("2026-10-12T21:43:45.000Z", 51_700, "t1")), line(started("2026-10-12T22:00:00.000Z", "t2"))]);
  assert.equal(parsed.turnDurationMs, null, "otherwise the second turn would show the first one's length");
  assert.equal(parsed.turnEndedAt, null);
});

test("a rollout with no lifecycle events at all still works, via turn_context", () => {
  // An older CLI. The fallback keeps the previous behaviour rather than reporting one turn.
  const parsed = parseRollout([
    line({ type: "turn_context", timestamp: "2026-10-12T21:00:00.000Z", payload: { model: "m" } }),
    line(billed("2026-10-12T21:00:10.000Z")),
    line({ type: "turn_context", timestamp: "2026-10-12T21:05:00.000Z", payload: { model: "m" } }),
    line(billed("2026-10-12T21:05:10.000Z")),
  ]);
  assert.equal(parsed.sawLifecycle, false);
  assert.deepEqual(parsed.units.map((u) => u.turn), [1, 2]);
  assert.equal(parsed.turnStartedAt, null, "no boundary to promise, so the caller falls back to its own rule");
});

test("epoch SECONDS are read as seconds, because that is what Codex writes", () => {
  // The real value from a rollout: started_at = 1791801708 for an entry stamped
  // 2026-10-12T10:41:48Z. Read as milliseconds that is January 1970, and the window showed an
  // elapsed time of 1.79 billion seconds with no visible turn duration.
  const entryMs = Date.parse("2026-10-12T10:41:48.588Z");
  const parsed = parseRollout([
    line({ type: "event_msg", timestamp: "2026-10-12T10:41:48.588Z", payload: { type: "task_started", started_at: Math.floor(entryMs / 1000) } }),
    line({ type: "event_msg", timestamp: "2026-10-12T10:42:39.000Z", payload: { type: "task_complete", completed_at: Math.floor(entryMs / 1000) + 51, duration_ms: 51_000 } }),
  ]);
  assert.equal(parsed.turnStartedAt, Math.floor(entryMs / 1000) * 1000, "seconds scaled to milliseconds");
  assert.equal(parsed.turnEndedAt, (Math.floor(entryMs / 1000) + 51) * 1000);
  assert.ok(parsed.turnStartedAt > 1e12, "a sane epoch in ms, not 1970");
  // Sub-second precision is not invented: Codex recorded whole seconds, so that is what the
  // turn's start is. The entry's own timestamp is the fallback when started_at is absent.
  assert.equal(parsed.turnStartedAt % 1000, 0);
});

test("a missing started_at falls back to the entry's own timestamp", () => {
  const parsed = parseRollout([line({ type: "event_msg", timestamp: "2026-10-12T10:41:48.588Z", payload: { type: "task_started" } })]);
  assert.equal(parsed.turnStartedAt, Date.parse("2026-10-12T10:41:48.588Z"));
});
