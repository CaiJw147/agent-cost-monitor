// The Codex adapter. Every number a spend line shows depends on this mapping being
// right, and the shapes differ between Codex versions, so it is tested against real
// recorded payloads rather than invented ones.
import assert from "node:assert/strict";
import test from "node:test";

import { looksLikeUsage, parseRollout, toEngineUsage } from "../src/codex.mjs";

// Verbatim from a real 0.155 rollout on this machine.
const USAGE_ROW = {
  type: "response_item",
  timestamp: "2026-09-23T13:31:40.000Z",
  payload: { type: "message", usage: { input_tokens: 30007, cached_input_tokens: 20480, cache_write_input_tokens: 0, output_tokens: 101, reasoning_output_tokens: 0, total_tokens: 30108 } },
};
const line = (entry) => JSON.stringify(entry);
const META = { type: "session_meta", payload: { model_provider: "openai", cli_version: "0.155.0-alpha.9.2" } };
const TURN = { type: "turn_context", payload: { turn_id: "t1", model: "test-model" } };

test("Codex's input_tokens include the cached half, so the cached half is subtracted", () => {
  // 30007 total input with 20480 cached means 9527 were billed at the uncached rate.
  assert.deepEqual(toEngineUsage(USAGE_ROW.payload.usage), {
    inputTokens: 9527,
    cacheReadTokens: 20480,
    cacheWriteTokens: 0,
    outputTokens: 101,
  });
});

test("a nonsense or missing report cannot produce negative uncached tokens", () => {
  assert.equal(toEngineUsage({ input_tokens: 10, cached_input_tokens: 999, output_tokens: 0 }).inputTokens, 0);
  assert.deepEqual(toEngineUsage({}), { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
});

test("usage is found by shape, not by the parent type a given version happens to use", () => {
  assert.equal(looksLikeUsage({ input_tokens: 1, output_tokens: 2 }), true);
  assert.equal(looksLikeUsage({ input_tokens: "5", output_tokens: "6" }), true, "string counts are still counts");
  assert.equal(looksLikeUsage({ input_tokens: 1 }), false, "half a report is not a report");
  assert.equal(looksLikeUsage({ usage_hint_hash: "288fbaab" }), false, "and a hash is not a bill");
  assert.equal(looksLikeUsage(null), false);
});

test("a usage record belongs to the turn_context above it, and carries that model", () => {
  const { units, provider, cliVersion, sawUsage } = parseRollout([line(META), line(TURN), line(USAGE_ROW)]);
  assert.equal(sawUsage, true);
  assert.equal(provider, "openai");
  assert.equal(cliVersion, "0.155.0-alpha.9.2");
  assert.equal(units.length, 1);
  assert.equal(units[0].turn, 1);
  assert.equal(units[0].model, "test-model", "the model that ran, not the one configured");
  assert.equal(units[0].time, Date.parse("2026-09-23T13:31:40.000Z"));
  assert.deepEqual(units[0].usage, { inputTokens: 9527, cacheReadTokens: 20480, cacheWriteTokens: 0, outputTokens: 101 });
});

test("a second turn takes the second model, which is how a mid-session switch is priced", () => {
  const { units } = parseRollout([
    line(META),
    line(TURN),
    line(USAGE_ROW),
    line({ type: "turn_context", payload: { turn_id: "t2", model: "test-model" } }),
    line({ ...USAGE_ROW, timestamp: "2026-09-23T13:35:00.000Z" }),
  ]);
  assert.equal(units.length, 2);
  assert.equal(units[0].model, "test-model");
  assert.equal(units[1].model, "test-model");
  assert.equal(units[1].turn, 2);
});

test("a running turn total is not billed, or the bill multiplies by the turn's length", () => {
  // turn_token_usage is cumulative, so it is skipped while per-call reports are kept.
  const cumulative = { type: "response_item", timestamp: "2026-09-23T13:31:41.000Z", payload: { turn_token_usage: { input_tokens: 60517, cached_input_tokens: 50304, output_tokens: 200 } } };
  const { units } = parseRollout([line(META), line(TURN), line(USAGE_ROW), line(cumulative)]);
  assert.equal(units.length, 1, "only the per-call report became a unit");
});

test("a rollout with no usage at all is reported as such, not as zero spend", () => {
  // The real 0.162.1 case: the turn was refused by a subscription usage limit, so
  // there was nothing to record. Zero here must not read as "this was free".
  const { units, sawUsage } = parseRollout([
    line(META),
    line(TURN),
    line({ type: "event_msg", payload: { type: "token_count", info: null } }),
    line({ type: "event_msg", payload: { type: "task_complete" } }),
  ]);
  assert.equal(units.length, 0);
  assert.equal(sawUsage, false, "the caller has to distinguish 'no records' from 'no spend'");
});

test("a malformed line is skipped rather than losing the whole session", () => {
  const { units } = parseRollout(["not json", "", line(META), line(TURN), line(USAGE_ROW), "{ half a line"]);
  assert.equal(units.length, 1);
});
