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
 * Place, size and pin the window in one call, as soon as it exists.
 *
 * Two defects fixed here. The script used to run 2.5 seconds after the browser was
 * spawned, so a window that ignored `--window-size` sat at its own size on screen for
 * that whole time — a blank browser filling the display, then a snap to the corner.
 * It now polls every 100 ms and applies the geometry the moment there is a handle.
 * And it is spawned with `windowsHide`, because a console window flashing on every
 * launch is not acceptable for something meant to sit quietly in a corner.
 */
function placeWindow(title) {
  if (process.platform !== "win32") return;
  const script = join(tmpdir(), "acm-place-window.ps1");
  const body = `
$deadline = (Get-Date).AddSeconds(20)
$handle = [IntPtr]::Zero
while ((Get-Date) -lt $deadline -and $handle -eq [IntPtr]::Zero) {
  $p = Get-Process -ErrorAction SilentlyContinue |
       Where-Object { $_.MainWindowTitle -like "*${title}*" } |
       Select-Object -First 1
  if ($p) { $handle = $p.MainWindowHandle }
  if ($handle -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
}
if ($handle -eq [IntPtr]::Zero) { Write-Output "window not found"; exit 0 }
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AcmWin {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@
$after = if (${CONFIG.alwaysOnTop ? "$true" : "$false"}) { [IntPtr](-1) } else { [IntPtr](-2) }
# SWP_SHOWWINDOW = 0x0040; no NOMOVE/NOSIZE, because the geometry is ours to set.
$ok = [AcmWin]::SetWindowPos($handle, $after, ${CONFIG.x}, ${CONFIG.y}, ${CONFIG.width}, ${CONFIG.height}, 0x0040)
Write-Output $(if ($ok) { "placed ${CONFIG.width}x${CONFIG.height} at ${CONFIG.x},${CONFIG.y}$(if (${CONFIG.alwaysOnTop ? "$true" : "$false"}) { ' topmost' })" } else { "SetWindowPos refused" })
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
