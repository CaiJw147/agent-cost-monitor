// The parts of shell integration that remain, and the cleanup of what does not.
//
// Auto-launch was withdrawn, so the tests for writing a shim block are gone with it.
// What is left still edits a file the user owns — removing a block an older version
// wrote — so that text handling keeps its tests.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  resolveConfig,
} from "../src/autostart.mjs";

/** A throwaway home directory holding a config file, for the precedence tests. */
function homeWith(config) {
  const home = mkdtempSync(join(tmpdir(), "acm-test-"));
  if (config !== undefined) writeFileSync(join(home, ".agent-cost-monitor.json"), typeof config === "string" ? config : JSON.stringify(config));
  return home;
}

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

// --- the geometry, which is what the window is placed from ------------------

test("with no config file the window uses the documented defaults", () => {
  const cfg = resolveConfig(homeWith(undefined), {});
  assert.deepEqual(
    { w: cfg.width, h: cfg.height, x: cfg.x, y: cfg.y, port: cfg.port, backend: cfg.backend, onTop: cfg.alwaysOnTop, burn: cfg.burnWindowMs },
    { w: 225, h: 300, x: 40, y: 80, port: 7420, backend: "browser", onTop: true, burn: 15_000 },
  );
  assert.equal(cfg.currency, "CNY");
});

test("the burn window is configurable, and has a floor a rate cannot go below", () => {
  assert.equal(resolveConfig(homeWith({ burnWindowMs: 60_000 }), {}).burnWindowMs, 60_000);
  assert.equal(resolveConfig(homeWith({}), { ACM_BURN_WINDOW_MS: "30000" }).burnWindowMs, 30_000);
  // Below a second it stops measuring a rate and starts reporting whichever single
  // call happened to land inside the window.
  assert.equal(resolveConfig(homeWith({ burnWindowMs: 50 }), {}).burnWindowMs, 1000);
  assert.equal(resolveConfig(homeWith({ burnWindowMs: "nonsense" }), {}).burnWindowMs, 15_000);
});

test("the config file moves the window, and an env var beats the file", () => {
  const home = homeWith({ windowWidth: 520, windowHeight: 300, windowX: 900, windowY: 12, port: 7500 });
  const fromFile = resolveConfig(home, {});
  assert.deepEqual([fromFile.width, fromFile.height, fromFile.x, fromFile.y, fromFile.port], [520, 300, 900, 12, 7500]);

  // Env wins because it is the per-invocation override, and because every one of these
  // variables existed before the config file did.
  const fromEnv = resolveConfig(home, { ACM_WINDOW_WIDTH: "640", ACM_WINDOW_PORT: "7600" });
  assert.equal(fromEnv.width, 640);
  assert.equal(fromEnv.port, 7600);
  assert.equal(fromEnv.height, 300, "and the values it does not set still come from the file");
});

test("a nonsense size cannot produce a window that does not exist", () => {
  // A zero or negative size, a string, or a missing key all fall back rather than
  // handing the browser `--window-size=0,0` and producing an invisible window.
  // Asserted against DEFAULT_CONFIG, not a literal: a default that moves should not
  // need two more edits, and forgetting them is how this test failed once already.
  const cfg = resolveConfig(homeWith({ windowWidth: 0, windowHeight: -5, port: "abc" }), { ACM_WINDOW_HEIGHT: "nonsense" });
  assert.equal(cfg.width, DEFAULT_CONFIG.windowWidth);
  assert.equal(cfg.height, DEFAULT_CONFIG.windowHeight);
  assert.equal(cfg.port, DEFAULT_CONFIG.port);
});

test("a corrupt config file falls back to defaults instead of failing the launch", () => {
  const cfg = resolveConfig(homeWith("{ this is not json"), {});
  assert.equal(cfg.width, DEFAULT_CONFIG.windowWidth);
  assert.equal(cfg.backend, DEFAULT_CONFIG.backend);
});

test("always-on-top can be turned off, and only an explicit false does it", () => {
  assert.equal(resolveConfig(homeWith({ alwaysOnTop: false }), {}).alwaysOnTop, false);
  assert.equal(resolveConfig(homeWith({}), { ACM_ALWAYS_ON_TOP: "0" }).alwaysOnTop, false);
  assert.equal(resolveConfig(homeWith({ alwaysOnTop: false }), { ACM_ALWAYS_ON_TOP: "1" }).alwaysOnTop, true);
  assert.equal(resolveConfig(homeWith({}), {}).alwaysOnTop, true, "and it is on by default");
});

test("currency is normalised to the two the engine prices in", () => {
  assert.equal(resolveConfig(homeWith({}), { SPEND_WATCH_CURRENCY: "usd" }).currency, "USD");
  assert.equal(resolveConfig(homeWith({}), { SPEND_WATCH_CURRENCY: "eur" }).currency, "CNY", "anything else is CNY, not a third currency");
});
