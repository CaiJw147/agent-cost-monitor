// The session-start hooks, and the dangerous edges of editing a TOML file someone
// depends on. Every case here is one that would be expensive to discover in the wild:
// a duplicate `[features]` table makes Codex's whole config unparseable.
import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_TRUST_NOTE,
  MARK_BEGIN,
  MARK_END,
  claudeHookEntry,
  codexHookBlock,
  hasBlock,
  planClaudeHookInstall,
  planClaudeHookRemove,
  planCodexHookInstall,
  planCodexHookRemove,
} from "../src/hooks.mjs";

// --- Claude Code ------------------------------------------------------------

test("the Claude hook is scoped to startup, not to every session event", () => {
  const entry = claudeHookEntry("claude");
  assert.equal(entry.matcher, "startup", "a resume or a compact is not a new session");
  assert.deepEqual(entry.hooks, [{ type: "command", command: "acm launch --host claude" }]);
});

test("installing into an empty settings file creates only what is needed", () => {
  const { settings, changed } = planClaudeHookInstall({}, "claude");
  assert.equal(changed, true);
  assert.deepEqual(settings.hooks.SessionStart, [claudeHookEntry("claude")]);
  assert.deepEqual(Object.keys(settings), ["hooks"], "nothing else is invented");
});

test("installing twice does not add a second hook", () => {
  const first = planClaudeHookInstall({}, "claude").settings;
  const second = planClaudeHookInstall(first, "claude");
  assert.equal(second.changed, false);
  assert.equal(second.settings.hooks.SessionStart.length, 1);
});

test("installing leaves another tool's hooks exactly as they were", () => {
  // a4phone's three hooks live in this same object. Losing them would be a real loss.
  const before = {
    env: { KEEP: "me" },
    hooks: {
      Stop: [{ matcher: "*", hooks: [{ type: "command", command: "a4p hook", }] }],
      PreToolUse: [{ matcher: "AskUserQuestion", hooks: [{ type: "command", command: "a4p hook" }] }],
    },
  };
  const { settings } = planClaudeHookInstall(before, "claude");
  assert.deepEqual(settings.hooks.Stop, before.hooks.Stop);
  assert.deepEqual(settings.hooks.PreToolUse, before.hooks.PreToolUse);
  assert.deepEqual(settings.env, { KEEP: "me" });
  assert.deepEqual(before.hooks.SessionStart, undefined, "and the input is not mutated");
});

test("removing takes our hook out and leaves the others in place", () => {
  const withOurs = planClaudeHookInstall(
    { hooks: { Stop: [{ matcher: "*", hooks: [{ type: "command", command: "a4p hook" }] }] } },
    "claude",
  ).settings;
  const { settings, changed } = planClaudeHookRemove(withOurs);
  assert.equal(changed, true);
  assert.equal(settings.hooks.SessionStart, undefined, "the now-empty event is removed");
  assert.deepEqual(settings.hooks.Stop, [{ matcher: "*", hooks: [{ type: "command", command: "a4p hook" }] }]);
});

test("removing ours does not remove the hooks object while another tool uses it", () => {
  const settings = { hooks: { Stop: [{ hooks: [{ type: "command", command: "a4p hook" }] }], SessionStart: [claudeHookEntry("claude")] } };
  const { settings: next } = planClaudeHookRemove(settings);
  assert.ok(next.hooks, "`hooks` stays, because Stop is still in it");
  assert.equal(next.hooks.SessionStart, undefined);
});

test("removing from a file that never had our hook changes nothing", () => {
  const before = { hooks: { Stop: [{ hooks: [{ type: "command", command: "a4p hook" }] }] } };
  const { settings, changed } = planClaudeHookRemove(before);
  assert.equal(changed, false);
  assert.deepEqual(settings, before);
});

// --- Codex -----------------------------------------------------------------

const CODEX_PLAIN = 'model = "gpt-6-sol"\n\n[tui]\nscreen_reader_detection_done = true\n';

test("the Codex block is fenced, so it can be found and removed exactly", () => {
  const block = codexHookBlock("codex");
  assert.ok(block.startsWith(MARK_BEGIN));
  assert.ok(block.endsWith(MARK_END));
  assert.match(block, /\[\[hooks\.SessionStart\]\]/);
  assert.match(block, /\[\[hooks\.SessionStart\.hooks\]\]/);
  assert.match(block, /command = "acm launch --host codex"/);
  assert.equal(hasBlock(block), true);
});

test("installing into a config with no [features] table appends one", () => {
  const { text, changed, note } = planCodexHookInstall(CODEX_PLAIN, "codex");
  assert.equal(changed, true);
  assert.match(text, /\[features\]\nhooks = true/);
  assert.equal(hasBlock(text), true);
  assert.equal(note, CODEX_TRUST_NOTE, "and the trust requirement is reported, not hidden");
});

test("THE DANGEROUS ONE: an existing [features] table is edited, never duplicated", () => {
  // TOML forbids redefining a table, so a second `[features]` would make Codex's whole
  // config unparseable. This is the difference between a working tool and a broken one.
  const withFeatures = 'model = "x"\n\n[features]\nhooks = true\nother = 1\n\n[tui]\ny = 2\n';
  const { text, changed } = planCodexHookInstall(withFeatures, "codex");
  assert.equal(changed, true, "our hook is still added");
  assert.equal(text.match(/^\[features\]$/gm).length, 1, "exactly one [features] table");
  assert.equal(text.match(/^hooks = true$/gm).length, 1, "and one hooks key inside it");
});

test("a [features] table without hooks gets the key inserted into that table, not after it", () => {
  const text = 'a = 1\n\n[features]\nother = 1\n\n[tui]\ny = 2\n';
  const { text: next } = planCodexHookInstall(text, "codex");
  const featuresBody = next.split("[features]")[1].split(/\n(?=\[)/)[0];
  assert.match(featuresBody, /hooks = true/, "the key lands in the [features] body");
  assert.equal(next.match(/^\[features\]$/gm).length, 1);
  assert.match(next, /\[tui\]\ny = 2/, "and the rest of the file is untouched");
});

test("a hooks key in a DIFFERENT table does not count as enabled", () => {
  // `hooks = true` inside [tui] is not the feature flag; treating it as one would leave
  // the hook silently dead.
  const text = 'a = 1\n\n[tui]\nhooks = true\n';
  const { text: next } = planCodexHookInstall(text, "codex");
  assert.match(next.split("[features]")[1].split(/\n(?=\[)/)[0], /hooks = true/);
  assert.equal(next.match(/^\[features\]$/gm).length, 1);
});

test("installing twice does not stack a second block", () => {
  const first = planCodexHookInstall(CODEX_PLAIN, "codex").text;
  const second = planCodexHookInstall(first, "codex");
  assert.equal(second.changed, false);
  assert.equal(second.text.match(/\[\[hooks\.SessionStart\]\]/g).length, 1);
});

test("changing the host corrects the block instead of adding another", () => {
  const first = planCodexHookInstall(CODEX_PLAIN, "codex").text;
  const second = planCodexHookInstall(first, "dsh");
  assert.equal(second.changed, true);
  assert.match(second.text, /acm launch --host dsh/);
  assert.equal(second.text.includes("--host codex"), false);
  assert.equal(second.text.match(/\[\[hooks\.SessionStart\]\]/g).length, 1);
});

test("the file a4phone writes round-trips byte for byte", () => {
  // The realistic shape on this machine: a fenced block from another tool, `[features]`
  // already correct, and tables after it. Install then remove must restore the original
  // exactly, because that file is the user's working Codex configuration.
  const real = [
    'model = "gpt-6-sol"',
    "",
    "[tui]",
    "screen_reader_detection_done = true",
    "# ===== a4phone hooks (auto-generated) =====",
    "[features]",
    "hooks = true",
    "",
    "[[hooks.Stop]]",
    "[[hooks.Stop.hooks]]",
    "type = \"command\"",
    'command = "a4p hook codex"',
    "# ===== end a4phone hooks =====",
    "",
  ].join("\n");

  const installed = planCodexHookInstall(real, "codex").text;
  assert.equal(installed.match(/\[features\]/g).length, 1, "no duplicate table");
  assert.match(installed, /a4p hook codex/, "the other tool's hook survives");
  const removed = planCodexHookRemove(installed).text;
  assert.equal(removed, real, "and removal restores it byte for byte");
});

test("a file with trailing blank lines, a blank-line run, and CRLF also restores exactly", () => {
  // The first version of this only round-tripped a tidy file: it stripped trailing
  // whitespace on install and collapsed blank-line runs on removal, so the file came
  // back approximate. Against the real config.toml that showed up as a mismatch, which
  // is the whole reason this case exists.
  const messy = ['a = 1', '', '', '[tui]', 'y = 2', '', ''].join("\r\n");
  const installed = planCodexHookInstall(messy, "codex").text;
  assert.match(installed, /\[features\]/, "the feature flag is added");
  assert.match(installed, /\r\n# >>> agent-cost-monitor >>>/, "the fence uses the file's own EOL, not a stray LF");
  const removed = planCodexHookRemove(installed);
  assert.equal(removed.exact, true, "removal matched the exact append");
  assert.equal(removed.text.replace(/\r\n\[features\]\r\nhooks = true\r\n$/, ""), messy, "and the original comes back untouched");
});

test("the append and the removal are inverses for an arbitrary file", () => {
  for (const body of ["a = 1\n", "a = 1", "a = 1\n\n\n", 'x = "1"\r\n\r\n[t]\r\ny = 2\r\n']) {
    const removed = planCodexHookRemove(planCodexHookInstall(body, "codex").text);
    assert.equal(removed.exact, true, "the exact append was matched");
    assert.ok(removed.text.startsWith(body), `the original must be an untouched prefix: ${JSON.stringify(body)}`);
    // The only permitted residue is the feature flag, which this file did not have and
    // which removal leaves on purpose.
    assert.match(
      removed.text.slice(body.length),
      /^(\r?\n)*\[features\]\r?\nhooks = true\r?\n?$/,
      `only the feature flag may remain: ${JSON.stringify(removed.text.slice(body.length))}`,
    );
  }
});

test("removing from a config without our block changes nothing", () => {
  const { text, changed } = planCodexHookRemove(CODEX_PLAIN);
  assert.equal(changed, false);
  assert.equal(text, CODEX_PLAIN);
});
