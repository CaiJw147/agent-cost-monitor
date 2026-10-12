# Changelog

All notable changes to this project are documented in this file, together with the
[README](README.md). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.12.0] — 2026-10-12

### Changed

- **The chart now draws the way the DSH panel draws it** — the same axis, the same origin, the
  same freeze. Three differences were reported and all three are the same disagreement about
  what the picture means:

  1. **The x axis is the turn's time, not wall-clock time.** The panel records `atMs` relative
     to the turn's own start; this chart was plotting absolute timestamps and labelling them
     `HH:MM`, so a finished turn's chart slid out from under its own line. It now starts at
     `0:00`, runs to the turn's elapsed time, and **stops when the turn stops**.
  2. **The line is anchored at (0,0).** It previously began at the first settled sample, and
     that sample cannot exist until an API response reports usage — which is why nothing
     appeared for the first several seconds. `(0,0)` is prepended, exactly as the panel's
     client does.
  3. **The series is the current turn's, not the session's.** Both turns share one timeline, so
     mixing them put turn 2's samples on top of turn 1's.

  The right-hand label is now the turn's elapsed time, arrowed while the turn is still running
  (`→ 1:05`) and unarrowed once it has stopped — the panel's own convention, and the cue that
  distinguishes running from frozen. The trailing sample at the current elapsed time is appended
  **by the page**, as the panel's client does, so a live line reaches the axis edge and a frozen
  one stays frozen.

### Verified

- The payload is turn-relative on real data: the newest Claude Code turn's first sample is at
  `atMs = 0` and the series carries only that turn's points.
- Page tests cover the origin (`the first point sits on the y axis and on the baseline`),
  the arrow while live, its absence when ended, mm:ss instead of a time of day, and an empty
  series still drawing from `(0,0)`.

## [0.11.1] — 2026-10-12

### Fixed

- **A hidden window became a ghost that blocked the feature entirely.** Reported as "now ACM
  gives a blank widget with nothing, and also not floating on top", for the desktop apps and
  the CLI alike. The cause was two mistakes compounding:

  1. The placement script searched `Get-Process | Where MainWindowTitle`, which reports only
     a **visible** window. A window that had got itself hidden was therefore invisible to the
     search, so it was never placed, sized or pinned again.
  2. `--if-needed` asked the daemon whether anything had polled recently. A hidden Edge
     window **keeps its page running**, so it kept polling — the check answered "already
     open" and refused to open a new window.

  Together: a permanently invisible window, and a launcher that would not replace it. Every
  prompt confirmed the ghost.

  The search is now `EnumWindows`, which sees hidden windows too, and the probe **repairs**
  what it finds — `SWP_SHOWWINDOW` shows a hidden window, the geometry is re-applied, and
  `WS_EX_TOPMOST` is re-asserted and then verified from the window's own extended style.

  Verified on the actual broken window, live:

  ```
  before:  visible=False topmost=False 40,80 225x300
  HANDLED visible=yes wasHidden=yes topmost=yes 225x300 at 40,80
  after:   visible=True  topmost=True  40,80 225x300
  ```

  and a second probe reported `wasHidden=no` with the window still visible and pinned — the
  repair holds rather than oscillating.

### Notes

- The daemon's `/health` and its `windowPolledAt` remain, but nothing decides anything from
  them any more: a poll proves a *page* is running, not that a window can be seen.

## [0.11.0] — 2026-10-11

### Changed

- **The hook now fires on every prompt, not only at session start.** `SessionStart` alone
  works for a CLI launched per session and *fails in the desktop apps*, because those are
  long-lived: it fires once when the app opens and never again when a prompt is sent — which
  is exactly what was reported ("I don't see ACM autostarting when I sent a prompt"). Both
  hosts also expose `UserPromptSubmit` (verified present in the Codex binary, 41 hits), so
  both now get `SessionStart` **and** `UserPromptSubmit`.
- **`acm launch --if-needed`.** A per-prompt hook would otherwise stack a window on every
  prompt. The launcher asks the daemon whether a window has polled in the last five seconds
  and does nothing if one has: the page polls once a second, so a recent request *is* a live
  window. The daemon gained `GET /health` for this, and its own liveness probe moved there
  too — had it kept using `/data`, the probe itself would look like a window and
  `--if-needed` would always believe one was already open.
- **The check lives in the launcher, not in `acm`.** `acm` must return immediately because a
  hook is waiting on it, so it forwards `--if-needed` to the already-detached launcher,
  which decides. Measured: 191 ms.

### Verified

- **Idempotence, live**: `/health` reports `windowPolledAt=0` with no window open, a recent
  timestamp once one is polling, and `acm launch --if-needed` then printed "a window is
  already open" while the Edge process count stayed at 9 — no second window.
- **The upgrade path**: an entry written by 0.9.0 is replaced rather than treated as
  present, so re-running `acm hook on` is how a machine gets the new behaviour. Applied to
  both hosts here, with `codex doctor` still reporting `config loaded` and a4phone's hooks
  intact.
- 81 tests, including that the command carries `--if-needed` and that the Codex block
  contains both events.

## [0.10.0] — 2026-10-11

### Fixed

- **The chart's x-axis ended at the last settled point instead of at now.** During a long
  command no new usage is recorded, so the axis stopped minutes in the past — the reported
  screenshot showed `00:19` as the right-hand label while the clock said `00:26`. A quiet
  stretch now appears as a quiet stretch, with the current rate at the right edge. Verified
  on that same session: last settled `00:28:55`, chart's end `00:29:32`, which is now.
- **A turn with a tool call in flight was declared ended after 30 seconds.** That froze the
  clock and zeroed `β(t)` in the middle of a running turn — reported as "freezes and reports
  a wrong number when the agent is stuck on a time-demanding powershell command". Found by
  probing the transcript: a PowerShell call ran `00:26:10 → 00:27:11`, so for 61 seconds the
  newest usage-bearing entry was the message that *requested* the tool. `collectUnits` now
  reports `awaitingToolResult`, and a turn waiting on a tool is running however long it takes.
- **Overlapping polls could render a stale figure.** With `setInterval(tick, 3000)`, a request
  slower than three seconds — exactly what a large transcript produces — let the next tick
  start before the first answered, so responses could land out of order and the display
  jumped backwards.

### Changed

- **The window updates once a second** (`pollMs`, default `1000`, `ACM_POLL_MS`), down from
  every three. The page schedules its next request off the previous one *finishing* via
  `setTimeout`, which cannot overlap by construction, and the interval comes from the daemon
  so it is configured in one place.
- **The figures arithmetic moved to `src/figures.mjs`.** It lived in `window/serve.mjs`, which
  listens on import and therefore could not be tested — so the maths behind every headline
  number had no test at all. It now has eight.
- **The transcript search is remembered briefly** (2 s). At one request a second, rescanning
  every candidate file to find the one with usage was wasted work; the figures themselves are
  still recomputed on every request, so nothing shown is stale.

### Notes

- **The in-flight-tool detection is Claude Code only.** A Codex rollout's shapes for a pending
  command have not been verified, so Codex still uses the 30-second idle rule. The axis fix
  applies to both.
- 79 tests, including eight for the figures module and six for the waiting flag.

## [0.9.1] — 2026-10-11

### Fixed

- **`acm launch --dry-run started a real window.** It printed the plan and spawned the
  browser anyway, which matters more now that a hook runs this command: a flag that
  claims to change nothing must change nothing.

## [0.9.0] — 2026-10-11

### Added

- **`acm hook on|off|status [--host claude|codex|all]` — a `SessionStart` hook that
  opens the window with the session.** Both harnesses turned out to expose the same
  extension point under the same event name, and both were already using it on this
  machine: a4phone writes `[[hooks.Stop]]` into `~/.codex/config.toml`, and Claude Code's
  `~/.claude/settings.json` already carries three hooks. So this is configuration rather
  than a new mechanism, and it is the *right* mechanism — unlike the withdrawn shell
  shim, it fires on the event rather than on a command name and needs no shell-profile
  edits. Claude Code gets `hooks.SessionStart` with `matcher: "startup"` (a resume or a
  compact is not a new session); Codex gets a fenced `[[hooks.SessionStart]]` block.

### Verified

- **`codex doctor` accepts the edited config** (`config loaded`) — the TOML is valid,
  which is the one thing that had to be true and cannot be assumed from text editing.
- **Install then remove restores `~/.codex/config.toml` and `~/.claude/settings.json`
  byte for byte**, checked by SHA-256 against copies of the real files.
- **a4phone's three hooks survive** an install and a removal, and Claude Code's `hooks`
  object is not deleted while another tool still uses it.
- Idempotent (a second `acm hook on` reports "already installed" and writes nothing),
  and changing `--host` corrects the block instead of stacking a second one.
- 18 planner tests, including the trap that matters most: **TOML forbids redefining a
  table**, so appending a second `[features]` to a config that already has one would make
  the whole file unparseable and break the user's Codex. An existing `[features]` gets
  the key inserted into its body; only a missing one is appended. A first attempt also
  stripped trailing whitespace on install and collapsed blank-line runs on removal, which
  restored the real config only *approximately* — the round trip is now exact, with the
  CRLF and blank-line-run cases in the tests because the tidy synthetic file hid it.

### Notes

- **Codex will not run a hook it has not been told to trust.** Its config records a
  `trusted_hash` per hook under `[hooks.state]`, so the first session after installing
  may ask you to approve it once. That hash cannot be forged, and this does not try.
- **Removal leaves `features.hooks = true` in place**, on purpose: another tool may rely
  on the flag, and a flag that is on when it need not be is harmless where a missing one
  makes the hook silently dead.
- **The Claude Code side is untested end to end**, because no Claude Code desktop app is
  installed here — only `~/.claude` from the CLI. The Codex side was exercised against
  the real config file.

## [0.8.2] — 2026-10-11

### Fixed

- **`warn is not defined` — the window showed an error instead of any figures.**
  Shipped in 0.8.1 by me. The dot fix read `warn`, which is declared inside `chart()`,
  from `render()` — a scope error, not arithmetic. Only the no-data path worked, which
  is why it looked like a Codex-specific failure. The threshold is now read in
  `render()`'s own scope.
- **Nothing ever ran the page's script.** The window is one HTML file with inline
  JavaScript, so the build and the entire test suite could not see a runtime error in
  it. The 0.8.1 release was "verified" by reading the served HTML and comparing the
  expression's text — which was correct, and did not matter, because reading source is
  not running it. `test/window-page.test.js` now extracts that script and executes it
  against a stub DOM: ten assertions covering the dot threshold in both directions, the
  threshold coming from the payload rather than a constant, the named host, the spend
  line's five fields, the no-data path with its reasons, the approximation label, and
  the chart with an empty series. Against the broken page, six of them fail with
  `ReferenceError: warn is not defined` — checked before applying the fix, so the test
  is known to have teeth rather than assumed to.

## [0.8.1] — 2026-10-11

### Fixed

- **The status dot went amber on any spend at all, and stayed there.** It tested
  `liveBurn > 0` rather than the warning rate, so it lit up at a fraction of the
  threshold and only returned to green once the rate fell to exactly zero — which reads
  as a latch, not as a level. Reported as "once the dot goes amber it doesn't come back
  green though burn is lower than the warning value", and the live data showed it
  precisely: **3.45/h against a 15/h threshold, displayed as amber**. It now compares
  against the same `warnPerHour` the dashed line on the chart is drawn at, so the dot
  and the line cannot disagree about what "too fast" means. Verified by evaluating both
  rules against the same live payload: old `AMBER`, new `green`.

## [0.8.0] — 2026-10-11

### Changed

- **The default window is 225x300**, down from 380x600. At that width a fixed 12.5px
  line wraps, so the text now scales with the window (`clamp()` against `vw` — the
  window *is* the viewport) and stops growing again on a large one. The chart needs
  none of this: it is SVG with a viewBox, so its labels scale proportionally.
- **The live burn window is configurable, `burnWindowMs`, default `15000` (15 s)** — and
  it is read by the **Claude Code status line as well as the window**, from the same
  file, so `β(t)` cannot differ between the two renderers for the same session. It keeps
  the DSH plugin's name for the same setting rather than inventing a second one. Below
  1000 ms it clamps: a sub-second window does not measure a smaller rate, it reports
  whichever single call happened to land inside it.

### Fixed

- **The window stopped being pinned, and my own speed fix caused it.** Making placement
  fast made it apply `WS_EX_TOPMOST` to the handle that exists at ~100 ms — which can
  belong to a window the browser re-shows once the page paints, and re-showing drops the
  flag. The geometry is still applied immediately, and the topmost flag is now
  re-asserted over the next four seconds, re-finding the handle each time in case it
  changed. The script also *reads the window's extended style afterwards* and reports
  `topmost=yes (ws_ex_topmost=yes)` or `topmost=NO`, instead of reporting success
  because `SetWindowPos` returned true — verified on a real window.
- **A slow browser start left the window unplaced and unpinned.** The placement poll gave
  up after 20 seconds; a cold Edge start just after its previous window closed exceeded
  that, and the failure was silent in the log. It now waits 90 seconds and says
  `window not found within 90s` when it does.

## [0.7.0] — 2026-10-11

### Added

- **The window's geometry is configurable.** Width, height, position, always-on-top,
  warn line and port in `~/.agent-cost-monitor.json`, each with an environment
  override. Verified: a `520x340` config produced `window placed 520x340 at 900,12`.
  A zero, negative or non-numeric value falls back to the default rather than producing
  a window that cannot be seen, and a corrupt config file is ignored rather than obeyed.
- **`acm log [--lines N]`, and a log file at `~/.cache/agent-cost-monitor/window.log`.**
  The question "the window did not appear" used to be unanswerable after the fact: the
  launcher's output went to a discarded handle and nothing was written anywhere. Every
  launch, its geometry, every source resolution and every failure reason is now
  recorded, truncated past 256 KB. `acm doctor` prints the path.
- **A full configuration guide** in the README: every command, every config key, every
  environment variable, and a table of every path acm writes versus the ones it only
  reads.

### Fixed

- **A console window flashed on every launch.** The placement script was spawned
  without `windowsHide`, so a command prompt appeared each time. Spawned hidden now, and
  the spawned processes carry `windowsHide` as well.
- **The window appeared at the wrong size before snapping into place.** The placement
  call ran on a fixed 2.5-second timer, so a window that ignored `--window-size` sat
  filling the display for that whole time before jumping to the corner. It now polls
  every 100 ms and applies the geometry as soon as there is a handle — measured at
  **683 ms** from launch to placement, down from 2.5 s plus.
- **The Tauri widget ignored the configuration.** It hard-coded its own size and
  always-on-top; it now takes both from the launcher, so `backend: "tauri"` and
  `backend: "browser"` honour the same numbers.

### Notes

- The blank frame on a **cold** browser start is inherent to using a browser: Edge has
  to start before it can paint. `backend: "tauri"` avoids it entirely, which is the main
  reason to prefer the widget once it is built.

## [0.6.0] — 2026-10-11

### Added

- **A Codex adapter.** `src/codex.mjs` reads `~/.codex/sessions/**/rollout-*.jsonl` for
  the per-call cache split and `~/.codex/state_5.sqlite` for a whole-thread total when
  the rollout has none. Verified against a real 0.162.1 rollout: 18 usage records,
  priced to ¥1.4139 for the turn and ¥3.3825 for the session on `gpt-6-sol`.
- **`acm launch --host codex`**, and the host rides in the window's URL. The window now
  reads that host's source first and **names it on screen**.
- **Honest reporting when there is nothing to show.** The window lists which sources
  were tried and why each failed, and labels a figure `≈` with its reason when only an
  approximation was possible.

### Changed

- **The balance row is gone from the window.** It is DeepSeek's and only DSH can read
  it, so in a window that also serves Codex and Claude Code it was a figure about a
  different provider than the one being measured — and one that would never move for
  two of the three hosts. Cost and burn rate are the whole job.
- **Auto-launch is withdrawn.** Wrapping `codex` and `dsh-tui` in a PowerShell function
  meant editing two profile files to save one command, and the window it opened was
  showing another host's numbers half the time. Nothing writes a shim any more;
  `acm clean-profiles` and `acm uninstall` still remove one written by an earlier
  version, because a withdrawn feature has to stay reversible on machines that ran it.

### Fixed

- **The burn chart's series was a running total, not a windowed rate.** Every call was
  added to one accumulator and nothing was ever removed as it aged out, so the line
  climbed forever — the opposite of what a burn rate is for. On the dsh source it read
  **6,146/h instead of 11.88/h**. Caught by reading an implausible axis label off a
  screenshot, not by a test; the windowed rate is now a trailing two-pointer window,
  with a test-shaped assertion comparing the cumulative figure against the real one.
- **One synchronous source broke every source.** The Claude Code reader returns a plain
  object, so chaining `.catch()` onto its result threw — and that error propagated out
  of the fallback loop, so asking for `--host claude` reported "no data" while dsh was
  answering fine one line later. Sources are now `await`ed, which handles both shapes.
- **The auto-launch message named hosts it no longer wrapped**, and `dsh-tui`
  reported "nothing to remove" as a failure once uninstall ran for every host.

## [0.5.0] — 2026-10-11

### Changed

- **Claude Code is no longer wrapped by auto-launch.** Its status line already shows
  these figures *inside* the tool, so a window riding along with `claude` was noise on
  top of a row that works. `codex` and `dsh-tui` keep the shim — they have no such
  row, which is the whole reason the window exists. The filter lives in
  `shimHosts()` rather than only in the defaults, so a config written before this
  decision cannot bring it back, and `/acm` remains for anyone who wants the window
  anyway.
- **`acm uninstall` is now total.** It previously removed one host; now it removes
  every host, both profile blocks, the `/acm` command, the config and the pricing
  cache — because a trail of edits across a settings file, two shell profiles and a
  command directory is what stops people installing something at all. `--host` still
  narrows it, `--keep-cache` leaves the cache, and `--self` also runs
  `npm uninstall -g agent-cost-monitor`, which is the one thing acm cannot quietly do
  from under its own feet.

### Fixed

- **"Not installed" stopped being reported as a failure.** With uninstall running for
  every host, `dsh-tui` will usually have nothing to remove; asking pnpm to remove a
  package that was never added reported a problem that was not one.
- **The auto-launch message named the wrong hosts.** It still said "typing `claude` or
  `codex`", which stopped being true the moment Claude Code was unwrapped. It is
  generated from the hosts actually shimmed.

### Verified

- **The whole thing reverses.** Ran `acm uninstall` for real and confirmed afterwards
  that the `statusLine`, both profile blocks, `~/.claude/commands/acm.md`,
  `~/.agent-cost-monitor.json` and `~/.cache/spend-watch` were all gone and that the
  unrelated settings (a4phone's three hooks, the whole `env` block) survived; then
  restored with `acm install` and confirmed a fresh shell resolves the way it should.
- **Command resolution, in a fresh shell with the profile loaded**: `claude` →
  `[ExternalScript]`, `codex` → `[Function]`, `dsh-tui` → `[Function]`, `acm` →
  `[ExternalScript]` from `%APPDATA%\npm`. That pairing is the proof: the shim wins
  where it should, and *does not* where it was removed.
- **`acm` is on PATH the way any global npm package is** — `npm link` produced
  `acm.ps1`, `acm.cmd` and `agent-cost-monitor.*` in `%APPDATA%\npm`, which is what
  `npm install -g` does for a new user with no configuration.

## [0.4.0] — 2026-10-11

### Added

- **Auto-launch: typing `claude` or `codex` brings the window up with it.** Neither
  harness lets a third party react to "the user started the CLI" — Codex's slash
  commands are a fixed registry (verified in its binary: no custom-prompt loader, and
  `custom prompt` appears zero times) and Claude Code's `statusLine` is a rendering
  hook, not a lifecycle one. So the shim uses the one mechanism needing no
  cooperation: a PowerShell **function** in the user's profile. PowerShell resolves a
  function ahead of an ExternalScript or Application, and `claude` and `codex` are npm
  shims, so a function of the same name wins — it starts the window, then hands over
  to the real command with its arguments untouched. Both profile files are written,
  because PowerShell 5.1 and 7 keep separate ones, and the block is fenced so
  `acm autostart off` removes exactly it.
- **`acm autostart on|off|status`**, and `acm launch [--quiet]` — what the shim calls.
  The launch is detached and `unref`'d so the harness starts at the same speed whether
  the window appears or not, and every failure path inside the shim falls through to
  running the real command: **a broken spend window must never stop someone's agent
  from starting.**
- **`/acm` inside Claude Code**, written to `~/.claude/commands/acm.md`. Its body is a
  plain instruction rather than a `!` shell expansion, because how a slash command
  executes shell text has varied across versions and an instruction works either way.
  It is written whether auto-launch is on or off — with it off, this is the whole
  mechanism.
- **Configuration at `~/.agent-cost-monitor.json`** (`autoLaunch`, `hosts`, `backend`),
  so the behaviour is something to edit rather than a flag to remember. `acm install`
  turns auto-launch on for a fresh install and **respects a deliberate `false`** on a
  re-install; `--no-autostart` leaves your profiles alone entirely.

### Notes

- **Codex has no custom slash commands, so `/acm` cannot exist there.** What it does
  have is the `!cmd` shell escape — verified in its binary, *"Run from Codex using `!`
  (e.g. `!ls`)"* — so inside Codex the command is `!acm launch`. The installer says
  this rather than writing a prompt file that would sit there doing nothing.
- **Written into a shell profile, so the generated text is tested and parse-checked.**
  The block is validated with PowerShell's own parser (0 errors) and the shim is
  confirmed to resolve: `Get-Command claude` returns a Function while
  `-CommandType ExternalScript,Application` still finds `claude.ps1`, which is what
  proves there is no recursion into itself.

## [0.3.0] — 2026-10-11

### Added

- **A window: the same figures, outside the TUI.** `window/serve.mjs` is a local
  daemon that serves one page and one JSON endpoint; `window/index.html` draws the
  balance, the one-line figures and the **burn chart** — the windowed rate over
  time, with the warn line across it — in the same visual language as the DSH panel.
  Two data sources, in order: the DSH plugin's own HTTP route when it answers (the
  dsh-tui path, which already carries the balance and the series), otherwise the
  newest Claude Code transcript priced by the same engine.
- **Two ways to put it on screen.** `node window/launch.mjs` uses an Edge or Chrome
  application window pinned always-on-top by `SetWindowPos` — no toolchain, works
  today. `node window/launch.mjs --tauri` builds and runs the real widget under
  `src-tauri/`, which needs no browser chrome and declares `always_on_top` in Rust.
  Both read the same daemon, so the data path is identical.
- **The Tauri project**, with icons generated from the panel screenshot, a
  frameless-capable config, and `Cargo.toml` sized for a small release binary.

### Fixed

- **Three bugs the screenshot caught that no test would have.** `FindWindow(null,
  title)` does not reliably match a browser's app window, and Edge ignores
  `--window-position` when restoring window state — so the window opened
  off-position and was never pinned; it now goes through the process's
  `MainWindowHandle` with a retry, and `SetWindowPos` carries the geometry. The
  headline burn rate was computed at the *last settled point* rather than *now*,
  so an idle session looked like it was still spending. And `$("balance").innerHTML`
  replaces the element's children, which destroyed the `<small id="balnote">` the
  very next line set `textContent` on — an exception mid-render that left the
  initial "waiting for data…" on screen while the balance above it updated. The
  render is now wrapped so a widget shows what broke instead of freezing.

### Notes

- **Codex CLI 0.162.1 keeps token usage in `state_5.sqlite`, not the rollout** (see
  the README's next-hosts note). `threads` carries `model`, `model_provider` and
  `tokens_used`. Verified against real rows: 3,272,214 and 316,945 tokens on
  `gpt-6-astra`, 215,984 on `codex-auto-review`, and 0 on the newest thread — whose
  `error_json` reads *"You've hit your usage limit"*, so the run was refused rather
  than unrecorded.

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
