// The auto-launch shim, which edits a file the user owns and depends on every day.
// A bad block here means `claude` stops starting, so the text handling is tested
// rather than trusted.
import assert from "node:assert/strict";
import test from "node:test";

import {
  MARK_BEGIN,
  MARK_END,
  applyBlock,
  buildShimBlock,
  claudeCommandFile,
  claudeCommandPath,
  configPath,
  hasBlock,
  mergeConfig,
  profilePaths,
  removeBlock,
  shimHosts,
} from "../src/autostart.mjs";

const OPTIONS = { hosts: ["claude", "codex"], acmEntry: "C:\\pkg\\bin\\acm.mjs", nodePath: "C:\\nodejs\\node.exe" };

test("Claude Code is never shimmed, even when a config still asks for it", () => {
  // Its own status line already shows these figures, so wrapping the command would
  // open a window on top of a row that works. Filtering in code rather than only in
  // the defaults means a config written before this decision cannot reintroduce it.
  assert.deepEqual(shimHosts(["claude", "codex"]), ["codex"]);
  assert.deepEqual(shimHosts(["claude"]), [], "asking only for claude shims nothing");
  assert.deepEqual(shimHosts(undefined), ["codex", "dsh-tui"]);
  assert.equal(shimHosts(["claude", "codex", "dsh-tui"]).includes("claude"), false);
});

test("the block is fenced, so it can be found and removed exactly", () => {
  const block = buildShimBlock(OPTIONS);
  assert.ok(block.startsWith(MARK_BEGIN));
  assert.ok(block.trimEnd().endsWith(MARK_END));
  assert.equal(block.split(MARK_BEGIN).length, 2, "one opening fence");
  assert.equal(block.split(MARK_END).length, 2, "one closing fence");
});

test("one function per host, each delegating to the real command with its arguments", () => {
  const block = buildShimBlock(OPTIONS);
  for (const host of OPTIONS.hosts) {
    assert.match(block, new RegExp(`function ${host} \\{`), `${host} is wrapped`);
    assert.match(block, new RegExp(`& \\$real\\.Source @args`), `${host} forwards arguments`);
  }
  // The whole point: PowerShell must not resolve the function as the real command.
  assert.match(block, /-CommandType ExternalScript,Application/);
  assert.doesNotMatch(block, /function claude \{[\s\S]*?\bclaude\b\s*@args/, "no recursion into itself");
});

test("launching is detached, hidden, and cannot block the harness", () => {
  const block = buildShimBlock(OPTIONS);
  assert.match(block, /Start-Process -WindowStyle Hidden/);
  assert.match(block, /'launch', '--quiet'/);
  assert.match(block, /catch \{ \}/, "a window failure must not stop the agent starting");
});

test("backslashes survive into the generated PowerShell", () => {
  const block = buildShimBlock(OPTIONS);
  assert.ok(block.includes("'C:\\pkg\\bin\\acm.mjs'"), "the entry path is written as a quoted literal");
  assert.ok(block.includes("'C:\\nodejs\\node.exe'"));
});

test("a single quote in a path cannot break out of the literal", () => {
  const block = buildShimBlock({ ...OPTIONS, acmEntry: "C:\\it's here\\acm.mjs" });
  assert.ok(block.includes("'C:\\it''s here\\acm.mjs'"), "doubled, not escaped into a syntax error");
});

test("installing twice leaves exactly one block", () => {
  const block = buildShimBlock(OPTIONS);
  const once = applyBlock("# my profile\nSet-Alias ll Get-ChildItem\n", block);
  const twice = applyBlock(once, block);
  assert.equal(twice.split(MARK_BEGIN).length, 2, "still one block");
  assert.ok(twice.includes("Set-Alias ll Get-ChildItem"), "and the user's own lines are untouched");
});

test("a second install replaces the old paths instead of stacking a stale one", () => {
  const first = applyBlock("", buildShimBlock({ ...OPTIONS, acmEntry: "C:\\old\\acm.mjs" }));
  const second = applyBlock(first, buildShimBlock(OPTIONS));
  assert.ok(second.includes("C:\\pkg\\bin\\acm.mjs"));
  assert.ok(!second.includes("C:\\old\\acm.mjs"), "the stale path is gone, not duplicated");
});

test("it appends to an existing profile without gluing onto the last line", () => {
  const withoutNewline = applyBlock("# no trailing newline", buildShimBlock(OPTIONS));
  assert.match(withoutNewline, /# no trailing newline\n/, "a newline is inserted");
  assert.equal(withoutNewline.split(MARK_BEGIN).length, 2);
});

test("uninstall removes our block and nothing else", () => {
  const before = "# before\nSet-Alias ll Get-ChildItem\n";
  const after = "# after\n$PSDefaultParameterValues = @{}\n";
  const installed = applyBlock(before, buildShimBlock(OPTIONS)) + after;
  const { text, removed } = removeBlock(installed);
  assert.equal(removed, true);
  assert.ok(text.includes("# before"));
  assert.ok(text.includes("Set-Alias ll Get-ChildItem"));
  assert.ok(text.includes("# after"));
  assert.ok(!text.includes(MARK_BEGIN), "no fence left behind");
  assert.ok(!text.includes("__acm-start"), "no orphaned helper function");
});

test("uninstalling when nothing was installed is a no-op", () => {
  const { text, removed } = removeBlock("# someone else's profile\n");
  assert.equal(removed, false);
  assert.equal(text, "# someone else's profile\n");
  assert.equal(removeBlock(undefined).removed, false, "a missing profile is not an error");
});

test("hasBlock is false for a profile that merely mentions us", () => {
  assert.equal(hasBlock("# I read about agent-cost-monitor once"), false);
  assert.equal(hasBlock(`${MARK_BEGIN}\n...\n`), false, "both fences are required");
  assert.equal(hasBlock(undefined), false);
});

test("both PowerShell profiles are covered, because they are different files", () => {
  const paths = profilePaths("C:\\Users\\me");
  assert.equal(paths.length, 2);
  assert.ok(paths[0].includes("WindowsPowerShell"), "Windows PowerShell 5.1");
  assert.ok(paths[1].includes("PowerShell"), "PowerShell 7");
  assert.notEqual(paths[0], paths[1]);
});

test("the /acm command is an instruction, not a version-specific shell expansion", () => {
  const body = claudeCommandFile();
  assert.match(body, /^---\ndescription: /);
  assert.match(body, /acm launch/);
  assert.doesNotMatch(body, /!`/, "no reliance on ! expansion, which varies by version");
  assert.equal(claudeCommandPath("C:\\Users\\me"), "C:\\Users\\me\\.claude\\commands\\acm.md");
});

test("config defaults survive a partial patch, and a corrupt file is replaced", () => {
  assert.equal(mergeConfig(undefined, {}).autoLaunch, true, "auto-launch is on by default");
  assert.deepEqual(mergeConfig({ hosts: ["claude"] }, {}).hosts, ["claude"], "the user's list is kept");
  assert.equal(mergeConfig({ autoLaunch: false }, {}).autoLaunch, false);
  assert.equal(mergeConfig({ autoLaunch: true }, { autoLaunch: false }).autoLaunch, false);
  assert.equal(mergeConfig("not an object", {}).autoLaunch, true);
  assert.equal(configPath("C:\\Users\\me"), "C:\\Users\\me\\.agent-cost-monitor.json");
});
