// The in-flight-tool flag: what stops a slow command from looking like an ended turn.
//
// Found by probing the real desktop transcript that exposed it. A PowerShell call ran
// from 00:26:10 to 00:27:11, so for 61 seconds the transcript's newest usage-bearing
// entry was the assistant message that *requested* the tool. The window declared the turn
// over after 30 seconds, which froze the clock and zeroed β(t) mid-turn — reported as
// "freezes and reports a wrong number when the agent is stuck on a time-demanding
// powershell command".
import assert from "node:assert/strict";
import test from "node:test";

import { collectUnits } from "../claude/statusline.mjs";

const line = (o) => JSON.stringify(o);
const prompt = { type: "user", timestamp: "2026-10-11T00:14:01.000Z", message: { content: "do the thing" } };
const assistantText = {
  type: "assistant",
  timestamp: "2026-10-11T00:14:25.000Z",
  message: { id: "m1", model: "m", usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: "text", text: "ok" }] },
};
const toolUse = {
  type: "assistant",
  timestamp: "2026-10-11T00:14:26.000Z",
  message: { id: "m2", model: "m", usage: { input_tokens: 200, output_tokens: 20 }, content: [{ type: "tool_use", name: "Bash", input: {} }] },
};
const toolResult = { type: "user", timestamp: "2026-10-11T00:15:27.000Z", message: { content: [{ type: "tool_result", content: "done" }] } };

test("a transcript ending in a tool call is waiting, not finished", () => {
  const r = collectUnits([line(prompt), line(assistantText), line(toolUse)]);
  assert.equal(r.awaitingToolResult, true, "so the clock keeps running while the command does");
  assert.equal(r.lastTurn, 1);
});

test("a tool result clears the wait without opening a turn", () => {
  // The rule that matters: tool results arrive as `user` entries, and treating one as a
  // prompt would reset the turn cost mid-conversation.
  const r = collectUnits([line(prompt), line(assistantText), line(toolUse), line(toolResult)]);
  assert.equal(r.awaitingToolResult, false);
  assert.equal(r.lastTurn, 1, "still one turn, not two");
});

test("a plain assistant reply with no tool call is not waiting", () => {
  assert.equal(collectUnits([line(prompt), line(assistantText)]).awaitingToolResult, false);
});

test("a real prompt clears the wait and opens a turn", () => {
  const second = { type: "user", timestamp: "2026-10-11T00:16:00.000Z", message: { content: "now do this" } };
  const r = collectUnits([line(prompt), line(assistantText), line(toolUse), line(second)]);
  assert.equal(r.awaitingToolResult, false);
  assert.equal(r.lastTurn, 2, "the user did start a new turn");
});

test("a subagent's tool call does not mark the main transcript as waiting", () => {
  // Sidechain entries are another agent's work interleaved into the same file; the main
  // transcript is not blocked on them.
  const sidechain = { ...toolUse, isSidechain: true };
  assert.equal(collectUnits([line(prompt), line(assistantText), line(sidechain)]).awaitingToolResult, false);
});

test("an empty or unparseable transcript is not waiting", () => {
  assert.equal(collectUnits([]).awaitingToolResult, false);
  assert.equal(collectUnits(["not json"]).awaitingToolResult, false);
});
