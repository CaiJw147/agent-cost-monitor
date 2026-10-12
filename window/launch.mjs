#!/usr/bin/env node
// Put the window on screen.
//
//   default   a browser application window (Edge or Chrome), placed and pinned by one
//             Win32 call. No toolchain, works today, but it is a browser: there is
//             chrome, and a cold start can show a blank frame before the page paints.
//   --tauri   the widget: no browser chrome, no blank frame, size and always-on-top
//             declared by the app itself. Needs the Rust build (npm run window:tauri).
//   --host h  which host this window is for (codex, dsh, claude).
//   --quiet   say nothing (used when something else is orchestrating the launch).
//
// Geometry comes from ~/.agent-cost-monitor.json — see the README's configuration
// guide — and every value is overridable by environment variable.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveConfig } from "../src/autostart.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CONFIG = resolveConfig(homedir());
const PORT = CONFIG.port;
const HOST = valueOf("--host");
const useTauri = process.argv.includes("--tauri") || CONFIG.backend === "tauri";
const quiet = process.argv.includes("--quiet");
/** Start a window only if one is not already open — the hook runs on every prompt. */
const ifNeeded = process.argv.includes("--if-needed");
/** How long the pre-flight probe waits for an existing window before deciding there is none. */
const PROBE_MS = 2500;
const say = (line) => {
  if (!quiet) process.stdout.write(line + "\n");
};

const LOG_DIR = join(homedir(), ".cache", "agent-cost-monitor");
const LOG_FILE = join(LOG_DIR, "window.log");

/** One place where "the window did not appear" becomes answerable after the fact. */
function log(message) {
  const line = `${new Date().toISOString()}  ${message}\n`;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 256 * 1024) writeFileSync(LOG_FILE, "");
    appendFileSync(LOG_FILE, line);
  } catch {
    /* a log that cannot be written is not a reason to fail a launch */
  }
}

function valueOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? String(process.argv[i + 1] ?? "").trim().toLowerCase() : "";
}

// The host rides in the URL rather than in the daemon's environment: the daemon is
// often already running from an earlier launch, and the page is what knows which host
// this particular window is for.
const URL_ = `http://127.0.0.1:${PORT}/${HOST === "" ? "" : `?host=${encodeURIComponent(HOST)}`}`;

const BROWSERS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

const TAURI_EXE = join(ROOT, "src-tauri", "target", "release", "agent-cost-monitor-window.exe");

async function daemonUp() {
  try {
    // /health, not /data: a probe must not look like a window asking for figures, or
    // `--if-needed` would decide that the window it is about to check for is already open.
    return (await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

/** Is a window already polling the daemon? Diagnostic only — see the note below. */
async function windowIsOpen() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const body = await response.json();
    return Date.now() - (Number(body.windowPolledAt) || 0) < WINDOW_ALIVE_MS;
  } catch {
    return false;
  }
}

async function ensureDaemon() {
  if (await daemonUp()) {
    log(`daemon already answering on port ${PORT}`);
    say(`daemon already answering on http://127.0.0.1:${PORT}/`);
    return;
  }
  log(`starting the daemon on port ${PORT}`);
  say(`starting the daemon on port ${PORT}`);
  const child = spawn(process.execPath, [join(HERE, "serve.mjs")], { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    if (await daemonUp()) return;
  }
  log("daemon did not come up within 5s");
  say("daemon did not come up; run `node window/serve.mjs` by hand to see why");
}

/**
 * The PowerShell that finds the window and puts it where it belongs.
 *
 * Two modes, because "place a window I just opened" and "check on the window you already
 * have" want different things:
 *
 *   `place`   apply the configured geometry, show it, pin it. Used once, right after a
 *             browser is spawned.
 *   `repair`  if the window is up, leave its position and size ALONE and only re-assert the
 *             pin; if it is hidden or minimised, restore and place it. This runs on every
 *             prompt, and applying the configured geometry there meant every prompt yanked
 *             the window back to its configured corner — so a window the user had moved was
 *             reset per prompt.
 *
 * The search is `EnumWindows`, not `Get-Process | Where MainWindowTitle`, because the latter
 * reports only a **visible** window: a hidden Edge window keeps its page running (so it kept
 * polling the daemon and `--if-needed` kept believing it was open) while being invisible to
 * that search, which left a window nothing would ever show again.
 */
function windowScriptBody(mode, timeoutMs) {
  return `
$mode = "${mode}"
$onTop = ${CONFIG.alwaysOnTop ? "$true" : "$false"}
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AcmWin {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  static IntPtr hidden = IntPtr.Zero;
  // A visible window wins; a hidden one is remembered so it can be repaired instead of
  // blocking every future prompt as "already open".
  //
  // The title must match EXACTLY, not merely contain the name. A normal browser window or tab
  // showing our page is titled "agent-cost-monitor - Profile 1 - Microsoft Edge", and a
  // substring match found that large window first, decided a window was already open, and left
  // the real one unopened — a launch that silently did nothing. Our app window and the widget
  // are both titled exactly this.
  public static IntPtr Find(string needle) {
    IntPtr visible = IntPtr.Zero; hidden = IntPtr.Zero;
    EnumWindows((h, p) => {
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (!sb.ToString().Trim().Equals(needle, StringComparison.OrdinalIgnoreCase)) return true;
      if (IsWindowVisible(h)) { if (visible == IntPtr.Zero) visible = h; }
      else if (hidden == IntPtr.Zero) hidden = h;
      return true;
    }, IntPtr.Zero);
    return visible != IntPtr.Zero ? visible : hidden;
  }
  public static bool WasHidden(IntPtr h) { return hidden != IntPtr.Zero && h == hidden; }
  // GetWindowLong rather than GetWindowLongPtr: the extended style is a 32-bit mask, and
  // the Ptr form is a macro whose A/W export differs by platform.
  public static bool IsTopmost(IntPtr h) { return (GetWindowLong(h, -20) & 0x8) != 0; }
  public static string Rect(IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    return r.L + "," + r.T + " " + (r.R - r.L) + "x" + (r.B - r.T);
  }
}
"@
$deadline = (Get-Date).AddMilliseconds(${timeoutMs})
$handle = [IntPtr]::Zero
# 40ms, not 150: this is the loop whose latency is the wrongly sized window on screen.
while ((Get-Date) -lt $deadline -and $handle -eq [IntPtr]::Zero) {
  $handle = [AcmWin]::Find("agent-cost-monitor")
  if ($handle -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 40 }
}
if ($handle -eq [IntPtr]::Zero) { Write-Output "NONE"; exit 0 }

$wasHidden = [AcmWin]::WasHidden($handle)
$minimised = [AcmWin]::IsIconic($handle)
# Geometry is ours only when the window is new or was not on screen; otherwise it belongs to
# whoever put it there.
$shouldPlace = ($mode -eq "place") -or $wasHidden -or $minimised
$after = if ($onTop) { [IntPtr](-1) } else { [IntPtr](-2) }
$move = if ($shouldPlace) { 0x0040 } else { 0x0043 }   # NOMOVE|NOSIZE when not placing
# SW_RESTORE (9) only when placing: it activates, and this runs on every prompt, so stealing
# focus there would be unacceptable. SW_SHOWNOACTIVATE (4) otherwise — without a show call the
# pin did not take on an already-visible window, which is how a repair reported topmost=no.
[void][AcmWin]::ShowWindow($handle, $(if ($shouldPlace) { 9 } else { 4 }))
[void][AcmWin]::SetWindowPos($handle, $after, ${CONFIG.x}, ${CONFIG.y}, ${CONFIG.width}, ${CONFIG.height}, $move)

if ($onTop) {
  $delays = if ($shouldPlace) { @(300, 900, 1800, 4200) } else { @(500, 1200) }
  foreach ($delay in $delays) {
    Start-Sleep -Milliseconds $delay
    $fresh = [AcmWin]::Find("agent-cost-monitor")
    if ($fresh -ne [IntPtr]::Zero) { $handle = $fresh }
    [void][AcmWin]::SetWindowPos($handle, $after, ${CONFIG.x}, ${CONFIG.y}, ${CONFIG.width}, ${CONFIG.height}, $move)
  }
}
$visible = if ([AcmWin]::IsWindowVisible($handle)) { "yes" } else { "no" }
$top = if ([AcmWin]::IsTopmost($handle)) { "yes" } else { "no" }
$placed = if ($shouldPlace) { "yes" } else { "no" }
Write-Output ("HANDLED mode=" + $mode + " placed=" + $placed + " visible=" + $visible + " topmost=" + $top + " rect=" + [AcmWin]::Rect($handle))
`;
}

/**
 * Start the placement script and resolve with its one-line verdict.
 *
 * Asynchronous on purpose. PowerShell needs a few hundred milliseconds to start, and doing
 * that *after* the browser was spawned put that delay in the middle of the visible phase —
 * which is the half second of badly sized window. The caller starts this first and spawns the
 * browser second, so the script is already polling when the window appears.
 */
function startWindowScript(mode, timeoutMs) {
  if (process.platform !== "win32") return Promise.resolve("NONE");
  const script = join(tmpdir(), `acm-window-${mode}.ps1`);
  try {
    writeFileSync(script, windowScriptBody(mode, timeoutMs));
  } catch {
    return Promise.resolve("NONE");
  }
  // windowsHide is the point: without it this spawn flashes a console window.
  const child = spawn("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", script], {
    windowsHide: true,
  });
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve("NONE");
    }, timeoutMs + 30_000);
    child.on("close", () => {
      clearTimeout(timer);
      const verdict = (out.trim() || err.trim() || "NONE").split("\n")[0].trim();
      log(`window script (${mode}): ${verdict}`);
      resolve(verdict);
    });
  });
}

async function launchTauri() {
  if (!existsSync(TAURI_EXE)) {
    log("tauri backend requested but the window is not built");
    say("  the Tauri window is not built yet — run: npm run window:tauri");
    return false;
  }
  say(`opening the Tauri window (${CONFIG.width}x${CONFIG.height} at ${CONFIG.x},${CONFIG.y})`);
  const child = spawn(TAURI_EXE, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      ACM_WINDOW_PORT: String(PORT),
      ACM_WINDOW_WIDTH: String(CONFIG.width),
      ACM_WINDOW_HEIGHT: String(CONFIG.height),
      ACM_WINDOW_X: String(CONFIG.x),
      ACM_WINDOW_Y: String(CONFIG.y),
      ACM_ALWAYS_ON_TOP: CONFIG.alwaysOnTop ? "1" : "0",
    },
  });
  child.unref();
  log(`tauri window launched ${CONFIG.width}x${CONFIG.height} at ${CONFIG.x},${CONFIG.y}, alwaysOnTop=${CONFIG.alwaysOnTop}`);

  // Then wait for its window, and say so if it never arrives.
  //
  // A widget that cannot create its window — no interactive desktop, a missing WebView2 —
  // exits at once, with its explanation on a stderr that went to /dev/null. Without this check
  // the launcher reported success and the user had no window at all: the failure mode being
  // "ACM silently does not start". Returning false hands it to the browser fallback instead.
  const probe = await startWindowScript("repair", 4000);
  if (probe.startsWith("HANDLED")) {
    say(`window ${probe}`);
    return true;
  }
  log("the tauri widget showed no window within 4s; falling back to the browser");
  return false;
}

function launchBrowser() {
  const browser = BROWSERS.find((p) => existsSync(p));
  if (browser === undefined) {
    log("no Edge or Chrome found");
    say(`no Edge or Chrome found; open ${URL_} yourself`);
    return;
  }
  say(`opening ${URL_} in ${browser.split("/").pop()} (${CONFIG.width}x${CONFIG.height} at ${CONFIG.x},${CONFIG.y})`);
  log(`launching ${browser} ${CONFIG.width}x${CONFIG.height} at ${CONFIG.x},${CONFIG.y} host=${HOST || "auto"}`);
  // Started BEFORE the browser, and this order is the whole point: PowerShell needs a few
  // hundred milliseconds to start up, and paying that after the browser was spawned put the
  // delay inside the visible phase — which is the half second of full-screen window. Started
  // first, the script is already polling every 40 ms when the window appears.
  const placement = startWindowScript("place", 90_000);
  const child = spawn(
    browser,
    [
      `--app=${URL_}`,
      `--window-size=${CONFIG.width},${CONFIG.height}`,
      `--window-position=${CONFIG.x},${CONFIG.y}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
  return placement.then((verdict) => {
    say(verdict === "NONE" ? "window not found within 90s (the browser may still be starting)" : `window ${verdict}`);
  });
}

await ensureDaemon();

// One probe, before anything is opened, which both decides and repairs.
//
// "Is a window already open?" is answered by finding the window, not by asking the daemon
// whether anything polled: a hidden Edge window keeps polling, so the poll-based answer said
// yes while there was nothing on screen to see. In `repair` mode it shows and pins what it
// finds but does NOT move it — this runs on every prompt, and re-applying the configured
// geometry each time is what reset the window's position per prompt.
const probe = await startWindowScript("repair", PROBE_MS);
const existing = probe.startsWith("HANDLED");
if (existing) {
  log(`an existing window was checked: ${probe}`);
  say(`window ${probe}`);
  if (ifNeeded) {
    log("--if-needed: an existing window is up; nothing new opened");
    say("an existing window is up; nothing new opened");
    process.exit(0);
  }
}

if (useTauri && (await launchTauri())) {
  process.exit(0);
}
if (useTauri) {
  say("  falling back to a browser window");
}

// Awaited so this process outlives the placement it started; it is detached, so nobody sees
// it wait.
await launchBrowser();
