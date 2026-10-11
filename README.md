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

auto-launch
  added    C:\Users\you\Documents\PowerShell\Microsoft.PowerShell_profile.ps1
  /acm      C:\Users\you\.claude\commands\acm.md
  Codex has no custom slash commands, so inside it use: !acm launch

done.
```

### Starting the window

There is **no auto-launch**, deliberately. An earlier version wrapped `codex` and
`dsh-tui` in a PowerShell function so the window rode along with them. That meant
editing two profile files to save the user one command, and the window it opened was
showing another host's numbers half the time — a cost with no matching benefit. The
window is now started when you ask for it:

```bash
acm launch                # start it now
acm launch --host codex   # and tell it which host this window is for
```

`--host` matters: it makes the window read that host's data first and *name it on
screen*, instead of quietly falling back to whichever source happened to answer. A
window showing Codex's numbers when you are running Claude Code is worse than one
showing nothing.

If a machine still carries the old shim, `acm clean-profiles` removes it, and
`acm uninstall` does the same as part of removing everything.

The window's size, position, transparency to clicks and warn line all come from
`~/.agent-cost-monitor.json` — see **[Configuration](#configuration)** below.

### Uninstalling

One command undoes all of it:

```bash
acm uninstall            # every host, both profiles, /acm, the config and the cache
npm uninstall -g agent-cost-monitor   # and then the package
```

`acm uninstall --self` folds that second line in, and `--keep-cache` leaves the
pricing cache (it refetches itself, so removing it is only tidiness). Uninstall is
**total by design** — `--host` narrows it if you want that — because a trail of edits
across a settings file, two shell profiles and a command directory is exactly what
stops people installing something in the first place. Every settings write is preceded
by a timestamped backup, so the file you had is always still on disk.

### Launching it from inside a harness

- **Claude Code** — `/acm`. The installer writes `~/.claude/commands/acm.md`. You
  rarely need it: the status line is already in the tool.
- **Codex** — `!acm launch`. Codex has **no custom slash commands** (its registry is
  fixed: `/fork`, `/model`, `/statusline`, …), but it does have the `!` shell escape,
  so that is the equivalent. `acm` does not write a prompt file there, because it
  would sit there doing nothing. `!acm launch --host codex` points the window at Codex.

### A note on PATH

`npm install -g agent-cost-monitor` puts `acm` on your PATH the same way it does for
any global package with a `bin` field — you do not configure anything. If you are
running from a checkout instead, `npm link` gives you the identical result against
live code.

| Command | What it does |
|---|---|
| `acm status` | What is detected, what is configured, and how old the pricing cache is |
| `acm install [--host claude\|dsh\|all] [--no-autostart]` | Configure a host. Default: Claude Code. |
| `acm uninstall [--host …] [--self] [--keep-cache]` | Remove everything acm added. Default: all of it. |
| `acm launch [--quiet]` | Start the window now |
| `acm autostart on\|off\|status` | The shim that rides along with `codex` / `dsh-tui` |
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

## The window

The status line only exists where the host provides one, which rules out Codex and
dsh-tui. The window is the renderer that does not care: one daemon, one page, and
whatever the host writes as the source.

```bash
npm run window                    # an Edge/Chrome app window, pinned always-on-top
npm run window -- --host codex    # ...reading Codex, and saying so on screen
npm run window:tauri              # the real widget (compiles Rust the first time)
```

It shows the host it is reading, the `turn / session · β(t) · β · clock` line, and the
**burn chart** — the windowed rate over time with the warn line across it, drawn the
way the DSH panel draws it.

**There is no balance row, on purpose.** The balance is DeepSeek's and only DSH can
read it, so in a window that also serves Codex and Claude Code it was a figure about a
different provider than the one being measured — and one that would never move for two
of the three hosts. Cost and burn rate are the whole job.

### Where the numbers come from

Three sources, tried in the order you imply with `--host`, then DSH → Codex →
Claude Code:

| Source | What it reads |
|---|---|
| **dsh** | the dsh-budget-watcher plugin's route (`ACM_DSH_URL`) — the only source with a balance, which the window now ignores |
| **codex** | `~/.codex/sessions/**/rollout-*.jsonl` for the per-call cache split, `~/.codex/state_5.sqlite` for a whole-thread total when the rollout has none |
| **claude-code** | the newest `~/.claude/projects/**/*.jsonl` transcript with usage |

Whichever answers is **named on screen**, and the ones that were tried and failed are
listed with their reason. A window silently showing another host's numbers is worse
than one showing none.

`ACM_WINDOW_PORT` (default `7420`) moves the daemon, `ACM_WARN_PER_HOUR` (default
`15`) moves the warn line, and `SPEND_WATCH_CURRENCY=USD` switches to dollars.

### Codex specifics

Codex's own logs are the richest of the three — `turn_context` records the model that
*actually ran*, per turn, which is not the configured one (a config saying `gpt-6-sol`
while sessions ran `gpt-6-luna` is why this reads logs at all) — but two things are
worth knowing:

- **Codex reports `input_tokens` as the whole input, cache included.** The engine's
  `inputTokens` means the uncached remainder, so the cached half is subtracted rather
  than billed twice.
- **A refused turn leaves no usage at all.** Hitting a subscription usage limit ends
  the turn with nothing recorded, which is not the same as spending nothing. When that
  happens the window falls back to `threads.tokens_used` and labels the figure `≈`,
  because only the uncached price can be applied to a total with no cache split — which
  overstates rather than understates, the safe direction for a spend warning.

## Configuration

### Commands

| Command | What it does |
|---|---|
| `acm install [--host claude\|dsh\|all]` | Configure a host. Default: Claude Code. |
| `acm launch [--host h] [--quiet]` | Start the window now. `--host codex` points it at Codex. |
| `acm status` | What is detected, what is configured, how old the pricing cache is |
| `acm doctor` | Node, the status script, git, dsh, the resolved window geometry, and the paths of both files below |
| `acm log [--lines N]` | The last N lines of the window log (default 40) |
| `acm uninstall [--host …] [--self] [--keep-cache]` | Remove everything acm added. Total by default. |
| `acm clean-profiles` | Remove an old auto-launch block, if a previous version left one |
| `--dry-run` / `--force` | Print the plan and change nothing / replace a status line configured by something else |

As npm scripts: `npm run window`, `npm run window:tauri`, `npm test`.

### `~/.agent-cost-monitor.json`

Every value can also be set by environment variable, and the environment wins —
those variables existed before the file did, and they are the per-invocation override.

```json
{
  "backend": "browser",
  "warnPerHour": 15,
  "windowWidth": 380,
  "windowHeight": 600,
  "windowX": 40,
  "windowY": 80,
  "alwaysOnTop": true,
  "port": 7420
}
```

| Key | Default | Meaning | Env override |
|---|---|---|---|
| `backend` | `browser` | `browser` for an Edge/Chrome app window, `tauri` for the real widget | `ACM_WINDOW_BACKEND` |
| `windowWidth` | `380` | Window width in pixels | `ACM_WINDOW_WIDTH` |
| `windowHeight` | `600` | Window height in pixels | `ACM_WINDOW_HEIGHT` |
| `windowX` | `40` | Left edge, screen pixels | `ACM_WINDOW_X` |
| `windowY` | `80` | Top edge, screen pixels | `ACM_WINDOW_Y` |
| `alwaysOnTop` | `true` | Keep it above other windows | `ACM_ALWAYS_ON_TOP=0` to disable |
| `warnPerHour` | `15` | Where the dashed warn line sits on the chart | `ACM_WARN_PER_HOUR` |
| `port` | `7420` | The local daemon's port | `ACM_WINDOW_PORT` |

A value that is zero, negative, or not a number falls back to the default rather than
producing a window that cannot be seen. A corrupt config file is ignored, not obeyed.

Other environment variables, which have no config-file equivalent:

| Variable | Default | Meaning |
|---|---|---|
| `SPEND_WATCH_CURRENCY` | `CNY` | `USD` to price in dollars |
| `SPEND_WATCH_CACHE` | `~/.cache/spend-watch` | Where the pricing cache lives |
| `ACM_DSH_URL` | `http://127.0.0.1:19387/dsh-budget-watcher/balance` | The DSH plugin's route |
| `ACM_DSH_PROFILE` | `dsh-tui` | Which DSH profile the plugin is installed into |
| `ACM_PLUGIN_DIR` | — | A local dsh-budget-watcher checkout, instead of cloning one |

### Where things live

Nothing is sent anywhere. These are the only paths acm writes:

| Path | What it is |
|---|---|
| `~/.agent-cost-monitor.json` | the configuration above |
| `~/.cache/agent-cost-monitor/window.log` | **the log.** Every launch, its geometry, every source resolution (`host=codex -> codex (gpt-6-sol)`) and every failure reason. Truncated once it passes 256 KB. Read it with `acm log`. |
| `~/.cache/spend-watch/claude-pricing.json` | the fetched model list and the ECB rate, with a 24-hour TTL. The only thing that ever leaves the machine, and only these two public endpoints. |
| `~/.claude/settings.json` | the `statusLine` entry. Every write is preceded by a `settings.json.bak-<timestamp>` copy. |
| `~/.claude/commands/acm.md` | the `/acm` slash command |
| `~/.dsh/profiles/<profile>/` | the dsh-budget-watcher plugin, if you installed it with `--host dsh` |

And these it only **reads**:

| Path | For |
|---|---|
| `~/.claude/projects/**/*.jsonl` | Claude Code transcripts |
| `~/.codex/sessions/**/rollout-*.jsonl` | Codex rollouts |
| `~/.codex/state_5.sqlite` | Codex thread totals, read-only, only when a rollout has no usage |

`acm uninstall` removes everything in the first table except the package itself
(`--self` does that too).

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

## Hosts

| Host | Status |
|---|---|
| **Claude Code** | the status line, `/acm` for the window, and a transcript adapter |
| **Codex CLI** | a rollout + SQLite adapter, and `acm launch --host codex`. No status line exists to hook, so the window is the renderer. |
| **dsh-tui** | needs no adapter: the dsh-budget-watcher plugin already serves the figures over HTTP, and DSH's on-disk session files are empty stubs, so that endpoint is the only real interface. The window reads it. |

The next host is whatever writes token usage somewhere readable. The pattern is one
adapter (a pure parser, tested against real recorded payloads) plus one entry in the
daemon's source list — `src/codex.mjs` and `fromCodex()` are the template.
