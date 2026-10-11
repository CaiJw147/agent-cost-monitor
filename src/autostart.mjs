// Shell integration beyond the status line.
//
// Auto-launch was withdrawn: wrapping `codex` or `dsh-tui` in a PowerShell function
// meant editing two profile files to save the user one command, and the window it
// started was showing another host's numbers half the time. What remains here is
// what is still wanted:
//
//   * `/acm` — a slash command that starts the window on request;
//   * the configuration file;
//   * the ability to REMOVE a shim block written by an earlier version, because a
//     feature that has been withdrawn still has to be cleanly reversible on machines
//     that ran it. Nothing in this file writes one any more.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The fences an older version wrote around its block. Kept for removal only. */
export const MARK_BEGIN = "# >>> agent-cost-monitor >>>";
export const MARK_END = "# <<< agent-cost-monitor <<<";

/**
 * Both profile files.
 *
 * PowerShell 5.1 and PowerShell 7 keep separate ones, and which one a terminal
 * starts is not ours to assume — a cleanup that missed half the install would be
 * worse than no cleanup.
 */
export function profilePaths(home) {
  return [
    join(home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
    join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
  ];
}

export const configPath = (home) => join(home, ".agent-cost-monitor.json");

export const hasBlock = (text) => typeof text === "string" && text.includes(MARK_BEGIN) && text.includes(MARK_END);

/**
 * Remove a block an earlier version wrote, and nothing else.
 *
 * Every other line stays as it was: this edits a file the user owns and depends on
 * every day, so the failure mode to avoid is a cleanup that takes a profile with it.
 */
export function removeBlock(text) {
  if (!hasBlock(text)) return { text: typeof text === "string" ? text : "", removed: false };
  const start = text.indexOf(MARK_BEGIN);
  const end = text.indexOf(MARK_END) + MARK_END.length;
  let next = text.slice(0, start) + text.slice(end);
  next = next.replace(/^\n{2,}/, "\n").replace(/\n{3,}/g, "\n\n");
  return { text: next, removed: true };
}

/**
 * The `/acm` command, for the harness whose slash commands are extensible.
 *
 * The body is a plain instruction rather than a `!` shell expansion: how a slash
 * command executes shell text has varied across Claude Code versions, and an
 * instruction to run one command works either way.
 */
export function claudeCommandFile() {
  return [
    "---",
    "description: Start the agent-cost-monitor spend window",
    "---",
    "Start the spend window by running this, then tell me the URL it prints:",
    "",
    "    acm launch",
    "",
    "If the window should follow a particular host, say which:",
    "",
    "    acm launch --host codex",
    "",
  ].join("\n");
}

export const claudeCommandPath = (home) => join(home, ".claude", "commands", "acm.md");

/**
 * Written on install so there is something to edit.
 *
 * Flat rather than nested: a shallow merge over a nested `window` object would let a
 * one-key override silently drop the rest of the geometry, which is exactly the kind of
 * bug a settings file should not be able to cause.
 */
export const DEFAULT_CONFIG = {
  backend: "browser",
  warnPerHour: 15,
  windowWidth: 225,
  windowHeight: 300,
  windowX: 40,
  windowY: 80,
  alwaysOnTop: true,
  burnWindowMs: 15_000,
  port: 7420,
};

export function mergeConfig(current, patch) {
  const base = current !== null && typeof current === "object" ? current : {};
  return { ...DEFAULT_CONFIG, ...base, ...patch };
}

/** The config file as written, or an empty object if it is missing or broken. */
export function readConfigFile(home) {
  try {
    const parsed = JSON.parse(readFileSync(configPath(home), "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const positive = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
};

/**
 * The burn window has a floor, where the geometry does not.
 *
 * A one-second window is not a smaller measurement of the same thing — it is a
 * reading of whichever single call happened to land inside it, which is noise dressed
 * as a rate. A second is the floor; the DSH plugin uses five for the same setting.
 */
const MIN_BURN_WINDOW_MS = 1000;

/**
 * The whole precedence in one place: defaults, then the config file, then the
 * environment. The environment wins because it is the per-invocation override, and
 * because every variable here already existed before the file did.
 *
 * `burnWindowMs` keeps the DSH plugin's name for the same setting on purpose: the two
 * tools are configured by the same person, and two names for one idea is a tax.
 */
export function resolveConfig(home, env = process.env) {
  const merged = mergeConfig(readConfigFile(home), {});
  const burnWindow = positive(env.ACM_BURN_WINDOW_MS, positive(merged.burnWindowMs, DEFAULT_CONFIG.burnWindowMs));
  return {
    backend: env.ACM_WINDOW_BACKEND ?? merged.backend,
    warnPerHour: Number.isFinite(Number(env.ACM_WARN_PER_HOUR)) ? Number(env.ACM_WARN_PER_HOUR) : Number(merged.warnPerHour),
    currency: (env.SPEND_WATCH_CURRENCY ?? "CNY").toUpperCase() === "USD" ? "USD" : "CNY",
    port: positive(env.ACM_WINDOW_PORT, positive(merged.port, DEFAULT_CONFIG.port)),
    width: positive(env.ACM_WINDOW_WIDTH, positive(merged.windowWidth, DEFAULT_CONFIG.windowWidth)),
    height: positive(env.ACM_WINDOW_HEIGHT, positive(merged.windowHeight, DEFAULT_CONFIG.windowHeight)),
    x: positive(env.ACM_WINDOW_X, positive(merged.windowX, DEFAULT_CONFIG.windowX)),
    y: positive(env.ACM_WINDOW_Y, positive(merged.windowY, DEFAULT_CONFIG.windowY)),
    alwaysOnTop: env.ACM_ALWAYS_ON_TOP === undefined ? merged.alwaysOnTop !== false : env.ACM_ALWAYS_ON_TOP !== "0",
    burnWindowMs: Math.max(MIN_BURN_WINDOW_MS, burnWindow),
  };
}
