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
    return (await fetch(`http://127.0.0.1:${PORT}/data`, { signal: AbortSignal.timeout(1500) })).ok;
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
 * Place, size and pin the window, as soon as it exists — then keep asserting it.
 *
 * Three defects have been fixed here, each found by looking rather than by testing.
 * The script used to run on a fixed 2.5-second timer, so a window that ignored
 * `--window-size` sat filling the display before snapping to the corner; it now polls
 * every 100 ms. It was spawned without `windowsHide`, so a console flashed; it is
 * hidden now. And applying the flag that early turned out to lose it: the handle that
 * exists at 100 ms can belong to a window the browser re-shows once the page paints,
 * and re-showing drops WS_EX_TOPMOST — which is why the window stopped staying on top
 * exactly when the placement got fast. So the geometry is applied immediately and the
 * topmost flag is re-asserted over the next few seconds, re-finding the handle each
 * time in case it changed.
 *
 * The script also *checks* the extended style afterwards and says so, rather than
 * reporting success because SetWindowPos returned true.
 */
function placeWindow(title) {
  if (process.platform !== "win32") return;
  const script = join(tmpdir(), "acm-place-window.ps1");
  const body = `
$onTop = ${CONFIG.alwaysOnTop ? "$true" : "$false"}
$find = {
  $p = Get-Process -ErrorAction SilentlyContinue |
       Where-Object { $_.MainWindowTitle -like "*${title}*" } |
       Select-Object -First 1
  if ($p) { return $p.MainWindowHandle } else { return [IntPtr]::Zero }
}
$deadline = (Get-Date).AddSeconds(90)
$handle = [IntPtr]::Zero
while ((Get-Date) -lt $deadline -and $handle -eq [IntPtr]::Zero) {
  $handle = & $find
  if ($handle -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 200 }
}
# 90 seconds, not 20: a browser started cold — especially just after its previous
# window was closed — can take far longer than 20s to show the app window, and giving
# up early leaves the window unplaced AND unpinned, which is worse than waiting.
if ($handle -eq [IntPtr]::Zero) { Write-Output "window not found within 90s (the browser may still be starting)"; exit 0 }

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AcmWin {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  // GetWindowLong rather than GetWindowLongPtr: the extended style is a 32-bit mask,
  // and the Ptr form is a macro whose A/W export differs by platform.
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  public static bool IsTopmost(IntPtr h) {
    return (GetWindowLong(h, -20) & 0x8) != 0;   // GWL_EXSTYLE, WS_EX_TOPMOST
  }
}
"@
$after = if ($onTop) { [IntPtr](-1) } else { [IntPtr](-2) }
# 0x0040 = SWP_SHOWWINDOW. No NOMOVE/NOSIZE: the geometry is ours to set.
[void][AcmWin]::SetWindowPos($handle, $after, ${CONFIG.x}, ${CONFIG.y}, ${CONFIG.width}, ${CONFIG.height}, 0x0040)

if ($onTop) {
  foreach ($delay in @(600, 1200, 2400, 4000)) {
    Start-Sleep -Milliseconds $delay
    $fresh = & $find
    if ($fresh -ne [IntPtr]::Zero) { $handle = $fresh }
    [void][AcmWin]::SetWindowPos($handle, $after, ${CONFIG.x}, ${CONFIG.y}, ${CONFIG.width}, ${CONFIG.height}, 0x0040)
  }
  $state = if ([AcmWin]::IsTopmost($handle)) { "topmost=yes" } else { "topmost=NO" }
} else {
  $state = "topmost=off (configured)"
}
$check = if ([AcmWin]::IsTopmost($handle)) { "yes" } else { "no" }
Write-Output "placed ${CONFIG.width}x${CONFIG.height} at ${CONFIG.x},${CONFIG.y} $state (ws_ex_topmost=$check)"
`;
  try {
    writeFileSync(script, body);
  } catch {
    return;
  }
  // windowsHide is the point: without it this spawn flashes a console window.
  const result = spawnSync("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  const outcome = (result.stdout ?? "").trim() || (result.stderr ?? "").trim() || "no output";
  log(`browser window ${outcome}`);
  say(`window ${outcome}`);
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
  // Immediately, not after a delay: the browser may ignore the geometry it was given,
  // and every millisecond before this lands is a wrong-sized window on screen.
  placeWindow("agent-cost-monitor");
}

if (useTauri && launchTauri()) {
  process.exit(0);
}
if (useTauri) {
  say("  falling back to a browser window");
}

await ensureDaemon();
launchBrowser();
