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
 * Find the window, then make it visible, correctly sized and pinned.
 *
 * Returns the script's one-line verdict: `NONE`, or `HANDLED visible=… wasHidden=… …`.
 *
 * Four defects have been fixed in this script, each found by looking at a real window:
 * the placement ran on a fixed 2.5 s timer, so a window that ignored `--window-size` sat
 * filling the display first; it was spawned without `windowsHide`, so a console flashed;
 * and applying `WS_EX_TOPMOST` too early lost the flag, because the handle that exists at
 * ~100 ms can belong to a window the browser re-shows once the page paints — so the flag
 * is re-asserted over the next few seconds.
 *
 * The fourth is the worst, and it is why this function now returns something. The search
 * was `Get-Process | Where MainWindowTitle`, which reports only a **visible** window. An
 * Edge window that gets hidden keeps its page running, so it keeps polling the daemon —
 * which made `--if-needed` believe a window was open — while being invisible to that
 * search, so nothing would ever show it again. The result was a permanently invisible
 * window and a launcher that refused to open a new one: every prompt confirmed the ghost.
 * The search is now `EnumWindows`, which sees hidden windows, and `SWP_SHOWWINDOW` brings
 * one back rather than leaving it behind.
 */
function runWindowScript(timeoutMs) {
  if (process.platform !== "win32") return "NONE";
  const script = join(tmpdir(), "acm-place-window.ps1");
  const body = `
$onTop = ${CONFIG.alwaysOnTop ? "$true" : "$false"}
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AcmWin {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  static IntPtr hidden = IntPtr.Zero;
  // A visible window wins; a hidden one is remembered so it can be repaired instead of
  // blocking every future prompt as "already open".
  public static IntPtr Find(string needle) {
    IntPtr visible = IntPtr.Zero; hidden = IntPtr.Zero;
    EnumWindows((h, p) => {
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (sb.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) return true;
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
}
"@
$deadline = (Get-Date).AddMilliseconds(${timeoutMs})
$handle = [IntPtr]::Zero
while ((Get-Date) -lt $deadline -and $handle -eq [IntPtr]::Zero) {
  $handle = [AcmWin]::Find("${"agent-cost-monitor"}")
  if ($handle -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 150 }
}
if ($handle -eq [IntPtr]::Zero) { Write-Output "NONE"; exit 0 }
$wasHidden = [AcmWin]::WasHidden($handle)
$after = if ($onTop) { [IntPtr](-1) } else { [IntPtr](-2) }
# 0x0040 = SWP_SHOWWINDOW, which both shows a hidden window and keeps a visible one up.
# No NOMOVE/NOSIZE: the geometry is ours to set.
[void][AcmWin]::SetWindowPos($handle, $after, ${CONFIG.x}, ${CONFIG.y}, ${CONFIG.width}, ${CONFIG.height}, 0x0040)
if ($onTop) {
  foreach ($delay in @(400, 1200, 2400)) {
    Start-Sleep -Milliseconds $delay
    $fresh = [AcmWin]::Find("${"agent-cost-monitor"}")
    if ($fresh -ne [IntPtr]::Zero) { $handle = $fresh }
    [void][AcmWin]::SetWindowPos($handle, $after, ${CONFIG.x}, ${CONFIG.y}, ${CONFIG.width}, ${CONFIG.height}, 0x0040)
  }
}
$visible = if ([AcmWin]::IsWindowVisible($handle)) { "yes" } else { "no" }
$top = if ([AcmWin]::IsTopmost($handle)) { "yes" } else { "no" }
$was = if ($wasHidden) { "yes" } else { "no" }
Write-Output ("HANDLED visible=" + $visible + " wasHidden=" + $was + " topmost=" + $top + " ${CONFIG.width}x${CONFIG.height} at ${CONFIG.x},${CONFIG.y}")
`;
  try {
    writeFileSync(script, body);
  } catch {
    return "NONE";
  }
  // windowsHide is the point: without it this spawn flashes a console window.
  const result = spawnSync("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs + 30_000,
  });
  const outcome = (result.stdout ?? "").trim() || (result.stderr ?? "").trim() || "NONE";
  log(`window script: ${outcome}`);
  return outcome.split("\n")[0].trim();
}

function launchTauri() {
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
  return true;
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
  // Immediately, not after a delay: the browser may ignore the geometry it was given, and
  // every millisecond before this lands is a wrong-sized window on screen. The long
  // timeout is for a cold browser, which can take far longer than a warm one to show it.
  const verdict = runWindowScript(90_000);
  say(verdict === "NONE" ? "window not found within 90s (the browser may still be starting)" : `window ${verdict}`);
}

await ensureDaemon();

// One probe, before anything is opened, which both decides and repairs.
//
// "Is a window already open?" is answered by finding the window, not by asking the daemon
// whether anything polled: a hidden Edge window keeps polling, so the poll-based answer
// said yes while there was nothing on screen to see. The probe finds a window (visible or
// not), shows it, sizes it, pins it — and a hidden one comes back rather than blocking
// every future prompt.
const probe = runWindowScript(PROBE_MS);
const existing = probe.startsWith("HANDLED");
if (existing) {
  log(`an existing window was placed: ${probe}`);
  say(`window ${probe}`);
  if (ifNeeded) {
    log("--if-needed: an existing window was placed; nothing new opened");
    say("an existing window was placed; nothing new opened");
    process.exit(0);
  }
}

if (useTauri && launchTauri()) {
  process.exit(0);
}
if (useTauri) {
  say("  falling back to a browser window");
}

launchBrowser();
