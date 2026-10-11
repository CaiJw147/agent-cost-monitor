// Auto-launch: make typing `claude` or `codex` bring the window up with it.
//
// Neither harness lets a third party react to "the user started the CLI" — Codex's
// slash commands are a fixed registry (verified: no custom-prompt loader in the
// binary), and Claude Code's `statusLine` is a rendering hook, not a lifecycle one.
// So this uses the one mechanism that needs no cooperation from the harness: a
// PowerShell *function* in the user's profile. PowerShell resolves a function ahead
// of an ExternalScript or Application, `claude` and `codex` are npm shims in PATH,
// so a function of the same name wins — it starts the window and hands over to the
// real command with the arguments untouched.
//
// Everything here is pure text handling so the cases that matter are testable: a
// profile that already has our block, one that has someone else's, and an uninstall
// that must leave every other line exactly as it was.

import { join } from "node:path";

export const MARK_BEGIN = "# >>> agent-cost-monitor >>>";
export const MARK_END = "# <<< agent-cost-monitor <<<";

/**
 * Default hosts: the ones that have no status line of their own.
 *
 * `claude` is deliberately absent. Claude Code has an additive status line that
 * shows these figures *inside* the tool, so wrapping the command would add a window
 * nobody asked for on top of a row that already works. The window is for the hosts
 * that cannot draw one — Codex and dsh-tui — and `/acm` remains available everywhere
 * for when someone wants it anyway.
 */
export const DEFAULT_HOSTS = ["codex", "dsh-tui"];

/**
 * Both profile files.
 *
 * PowerShell 5.1 and PowerShell 7 keep separate profiles, and which one a user's
 * terminal starts is not ours to assume — writing both is the only way "type
 * `claude` and it works" holds in the shell they actually use.
 */
export function profilePaths(home) {
  return [
    join(home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
    join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
  ];
}

export const configPath = (home) => join(home, ".agent-cost-monitor.json");

/**
 * Which hosts actually get a shim.
 *
 * `claude` is filtered out even when a configuration still lists it, because its own
 * status line already shows these figures: wrapping the command would open a window
 * on top of a row that works. That is a correction, not a preference, so it holds
 * regardless of what a stale config says — `/acm` is there for anyone who wants the
 * window anyway.
 */
export function shimHosts(hosts) {
  const list = Array.isArray(hosts) && hosts.length > 0 ? hosts : DEFAULT_HOSTS;
  return list.filter((host) => host !== "claude");
}

/** A single-quoted PowerShell literal. */
const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * The marked block written into a profile.
 *
 * `-WindowStyle Hidden` keeps a console from flashing, and Start-Process returns
 * immediately, so the harness starts at the same speed whether the window comes up
 * or not. Every failure path falls through to running the real command: a broken
 * spend window must never stop someone's agent from starting.
 */
export function buildShimBlock({ hosts = DEFAULT_HOSTS, acmEntry, nodePath }) {
  const lines = [
    MARK_BEGIN,
    "# Added by `acm autostart on`. Remove with `acm autostart off`, or delete this block.",
    "",
    "function __acm-start {",
    "  try {",
    `    $entry = ${psQuote(acmEntry)}`,
    `    $node = ${psQuote(nodePath)}`,
    "    if ((Test-Path $entry) -and (Test-Path $node)) {",
    "      Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList @($entry, 'launch', '--quiet') | Out-Null",
    "    } elseif (Get-Command acm -ErrorAction SilentlyContinue) {",
    "      Start-Process -WindowStyle Hidden -FilePath 'acm' -ArgumentList @('launch', '--quiet') | Out-Null",
    "    }",
    "  } catch { }   # a window that will not start is not a reason to block the agent",
    "}",
    "",
  ];
  for (const host of hosts) {
    lines.push(
      `function ${host} {`,
      "  __acm-start",
      `  $real = Get-Command ${host} -CommandType ExternalScript,Application -ErrorAction SilentlyContinue | Select-Object -First 1`,
      `  if ($real) { & $real.Source @args } else { Write-Error 'agent-cost-monitor: ${host} was not found on PATH' }`,
      "}",
      "",
    );
  }
  lines.push(MARK_END);
  return lines.join("\n");
}

export const hasBlock = (text) => typeof text === "string" && text.includes(MARK_BEGIN) && text.includes(MARK_END);

/**
 * Write the block into a profile, replacing our previous one in place.
 *
 * Replacing rather than appending is what makes `acm autostart on` repeatable: an
 * absolute path that has changed since last time must be corrected, not duplicated.
 */
export function applyBlock(text, block) {
  const existing = typeof text === "string" ? text : "";
  if (!hasBlock(existing)) {
    const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
    return `${existing}${separator}${block}\n`;
  }
  const start = existing.indexOf(MARK_BEGIN);
  const end = existing.indexOf(MARK_END) + MARK_END.length;
  return existing.slice(0, start) + block + existing.slice(end);
}

/** Remove our block and nothing else — every other line stays byte for byte. */
export function removeBlock(text) {
  if (!hasBlock(text)) return { text: typeof text === "string" ? text : "", removed: false };
  const start = text.indexOf(MARK_BEGIN);
  const end = text.indexOf(MARK_END) + MARK_END.length;
  let next = text.slice(0, start) + text.slice(end);
  next = next.replace(/^\n{2,}/, "\n").replace(/\n{3,}/g, "\n\n");
  return { text: next, removed: true };
}

/**
 * The `/acm` command, for the harness that has them.
 *
 * The body is deliberately a plain instruction rather than a `!` shell expansion:
 * how a slash command executes shell text has changed across Claude Code versions,
 * and an instruction to run one command works either way.
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
    "If `acm` is not on PATH, `npx agent-cost-monitor launch` does the same thing.",
    "",
  ].join("\n");
}

export const claudeCommandPath = (home) => join(home, ".claude", "commands", "acm.md");

/** Default configuration, written on install so there is something to edit. */
export const DEFAULT_CONFIG = { autoLaunch: true, hosts: DEFAULT_HOSTS, backend: "browser" };

export function mergeConfig(current, patch) {
  const base = current !== null && typeof current === "object" ? current : {};
  return { ...DEFAULT_CONFIG, ...base, ...patch };
}
