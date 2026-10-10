// The Claude Code status line's adapter, which is the part a host-specific
// integration gets wrong: usage bucket mapping, turn boundaries, and the
// de-duplication that stops one API response being billed twice.
import assert from "node:assert/strict";
import test from "node:test";

import { collectUnits, renderLine } from "../claude/statusline.mjs";

const at = (ms) => new Date(ms).toISOString();
/** One assistant transcript line. Each call gets its own message id unless told otherwise. */
const assistant = (ms, { id = `msg_${ms}`, model = "glm-5.3-flash", inputTokens = 1_000_000, sidechain = false } = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at(ms),
    isSidechain: sidechain,
    message: { id, model, usage: { input_tokens: inputTokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
const userPrompt = (ms) => JSON.stringify({ type: "user", timestamp: at(ms), isSidechain: false, message: { content: "run the tests" } });
const toolResult = (ms) => JSON.stringify({ type: "user", timestamp: at(ms), isSidechain: false, message: { content: [{ type: "tool_result", content: "ok" }] } });

const pricedAt = (perMillion) => () => ({ cacheHit: 0, cacheMiss: perMillion, output: 0, source: "test" });
const unit = (turn, time, inputTokens = 1_000_000, model = "glm-5.3-flash") => ({
  turn,
  time,
  model,
  sidechain: false,
  usage: { inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
});

test("usage maps from Claude Code's snake_case onto the engine's buckets", () => {
  const { units } = collectUnits([assistant(1000)]);
  assert.equal(units.length, 1);
  assert.deepEqual(units[0].usage, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.equal(units[0].model, "glm-5.3-flash");
});

test("a real prompt opens a turn; a tool result does not", () => {
  const { units, lastTurn } = collectUnits([
    userPrompt(1000),
    assistant(2000, { id: "a" }),
    toolResult(3000),
    assistant(4000, { id: "b" }),
    userPrompt(5000),
    assistant(6000, { id: "c" }),
  ]);
  assert.equal(lastTurn, 2, "three user entries, of which two are prompts");
  assert.equal(units.find((u) => u.time === 2000)?.turn, 1);
  assert.equal(units.find((u) => u.time === 4000)?.turn, 1, "the tool result did not split the turn");
  assert.equal(units.find((u) => u.time === 6000)?.turn, 2);
});

test("a repeated message.id is billed once, not twice", () => {
  const identical = collectUnits([assistant(1000, { id: "m" }), assistant(1500, { id: "m" })]);
  assert.equal(identical.units.length, 1, "the same response logged twice collapses to one");

  // A partial re-log must not shrink the bill: the fuller of the two wins.
  const partial = collectUnits([assistant(1000, { id: "m" }), assistant(1500, { id: "m", inputTokens: 10 })]);
  assert.equal(partial.units.length, 1);
  assert.equal(partial.units[0].usage.inputTokens, 1_000_000);
});

test("an assistant entry without usage is skipped, and sidechains are kept", () => {
  const noUsage = JSON.stringify({ type: "assistant", timestamp: at(1000), message: { id: "msg_2", model: "glm-5.3-flash" } });
  const { units } = collectUnits([noUsage, assistant(2000, { id: "msg_3", sidechain: true, inputTokens: 1 })]);
  assert.equal(units.length, 1, "no usage means nothing to bill");
  assert.equal(units[0].sidechain, true, "a subagent's spend is still spend");
});

test("the line renders turn / session, both burns and the turn's clock", () => {
  const now = 10_000_000;
  const units = [unit(1, now - 120_000), unit(1, now - 60_000)];
  // Both units are older than the 15 s window, so the live rate is zero; the
  // turn spans 60 s of activity and cost 2.00, which is 120.00 per hour.
  assert.equal(
    renderLine({ units, now, usdToCny: 7, lookup: pricedAt(1) }),
    "\u00a52.00 / \u00a52.00 \u00b7 \u03b2(t) \u00a50.00/h \u00b7 \u03b2 \u00a5120.00/h \u00b7 1:00",
  );
});

test("a live turn keeps running its clock; a quiet one freezes where it stopped", () => {
  const live = [unit(1, 10_000_000 - 5_000)];
  // Last activity 5 s ago is within the idle window, so the clock runs to `now`
  // and 1.00 over 5 s is 720.00 per hour.
  assert.match(renderLine({ units: live, now: 10_000_000, usdToCny: 7, lookup: pricedAt(1) }), /\u03b2 \u00a5720\.00\/h \u00b7 0:05/);

  // Quiet for two minutes: frozen at the last activity — two units a minute
  // apart, 2.00 over 60 s — rather than running on to now.
  const quiet = [unit(1, 10_000_000 - 120_000), unit(1, 10_000_000 - 60_000)];
  assert.match(renderLine({ units: quiet, now: 10_000_000, usdToCny: 7, lookup: pricedAt(1) }), /\u03b2 \u00a5120\.00\/h \u00b7 1:00/);
});
