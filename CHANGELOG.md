# Changelog

All notable changes to this project are documented in this file, together with the
[README](README.md). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
