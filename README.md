# agent-cost-monitor

One line of live spend for an AI coding agent, rendered where the agent already
looks:

```
¥0.53 / ¥19.72 · β(t) ¥0.00/h · β ¥5.94/h · 5:21
```

- `¥0.53 / ¥19.72` — **this turn** / **the session so far**
- `β(t) ¥0.00/h` — **live burn**: what the last 15 seconds were costing, projected
  to an hour. Zero when nothing has run recently, which is the point: it is the
  figure that moves when a task starts burning.
- `β ¥5.94/h` — **average burn**: this turn's cost over this turn's elapsed time.
- `5:21` — the turn's clock.

This is **not a DSH plugin**. It is a standalone command with no dependencies,
run by the agent itself. The first host is **Claude Code**, and it is the
template: a host contributes a thin adapter that turns its own logs into priced
units, and everything downstream — pricing, both burn rates, the cache
discipline — is shared.

## How it works

Claude Code runs a `statusLine` command with a JSON payload on stdin whose
`transcript_path` points at the session's own JSONL log. The script reads that
transcript, maps every assistant entry that reports usage onto the engine's four
buckets (uncached input, cache write, cache read, output), and prices them:

- **DeepSeek** models from DeepSeek's own published two-currency table, bundled
  in `lib/cost.js` — peak and off-peak, CNY and USD, exactly as the provider
  publishes them.
- **Everything else** from OpenRouter's public model list — free, no key — whose
  `prompt` / `completion` / `input_cache_read` / `input_cache_write` map onto the
  same four buckets, converted to CNY at the European Central Bank's daily
  reference rate when the display currency is CNY.

A model that cannot be priced contributes zero and is never guessed at. An
unpriced turn is visible; a confident fraction of the truth is not.

## Install

One command. It detects which agents you have, configures the ones it supports,
and installs nothing you did not ask for:

```bash
npx agent-cost-monitor install
```

Or install it once and use the shorter name:

```bash
npm install -g agent-cost-monitor
acm install
```

```
$ acm install
install

claude code
  status line installed
  backed up to ~/.claude/settings.json.bak-2026-10-10T11-42-49-495Z

dsh-tui is present but untouched. Add it with: acm install --host dsh

done.
```

| Command | What it does |
|---|---|
| `acm status` | What is detected, what is configured, and how old the pricing cache is |
| `acm install [--host claude\|dsh\|all]` | Configure a host. Default: Claude Code. |
| `acm uninstall [--host …]` | Remove only what this installer added |
| `acm doctor` | Check the pieces the status line needs |
| `--dry-run` | Print the plan and change nothing |
| `--force` | Replace a status line configured by something else |

Installing is **idempotent and re-runnable**: running it twice changes nothing the
second time, and running it again after the repository moves repairs the path
rather than reporting a conflict. It never touches a `statusLine` that belongs to
something else — that needs `--force` — and `uninstall` removes our key and
nothing else. Every write is preceded by a timestamped backup.

### What it writes for Claude Code

```json
"statusLine": {
  "type": "command",
  "command": "node \"D:/Dev/deepseek/plugindev/agent-cost-monitor/claude/statusline.mjs\"",
  "padding": 0,
  "refreshInterval": 10
}
```

No hooks, no daemon, no background process. Claude Code reloads settings and runs
the command as soon as the file is saved; if the line does not appear, restart it.

**`refreshInterval` is not optional here.** The status line otherwise re-runs only
on events — a new assistant message, a mode change — so during a long stream or an
idle stretch it would sit on a stale figure. `β(t)` is a 15-second window, which
means it has to be re-evaluated *inside* that window to mean anything: without a
timer it shows whatever the last event left behind instead of decaying to zero.
Ten seconds keeps it honest at three samples per window.

**Paths are written with forward slashes.** On Windows, Claude Code runs the
command through Git Bash when it is installed, and Git Bash eats backslashes as
escape characters — a `C:\...` path arrives with its separators stripped and the
command fails *without any visible error*. Forward slashes work in both shells, and
`~` expands to your home directory.

### dsh-tui

`acm install --host dsh` fetches the
[dsh-budget-watcher](https://github.com/NeutronStar714/dsh-budget-watcher) plugin —
a sibling checkout if you have one, otherwise a clone into
`~/.cache/agent-cost-monitor/` — and links it into the `dsh-tui` profile with
`dsh plugin --profile dsh-tui add link:…`.

**Be clear about what that gives you: the data, not a terminal row.** It registers
the host plugin, which means DSH computes the figures and serves them over
`GET /dsh-budget-watcher/balance`. dsh-tui has no status line to draw them in, so
nothing appears in the terminal yet. The DSH panel is a web client, and DSH's
on-disk session files are empty stubs, so the HTTP route is the only interface —
the intended renderer is the floating window, which is not built.

Set `SPEND_WATCH_CURRENCY=USD` to show dollars instead of yuan, and
`SPEND_WATCH_CACHE` to move the pricing cache (default
`~/.cache/spend-watch/claude-pricing.json`).

### If nothing appears

Work through these in order — the first two account for most blank status lines:

1. **Workspace trust.** A `statusLine` is a shell command, so it runs under the
   same trust rule as hooks. Until you accept the trust dialog for the folder, the
   row stays blank and `claude --debug` logs
   `Status line command skipped: workspace trust not accepted`.
2. **Run it by hand.** This is the whole thing, minus Claude Code:

   ```powershell
   '{"transcript_path":"C:/Users/you/.claude/projects/<project>/<session>.jsonl"}' |
     node D:/Dev/deepseek/plugindev/agent-cost-monitor/claude/statusline.mjs
   ```

   It should print one line. A silent exit means the script is the problem, not the
   configuration.
3. **`claude --debug`** logs the script's stderr on every invocation and its exit
   code on the first one in a session. A script that exits non-zero, or prints
   nothing, leaves the row blank — which is what this script's own catch-all avoids
   by printing a zeroed line rather than nothing.
4. **Know what you are trading.** With a custom status line configured, Claude Code
   stops showing most of the footer's keyboard hints — `esc to interrupt`,
   `? for shortcuts`, the voice-dictation hint. The line renders in its own row
   above the remaining badges rather than replacing them.

## Speed

The status line runs constantly, so its hot path never touches the network. The
rate card and the exchange rate are cached on disk for a day, and a stale cache
is refreshed by a detached child process — the line itself answers from the cache
and never waits on a stranger's server. The first ever run does one short inline
fetch so the very first line is already priced.

## Known limitations

1. **Everything is priced as one pot.** Subagent (sidechain) spend is included in
   the total and flagged in the data, but the line has no per-agent split, and an
   entry that reports no usage contributes nothing rather than an "unpriced"
   marker — there is no room for one on a single line.
2. **Turn boundaries are derived, not recorded.** A `user` entry carrying text
   opens a turn; a tool result, which also arrives as a `user` entry, does not.
   A compacted or continued session can misattribute its earliest turns.
3. **Average burn is the turn's, paired with the turn's own clock.** Claude Code
   reports a session-wide wall-clock duration, but pairing it with a per-turn
   rate would read as a session average and be wrong by however many turns ran
   before it.
4. **One API response logged more than once is billed once**, keeping the fuller
   of the reported usages — but the de-duplication key is the response's
   `message.id`. A proxy that logs one line per content block *without* ids would
   still be counted per line.
5. **The first run may price DeepSeek only**, until the first rate-card fetch
   lands. Third-party models read as zero rather than as their real cost in the
   meantime.
6. **No balance.** A CLI host has no balance API. The DeepSeek balance remains
   where it belongs: the [dsh-budget-watcher](https://github.com/NeutronStar714/dsh-budget-watcher)
   plugin, whose floating panel this project's engine was extracted from.
7. **`lib/` is copied from dsh-budget-watcher `0.7.2`, not shared.** The two will
   drift on purpose — this project follows CLI hosts, the plugin follows DSH. If
   a fix lands in one, check the other.

## Next hosts

- **Codex CLI** — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` records
  first-class turn lifecycle (`turn_context`, `task_started`, `task_complete`,
  `turn_aborted`) and `token_count` events whose usage sits in
  `payload.info.total_token_usage` / `last_token_usage`. The easiest adapter of
  the three.
- **dsh-tui** — needs no adapter at all: the dsh-budget-watcher plugin already
  serves the figures over HTTP, and DSH's on-disk session files are empty stubs,
  so the endpoint is the only real interface.
