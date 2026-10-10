// The installer's decisions.
//
// The I/O lives in bin/acm.mjs; what is tested here is the part that can quietly
// destroy someone's configuration — merging a status line into a file full of
// their own settings, and taking it back out again without disturbing the rest.
import assert from "node:assert/strict";
import test from "node:test";

import { describeHosts, isOurStatusLine, ourStatusLine, planClaudeInstall, planClaudeUninstall, pluginSpec, toPosix } from "../src/install.mjs";

const SCRIPT = "D:\\Dev\\deepseek\\plugindev\\agent-cost-monitor\\claude\\statusline.mjs";

test("the Windows path is written with forward slashes, because Git Bash eats backslashes", () => {
  const sl = ourStatusLine(SCRIPT);
  assert.equal(sl.command, 'node "D:/Dev/deepseek/plugindev/agent-cost-monitor/claude/statusline.mjs"');
  assert.doesNotMatch(sl.command, /\\/, "a backslash here fails silently under Git Bash");
  assert.equal(toPosix("a\\b\\c"), "a/b/c");
});

test("the block carries the timer, without which the live rate goes stale", () => {
  const sl = ourStatusLine(SCRIPT);
  assert.equal(sl.type, "command");
  assert.equal(sl.padding, 0);
  assert.equal(sl.refreshInterval, 10, "the default triggers are event-driven; beta(t) is a 15-second window");
});

test("installing into a file full of someone else's settings changes exactly one key", () => {
  const before = { env: { A: "1" }, model: "opus", effortLevel: "high", enabledPlugins: { x: true } };
  const plan = planClaudeInstall(before, SCRIPT);
  assert.equal(plan.action, "install");
  assert.deepEqual(Object.keys(plan.settings).sort(), ["effortLevel", "enabledPlugins", "env", "model", "statusLine"]);
  // The original object is not mutated: a dry run must be able to abandon the plan.
  assert.equal(before.statusLine, undefined);
  assert.deepEqual(plan.settings.env, { A: "1" });
});

test("running it twice changes nothing the second time", () => {
  const once = planClaudeInstall({}, SCRIPT);
  const twice = planClaudeInstall(once.settings, SCRIPT);
  assert.equal(twice.action, "unchanged");
  assert.equal(twice.settings, once.settings, "the same object, so nothing is rewritten");
});

test("a moved checkout is a repair, not a conflict", () => {
  // This is the whole reason the path is stored in the settings file: when the
  // repository moves, the installed command is ours but points at nothing.
  const old = planClaudeInstall({}, "D:\\old\\place\\agent-cost-monitor\\claude\\statusline.mjs").settings;
  const seen = planClaudeInstall(old, SCRIPT);
  assert.equal(seen.action, "replace");
  assert.equal(seen.settings.statusLine.command, ourStatusLine(SCRIPT).command);
  assert.match(seen.message, /path had changed/);
});

test("a status line belonging to someone else is not clobbered without --force", () => {
  const theirs = { statusLine: { type: "command", command: "~/.claude/my-own.sh" } };
  const refused = planClaudeInstall(theirs, SCRIPT);
  assert.equal(refused.action, "conflict");
  assert.deepEqual(refused.settings, theirs, "their settings are returned untouched");
  assert.match(refused.message, /--force/);

  const forced = planClaudeInstall(theirs, SCRIPT, { force: true });
  assert.equal(forced.action, "replace");
  assert.ok(isOurStatusLine(forced.settings.statusLine));
});

test("uninstalling removes our key and nothing else", () => {
  const installed = planClaudeInstall({ env: { A: "1" }, model: "opus" }, SCRIPT).settings;
  const plan = planClaudeUninstall(installed);
  assert.equal(plan.action, "uninstall");
  assert.deepEqual(plan.settings, { env: { A: "1" }, model: "opus" });
});

test("uninstalling something we did not install is a no-op, not a deletion", () => {
  const theirs = { statusLine: { type: "command", command: "~/.claude/my-own.sh" } };
  const plan = planClaudeUninstall(theirs);
  assert.equal(plan.action, "unchanged");
  assert.deepEqual(plan.settings, theirs, "their status line survives our uninstall");
});

test("the plugin is linked by local path, not published name", () => {
  assert.equal(pluginSpec("D:\\Dev\\deepseek\\plugindev\\dsh-budget-watcher"), "link:D:/Dev/deepseek/plugindev/dsh-budget-watcher");
});

test("the summary is honest about what dsh-tui does not yet have", () => {
  const text = describeHosts({
    claude: { detected: true, status: "configured", detail: "statusLine -> node ..." },
    dsh: { detected: true, status: 'not installed in profile "dsh-tui"', detail: "profile C:/x" },
    codex: { detected: true, status: "unsupported" },
  });
  assert.match(text, /claude code\s+detected: yes/);
  assert.match(text, /dsh-tui\s+detected: yes/);
  assert.match(text, /codex\s+detected: yes\s+not supported yet/);
});
