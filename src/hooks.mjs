// Start the window when a session starts.
//
// Both harnesses expose the same extension point, under the same event name —
// `SessionStart` — and both are already in use on this machine by a4phone, so this is
// configuration rather than a new mechanism:
//
//   Claude Code   ~/.claude/settings.json   hooks.SessionStart[].hooks[].command
//   Codex         ~/.codex/config.toml      [[hooks.SessionStart.hooks]] command
//
// Everything here is pure text and object planning, so the awkward cases — a
// config.toml that already has a `[features]` table, a hook that is already present, a
// removal that has to leave a file the user depends on exactly as it was — are testable
// without touching a real config.
//
// The withdrawn shell shim taught the rules this follows: fence what you write, be
// idempotent, and be able to remove it byte-for-byte.

// The fence is defined once, in autostart.mjs, and re-exported: two modules declaring
// the same marker strings is how a removal routine silently stops matching what an
// install routine wrote.
export { MARK_BEGIN, MARK_END, hasBlock } from "./autostart.mjs";
import { MARK_BEGIN, MARK_END, hasBlock } from "./autostart.mjs";

/** How our own hook is recognised in either host, so removal never guesses. */
export const MARKER = "acm launch";

/** The host name each source is known by, so the window reads the right files. */
export const hookCommand = (host) => `acm launch --host ${host}`;

// ------------------------------------------------------- Claude Code (JSON) ---

/**
 * One `SessionStart` entry.
 *
 * `matcher: "startup"` and not `"*"`: a resumed or compacted session is not a new
 * session, and starting a second window for one would be noise.
 */
export function claudeHookEntry(host) {
  return { matcher: "startup", hooks: [{ type: "command", command: hookCommand(host) }] };
}

export const isOurClaudeEntry = (entry) =>
  Array.isArray(entry?.hooks) && entry.hooks.some((h) => typeof h?.command === "string" && h.command.includes(MARKER));

/** Add our entry, or report that it is already there. Never mutates the input. */
export function planClaudeHookInstall(settings, host) {
  const current = settings !== null && typeof settings === "object" ? settings : {};
  const next = JSON.parse(JSON.stringify(current));
  const hooks = next.hooks !== null && typeof next.hooks === "object" ? next.hooks : (next.hooks = {});
  const entries = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : (hooks.SessionStart = []);

  if (entries.some(isOurClaudeEntry)) return { settings: next, changed: false };
  entries.push(claudeHookEntry(host));
  return { settings: next, changed: true };
}

/** Remove every entry of ours, and the containers it leaves empty. */
export function planClaudeHookRemove(settings) {
  const current = settings !== null && typeof settings === "object" ? settings : {};
  const next = JSON.parse(JSON.stringify(current));
  const entries = next.hooks?.SessionStart;
  if (!Array.isArray(entries)) return { settings: next, changed: false };

  const kept = entries.filter((entry) => !isOurClaudeEntry(entry));
  if (kept.length === entries.length) return { settings: next, changed: false };

  if (kept.length === 0) delete next.hooks.SessionStart;
  else next.hooks.SessionStart = kept;
  // Only remove `hooks` itself if nothing else is using it — a4phone's three hooks are
  // in this same object and losing them would be a real loss, not a cosmetic one.
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return { settings: next, changed: true };
}

// --------------------------------------------------------- Codex (TOML) ---

export function codexHookBlock(host, eol = "\n") {
  return [
    MARK_BEGIN,
    "# Added by `acm hook on`. Remove with `acm hook off`, or delete this block.",
    "[[hooks.SessionStart]]",
    "[[hooks.SessionStart.hooks]]",
    'type = "command"',
    `command = "${hookCommand(host)}"`,
    MARK_END,
  ].join(eol);
}

/** The file's own line ending, so an appended block does not mix conventions. */
const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");

/**
 * What install appends, and therefore what removal cuts.
 *
 * Named and used in both directions on purpose. An earlier version stripped trailing
 * whitespace on install and collapsed runs of blank lines on removal, which restored the
 * file *approximately* — and a config the user depends on deserves better than
 * approximately. It also meant the two operations were not inverses, so a round trip was
 * only ever verified against a synthetic file that happened to have neither.
 */
export const codexHookAppend = (host, eol = "\n") => `${eol}${codexHookBlock(host, eol)}${eol}`;

/**
 * Codex will not run a hook it has not been told to trust.
 *
 * Its own config records a `trusted_hash` per hook under `[hooks.state]`, which is why
 * a freshly written hook needs approving once from inside the app. Nothing here can
 * forge that hash, and it should not try.
 */
export const CODEX_TRUST_NOTE = "Codex tracks a trust hash per hook, so the first session after this may ask you to approve it once.";

const featuresHeader = /^[ \t]*\[features\][ \t]*$/m;
const featuresHooksOn = /^[ \t]*hooks[ \t]*=[ \t]*true[ \t]*$/m;

/**
 * Ensure `features.hooks = true`.
 *
 * This is the one genuinely dangerous edit in this file: TOML forbids redefining a
 * table, so appending a second `[features]` to a config that already has one would make
 * the whole file unparseable and break the user's Codex. So an existing `[features]`
 * gets the key inserted into it, and a missing one gets a new table appended.
 *
 * Removal deliberately does not undo this: another tool may rely on the flag, and a
 * feature flag that is on when it need not be is harmless, where a missing one makes the
 * hook silently dead.
 */
function ensureFeaturesHooks(text) {
  const header = text.match(featuresHeader);
  if (header === null) {
    const eol = eolOf(text);
    return { text: `${text}${text.endsWith(eol) || text === "" ? "" : eol}${eol}[features]${eol}hooks = true${eol}`, changed: true };
  }
  const after = text.slice(header.index + header[0].length);
  // Only look inside this table's own body, up to the next header.
  const body = after.split(/\r?\n(?=\[)/)[0] ?? "";
  if (featuresHooksOn.test(body)) return { text, changed: false };
  const insertAt = header.index + header[0].length;
  const eol = eolOf(text);
  return { text: `${text.slice(0, insertAt)}${eol}hooks = true${text.slice(insertAt)}`, changed: true };
}

export function planCodexHookInstall(text, host) {
  const source = typeof text === "string" ? text : "";
  const eol = eolOf(source);

  if (hasBlock(source)) {
    // Already installed. Re-write only if it points at a different host, so changing
    // `--host` corrects the block instead of stacking a second one.
    const block = codexHookBlock(host, eol);
    const start = source.indexOf(MARK_BEGIN);
    const end = source.indexOf(MARK_END) + MARK_END.length;
    const existing = source.slice(start, end);
    if (existing === block) return { text: source, changed: false, note: CODEX_TRUST_NOTE };
    return { text: source.slice(0, start) + block + source.slice(end), changed: true, note: CODEX_TRUST_NOTE };
  }

  const features = ensureFeaturesHooks(source);
  return { text: features.text + codexHookAppend(host, eol), changed: true, note: CODEX_TRUST_NOTE };
}

/**
 * Cut exactly what install appended.
 *
 * The fence is matched with one newline on each side, because that is what the append
 * put there — so the bytes before and after are returned untouched. Falls back to the
 * bare fence if the file has been edited around it since.
 */
export function planCodexHookRemove(text) {
  const source = typeof text === "string" ? text : "";
  if (!hasBlock(source)) return { text: source, changed: false };

  const appended = /\r?\n# >>> agent-cost-monitor >>>[\s\S]*?# <<< agent-cost-monitor <<<\r?\n/;
  const match = source.match(appended);
  if (match !== null && match.index !== undefined) {
    return { text: source.slice(0, match.index) + source.slice(match.index + match[0].length), changed: true, exact: true };
  }

  const start = source.indexOf(MARK_BEGIN);
  const end = source.indexOf(MARK_END) + MARK_END.length;
  return { text: source.slice(0, start) + source.slice(end), changed: true, exact: false };
}
