// The parts of shell integration that remain, and the cleanup of what does not.
//
// Auto-launch was withdrawn, so the tests for writing a shim block are gone with it.
// What is left still edits a file the user owns — removing a block an older version
// wrote — so that text handling keeps its tests.
import assert from "node:assert/strict";
import test from "node:test";

import {
  MARK_BEGIN,
  MARK_END,
  DEFAULT_CONFIG,
  claudeCommandFile,
  claudeCommandPath,
  configPath,
  hasBlock,
  mergeConfig,
  profilePaths,
  removeBlock,
} from "../src/autostart.mjs";

test("both PowerShell profiles are covered, because they are different files", () => {
  const paths = profilePaths("C:\\Users\\me");
  assert.equal(paths.length, 2);
  assert.ok(paths[0].includes("WindowsPowerShell"), "Windows PowerShell 5.1");
  assert.ok(paths[1].includes("PowerShell"), "PowerShell 7");
  assert.notEqual(paths[0], paths[1]);
});

test("hasBlock is false for a profile that merely mentions us", () => {
  assert.equal(hasBlock("# I read about agent-cost-monitor once"), false);
  assert.equal(hasBlock(`${MARK_BEGIN}\n...\n`), false, "both fences are required");
  assert.equal(hasBlock(`${MARK_BEGIN}\n...\n${MARK_END}\n`), true);
  assert.equal(hasBlock(undefined), false);
});

test("cleanup removes a block an older version wrote, and nothing else", () => {
  // The block a 0.4/0.5 install left behind, with the user's own lines around it —
  // this is the exact shape being removed on machines that ran auto-launch.
  const profile = [
    "# my own profile",
    "Set-Alias ll Get-ChildItem",
    "",
    MARK_BEGIN,
    "# Added by `acm autostart on`.",
    "function __acm-start { }",
    "function codex { __acm-start; & $real.Source @args }",
    MARK_END,
    "",
    "$PSDefaultParameterValues = @{}",
    "",
  ].join("\n");

  const { text, removed } = removeBlock(profile);
  assert.equal(removed, true);
  assert.ok(text.includes("# my own profile"));
  assert.ok(text.includes("Set-Alias ll Get-ChildItem"));
  assert.ok(text.includes("$PSDefaultParameterValues = @{}"));
  assert.ok(!text.includes(MARK_BEGIN), "no fence left behind");
  assert.ok(!text.includes("__acm-start"), "no orphaned helper function");
  assert.ok(!text.includes("function codex"), "and no wrapper that would shadow the real codex");
});

test("cleanup on a profile that never had the block is a no-op", () => {
  const { text, removed } = removeBlock("# someone else's profile\n");
  assert.equal(removed, false);
  assert.equal(text, "# someone else's profile\n");
  assert.equal(removeBlock(undefined).removed, false, "a missing profile is not an error");
});

test("the /acm command is an instruction, not a version-specific shell expansion", () => {
  const body = claudeCommandFile();
  assert.match(body, /^---\ndescription: /);
  assert.match(body, /acm launch/);
  assert.match(body, /--host codex/, "the host flag is documented where it is reachable");
  assert.doesNotMatch(body, /!`/, "no reliance on ! expansion, which varies by version");
  assert.equal(claudeCommandPath("C:\\Users\\me"), "C:\\Users\\me\\.claude\\commands\\acm.md");
});

test("the config keeps a user's values and fills in defaults for the rest", () => {
  assert.deepEqual(mergeConfig(undefined, {}), DEFAULT_CONFIG, "a fresh install gets defaults");
  assert.equal(DEFAULT_CONFIG.warnPerHour, 15);
  assert.equal(mergeConfig({ warnPerHour: 40 }, {}).warnPerHour, 40, "the user's value survives");
  assert.equal(mergeConfig({ backend: "tauri" }, {}).backend, "tauri");
  assert.equal(mergeConfig({ warnPerHour: 40 }, { backend: "tauri" }).warnPerHour, 40, "a patch does not wipe it");
  assert.equal(mergeConfig("not an object", {}).warnPerHour, 15, "a corrupt file is replaced, not obeyed");
  assert.equal(configPath("C:\\Users\\me"), "C:\\Users\\me\\.agent-cost-monitor.json");
});
