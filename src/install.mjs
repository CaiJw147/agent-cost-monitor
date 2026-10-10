// Install planning: the decisions, kept apart from doing them.
//
// Everything here is pure — it takes a parsed settings object and hands back the
// object to write plus what to say about it. The CLI does the I/O. That split is
// what makes the cases that actually bite testable: a status line someone else
// configured, a second run that should change nothing, an uninstall that must not
// touch the rest of the file.

/** Appears in our own command string, so we can recognise our own work later. */
export const MARKER = "agent-cost-monitor";

/** Windows paths reach Git Bash, which eats backslashes. Forward slashes work in both shells. */
export const toPosix = (value) => String(value).replace(/\\/g, "/");

/**
 * The block Claude Code runs.
 *
 * `refreshInterval` is not decoration: without it the status line re-runs only on
 * events, and the live-burn segment is a fifteen-second window that would then sit
 * on whatever the last event left behind instead of decaying to zero.
 */
export function ourStatusLine(scriptPath) {
  return {
    type: "command",
    command: `node "${toPosix(scriptPath)}"`,
    padding: 0,
    refreshInterval: 10,
  };
}

export function isOurStatusLine(statusLine) {
  return typeof statusLine?.command === "string" && statusLine.command.includes(MARKER);
}

/**
 * @returns {{action: "install" | "replace" | "unchanged" | "conflict", settings: object, message: string}}
 */
export function planClaudeInstall(settings, scriptPath, { force = false } = {}) {
  const wanted = ourStatusLine(scriptPath);
  const current = settings?.statusLine;

  if (isOurStatusLine(current) && current.command === wanted.command) {
    return { action: "unchanged", settings, message: "already installed, pointing at this checkout" };
  }
  if (isOurStatusLine(current)) {
    // Ours, but from a different path — a moved checkout, most likely. That is a
    // repair, not a conflict, and it is the whole reason the path is stored.
    return { action: "replace", settings: { ...settings, statusLine: wanted }, message: "updated: the configured path had changed" };
  }
  if (current !== undefined && !force) {
    return {
      action: "conflict",
      settings,
      message: `a status line is already configured (${String(current?.command ?? current)}); re-run with --force to replace it`,
    };
  }
  return {
    action: current === undefined ? "install" : "replace",
    settings: { ...settings, statusLine: wanted },
    message: current === undefined ? "status line installed" : "foreign status line replaced (--force)",
  };
}

export function planClaudeUninstall(settings) {
  if (!isOurStatusLine(settings?.statusLine)) {
    return { action: "unchanged", settings, message: "nothing of ours is installed" };
  }
  const next = { ...settings };
  delete next.statusLine;
  return { action: "uninstall", settings: next, message: "status line removed" };
}

/** pnpm's local-link spec; `dsh plugin --profile <p> add` is a passthrough to it. */
export const pluginSpec = (pluginDir) => `link:${toPosix(pluginDir)}`;

export function looksLikePluginDir(pkg) {
  return pkg?.name === "dsh-budget-watcher";
}

/**
 * One line per host, for `acm status` and for the summary after an install.
 * @param {{claude: object, dsh: object, codex: object}} hosts
 */
export function describeHosts(hosts) {
  const lines = [];
  const yn = (v) => (v ? "yes" : "no");

  lines.push(`claude code  detected: ${yn(hosts.claude.detected)}   status line: ${hosts.claude.status}`);
  if (hosts.claude.detected) lines.push(`             ${hosts.claude.detail}`);

  lines.push(`dsh-tui      detected: ${yn(hosts.dsh.detected)}   plugin: ${hosts.dsh.status}`);
  if (hosts.dsh.detected) lines.push(`             ${hosts.dsh.detail}`);

  if (hosts.codex.detected) lines.push(`codex        detected: yes   not supported yet (no status-line hook; hooks/notify only)`);
  return lines.join("\n");
}
