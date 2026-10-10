# Changelog

All notable changes to this project are documented in this file, together with the
[README](README.md). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-10-10

### Added

- **A one-command installer, `acm`.** `npx agent-cost-monitor install` detects which
  agents are present, writes the `statusLine` block for Claude Code, and prints what
  it did and what it skipped. `status`, `uninstall` and `doctor` round it out, with
  `--dry-run` to print the plan and `--force` to replace a status line belonging to
  something else.
- **The install is idempotent and self-repairing.** Running it twice changes nothing
  the second time; running it again after the repository moves updates the path
  rather than reporting a conflict, which is the whole reason the path is stored in
  the settings file. Every write is preceded by a timestamped backup of the file it
  is about to change.
- **dsh-tui support as far as it is real.** `--host dsh` fetches the
  dsh-budget-watcher plugin — a sibling checkout, or a shallow clone into
  `~/.cache/agent-cost-monitor/` — and links it into the `dsh-tui` profile, which is
  its own pnpm profile and does not contain the desktop plugin. This registers the
  data and the HTTP route. It does **not** put anything in the terminal: dsh-tui has
  no row to draw in, and the README says so plainly rather than implying otherwise.

### Fixed

- **Spawning through the shell without Node's DEP0190 warning.** On Windows `dsh` and
  `claude` are shell shims, so a shell is required — but passing an argument array
  *with* `shell: true` makes Node warn that the arguments are concatenated rather
  than escaped. Commands are now built as single quoted strings.

### Notes on what was learned building this

- **Another tool rewrote `~/.claude/settings.json` and silently dropped the installed
  `statusLine`.** Found live: the keys came back alphabetically sorted, the model
  environment had been switched, a4phone's hooks had been added, and our block was
  gone. The detector reported it correctly — which is precisely why `acm status`
  exists, and why re-running the installer must repair rather than conflict.
  Re-running `acm install` restored the block while leaving every other key, all
  three a4phone hooks and all sixteen environment entries intact. If your status line
  ever vanishes: `acm status`, then `acm install`.

## [0.1.0] — 2026-10-10

### Added

- **A Claude Code status line: one line of live spend, rendered where the agent
  already looks.** `claude/statusline.mjs` reads the status-line payload Claude
  Code passes on stdin, prices the transcript it points at, and prints
  `¥0.53 / ¥19.72 · β(t) ¥0.00/h · β ¥5.94/h · 5:21` — this turn / session, the
  live burn over a 15-second window, the turn's average burn, and the turn's
  clock. Verified against a real transcript on the author's machine
  (`¥0.02 / ¥0.48` on `glm-5.3-flash`, priced from the fetched list at the ECB
  rate of 6.6921).
- **The cost engine, extracted from [dsh-budget-watcher](https://github.com/NeutronStar714/dsh-budget-watcher)
  `0.7.2`.** `lib/cost.js` (rate card, peak hours, usage pricing),
  `lib/pricing.js` (the fetched third-party list and its canonical model-name
  matching), and `lib/fx.js` (the ECB's daily USD→CNY cross rate). Copied rather
  than shared so this project stands alone; the two will drift on purpose. See
  the README's limitations.
- **The cache discipline the plugin uses, scaled down to one file.** The rate
  card and the exchange rate live in `~/.cache/spend-watch/claude-pricing.json`
  for a day; a stale cache is refreshed by a detached child, and the hot path
  never waits on the network. The first ever run does one short inline fetch.

[0.1.0]: https://github.com/NeutronStar714/agent-cost-monitor/releases/tag/v0.1.0
