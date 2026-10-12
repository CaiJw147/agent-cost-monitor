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

### Starting the window with a hook

Both harnesses expose the same extension point — a `SessionStart` hook — so the window
can come up with the session instead of being asked for:

```bash
acm hook on                # both hosts whose config exists
acm hook on --host codex   # just Codex
acm hook status
acm hook off
```

| Host | What is written |
|---|---|
| **Claude Code** | `~/.claude/settings.json` → `hooks.SessionStart` (with `matcher: "startup"`) **and** `hooks.UserPromptSubmit` |
| **Codex** | `~/.codex/config.toml` → fenced `[[hooks.SessionStart]]` and `[[hooks.UserPromptSubmit]]` blocks, plus `features.hooks = true` if the file does not already enable it |

**Both events, because one is not enough.** `SessionStart` alone works for a CLI you launch
per session, and fails in the desktop apps: those are long-lived, so it fires once when the
app opens and not again when you send a prompt. `UserPromptSubmit` matches "I started
working", which is when the window is actually wanted.

The command is `acm launch --if-needed --host <host>`. **`--if-needed` is the important
part**: this hook runs on *every* prompt, so without it each prompt would stack another
window.

It decides by **finding the window**, not by asking the daemon whether anything polled. That
distinction matters: a hidden Edge window keeps its page running, so it keeps polling —
which meant a poll-based check kept answering "already open" for a window that was not on
screen at all, and nothing would ever show it again. The probe uses `EnumWindows` (which
sees hidden windows, unlike `MainWindowTitle`), and **repairs what it finds**: a hidden
window is shown, a wrongly sized one is resized, and `WS_EX_TOPMOST` is re-asserted and then
verified. A window that gets hidden, minimised or unpinned therefore repairs itself on the
next prompt instead of becoming a ghost that blocks the feature.

The decision is made in the launcher, which `acm` spawns detached, so your prompt is never
held up: `acm` returns in tens of milliseconds either way (measured: 191 ms).

**It has two modes, and the difference is yours to keep.** `place` runs once, right after a
browser is spawned, and applies the configured geometry. `repair` runs on every prompt and
**leaves an already-visible window exactly where you put it**, restoring and placing only a
window that is hidden or minimised, and re-asserting the pin either way. Applying the geometry
on every prompt was what reset the position each time you sent one.

Both are fenced, idempotent and removable: `acm hook off` restores the file **byte for
byte** (verified by SHA-256 against copies of the real configs), and `acm uninstall`
removes the hooks as part of removing everything. Every write is preceded by a timestamped
`.bak-` copy. Re-running `acm hook on` **upgrades** an entry left by an earlier version
rather than taking it as present, which is how a machine moves from the old single-event
hook to this one.

Two things to expect:

- **Codex asks you to trust the hook once.** Its config records a `trusted_hash` per
  hook under `[hooks.state]`; a freshly written hook is not trusted yet, so the first
  session may prompt. That hash cannot be forged and this does not try.
- **`features.hooks = true` stays after `acm hook off`.** Another tool may rely on the
  flag, and a flag that is on when it need not be is harmless, where a missing one makes
  the hook silently dead.

This is not the auto-launch that was withdrawn. That wrapped `codex` and `dsh-tui` in
PowerShell functions, which meant editing two shell profiles to save one command; a
`SessionStart` hook fires on the event and touches nothing but the harness's own config.

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

**The dot** answers one question: are we spending faster than the warning rate? Green
below `warnPerHour`, amber above it, red when nothing could be read. It is the same
threshold the dashed line is drawn at, so the dot and the line cannot disagree about
what "too fast" means. (It used to go amber on *any* spend at all, which lit it at a
twelfth of the threshold and kept it lit until the rate fell to exactly zero — it read
as a latch rather than as a level.)

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

The window's size, position, pinning and burn window all come from
`~/.agent-cost-monitor.json`, and the same file decides the burn window the Claude
Code status line uses — one setting, so the two renderers cannot disagree about the
same session. Every key and every environment variable is in
**[Configuration](#configuration)**.

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
| `acm hook on\|off\|status [--host claude\|codex\|all]` | A `SessionStart` hook that opens the window with the session |
| `--dry-run` / `--force` | Print the plan and change nothing / replace a status line configured by something else |

As npm scripts: `npm run window`, `npm run window:tauri`, `npm test`.

### `~/.agent-cost-monitor.json`

Every value can also be set by environment variable, and the environment wins —
those variables existed before the file did, and they are the per-invocation override.

```json
{
  "backend": "browser",
  "warnPerHour": 15,
  "windowWidth": 225,
  "windowHeight": 300,
  "windowX": 40,
  "windowY": 80,
  "alwaysOnTop": true,
  "port": 7420
}
```

| Key | Default | Meaning | Env override |
|---|---|---|---|
| `backend` | `browser` | `browser` for an Edge/Chrome app window, `tauri` for the real widget | `ACM_WINDOW_BACKEND` |
| `windowWidth` | `225` | Window width in pixels | `ACM_WINDOW_WIDTH` |
| `windowHeight` | `300` | Window height in pixels | `ACM_WINDOW_HEIGHT` |
| `windowX` | `40` | Left edge, screen pixels | `ACM_WINDOW_X` |
| `windowY` | `80` | Top edge, screen pixels | `ACM_WINDOW_Y` |
| `alwaysOnTop` | `true` | Keep it above other windows | `ACM_ALWAYS_ON_TOP=0` to disable |
| `warnPerHour` | `15` | Where the dashed warn line sits on the chart | `ACM_WARN_PER_HOUR` |
| `burnWindowMs` | `15000` | The window the live burn rate `β(t)` is measured over — 15 seconds. The same name and meaning as the DSH plugin's setting, so one idea has one name. Below 1000 it clamps, because a sub-second window reports whichever single call happened to land in it rather than a rate. | `ACM_BURN_WINDOW_MS` |
| `pollMs` | `1000` | How often the window asks the daemon, in milliseconds. The page chains its next request off the previous one finishing, so a slow answer delays the next poll instead of stacking overlapping ones. Below 250 it clamps. | `ACM_POLL_MS` |
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

### The icon

The window wears the project's own icon rather than the browser's globe, and the two backends
need it in different places:

- **Browser window** — an app window takes its icon from the *page*, so `index.html` declares
  `<link rel="icon" href="/icon.png">` and the daemon serves it. That file is
  `window/icon.png`, and it is the one that ships.
- **Tauri widget** — the icon is embedded in the executable, from `src-tauri/icons/`, which is
  generated. To change it, replace `icon.png` at the project root (512×512), run
  `python build-icon.py` — which writes a proper ladder: an explicit halving reduction with
  LANCZOS, and **DIB entries below 256** where most generators write PNG — then
  `npm run window:tauri`.

- **Why a large icon matters more than a good `.ico`.** A *running* window is drawn in the
  taskbar from the window's own icon, not from the executable's resource, and Tauri's default
  comes from the first entry in `bundle.icon`. With `32x32.png` first, a 32 px image was being
  **upscaled** into a ~48 px taskbar slot — which is what blur looks like. The widget now sets
  its window icon from `icons/icon.png` (256 px, generated from the 512 source), so Windows scales *down*. If a taskbar icon looks soft,
  check the window icon before suspecting the artwork or the `.ico`: the source here measures
  3.7% mid-tone pixels at 512 and 8.6% at 32, which is crisp.

### What the chart's axis means

The x-axis is the **turn's own time**, in the same units the DSH panel uses: it starts at
`0:00`, runs to the turn's elapsed time, and **stops when the turn stops**. The labelled
right-hand edge is that duration, arrowed while the turn is still running (`→ 1:05`) and
unarrowed once it has ended — the panel's own convention, and the cue that distinguishes
running from frozen.

The line is **anchored at `(0,0)`** whether or not anything has settled yet. The first settled
sample cannot exist until an API response reports usage, so a chart that began at the first
sample showed nothing at all for the first several seconds; drawing from the origin means the
chart is live from the moment the turn starts.

Only the **current turn** is plotted. Every turn shares one timeline, so a session-wide series
would put one turn's samples on top of another's.

The **clock and `β`** work the same way. A turn whose transcript ends with a tool call
whose result has not been written yet is *running*, however long that takes, so the clock
advances and the average keeps being an average. Only a turn with nothing in flight is
treated as ended (after 30 seconds), at which point the clock stops at the last activity.

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
8. **"Always on top" is not "always visible".** Topmost windows stack among themselves,
   so another always-on-top window activated later will cover this one while this one
   is still genuinely topmost. The launcher therefore *checks* the window's own
   `WS_EX_TOPMOST` style and reports it (`topmost=yes (ws_ex_topmost=yes)`) rather than
   claiming success because the API returned true — and if the style is missing, the log
   says `topmost=NO`, which is the one thing worth knowing before reporting a bug.
9. **Placement can give up, and then the window is neither placed nor pinned.** The
   launcher polls for the browser window for 90 seconds; a cold Edge start — especially
   just after its previous window was closed — can exceed that on a loaded machine. The
   log records `window not found within 90s`, and the window then appears at the
   browser's own size in the browser's own position. Relaunching places it correctly.
10. **The page is one HTML file with inline JavaScript, so nothing ran it until now.**
    `test/window-page.test.js` extracts the script and executes it against a stub DOM,
    which catches scope and logic errors — the `warn is not defined` that shipped in
    0.8.1 failed six of those assertions. It is not a browser, though: **layout, CSS and
    rendering are still only verifiable by looking at the window**, and a screenshot is
    not conclusive either, because the window can be on a virtual desktop the capture
    cannot see.
11. **Windows only, for now.** The status line, the daemon and the Codex adapter are pure
    Node and would run anywhere, and `acm install` writes `node "<posix path>"` into
    `settings.json` for exactly that reason. The *window* is not portable as it stands:
    the browser list is four `C:/Program Files/...` paths, the placement step returns
    immediately off Windows (so no pinning), and the Tauri artifact is a `.exe`. macOS
    would need the `/Applications` browser paths, a platform branch for placement, and
    `app`/`dmg` bundle targets. This is a code reading, not a test — there is no macOS
    machine here to run it on.
12. **The hook is verified on Codex, not on Claude Code desktop.** No Claude Code desktop
    app is installed on the machine this was built on, so the Claude Code side is
    verified only as file editing (schema, preservation of other hooks, byte-exact
    removal) and not as a hook that actually fires. Codex's hook was exercised against the
    real `config.toml`, and `codex doctor` accepts the result.
13. **A reused window keeps the host it was created with.** The host is part of the window's
    URL, so a window opened with no `--host` keeps asking for `auto` (dsh → codex → claude)
    even when the prompt came from Claude Code. `--if-needed` deliberately reuses a window
    rather than opening another, so to bind a window to a different host, close the current
    one — the next prompt opens a fresh one for that host. Making reuse host-aware means
    either reading the window's URL or tracking it in the daemon, and neither is worth the
    complexity until someone actually runs two hosts side by side.
14. **A browser window cannot appear at the right size instantly.** The placement script is
    started before the browser and polls every 40 ms, so the delay is down to the browser's own
    time to paint, but that is not zero — a cold start shows the window at the browser's size
    for a moment. Only `backend: "tauri"` avoids it, because the widget declares its own size
    instead of being corrected afterwards. Related: a cold browser can re-show its window after
    the placement loop finishes, which drops the pin; the loop waits for that, and the next
    prompt's repair would restore it anyway.

## Hosts

| Host | Status |
|---|---|
| **Claude Code** | the status line, `/acm` for the window, and a transcript adapter |
| **Codex CLI** | a rollout + SQLite adapter, and `acm launch --host codex`. No status line exists to hook, so the window is the renderer. |
| **dsh-tui** | needs no adapter: the dsh-budget-watcher plugin already serves the figures over HTTP, and DSH's on-disk session files are empty stubs, so that endpoint is the only real interface. The window reads it. |

The next host is whatever writes token usage somewhere readable. The pattern is one
adapter (a pure parser, tested against real recorded payloads) plus one entry in the
daemon's source list — `src/codex.mjs` and `fromCodex()` are the template.
