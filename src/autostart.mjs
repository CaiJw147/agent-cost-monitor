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

/** Written on install so there is something to edit. */
export const DEFAULT_CONFIG = { backend: "browser", warnPerHour: 15 };

export function mergeConfig(current, patch) {
  const base = current !== null && typeof current === "object" ? current : {};
  return { ...DEFAULT_CONFIG, ...base, ...patch };
}
