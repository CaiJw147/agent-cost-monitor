#!/usr/bin/env node
// Put the window on screen.
//
//   default   a browser application window (Edge or Chrome), made always-on-top by
//             one Win32 call. No toolchain, works today.
//   --tauri   the real widget: no browser chrome, own process, always-on-top by
//             configuration. Needs the Tauri CLI and a Rust build.
//   --host h  which host this window is for (codex, dsh, claude): the page asks the
//             daemon for that source first, so a Codex window does not quietly show
//             Claude Code's numbers.
//
// Both backends point at the same local daemon, so the data path is identical.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PORT = Number(process.env.ACM_WINDOW_PORT ?? 7420);
const HOST = (() => {
  const i = process.argv.indexOf("--host");
  return i >= 0 ? String(process.argv[i + 1] ?? "").trim().toLowerCase() : "";
})();
// The host rides in the URL rather than in the daemon's environment: the daemon is
// often already running from an earlier launch, and the page is what knows which host
// this particular window is for.
const URL_ = `http://127.0.0.1:${PORT}/${HOST === "" ? "" : `?host=${encodeURIComponent(HOST)}`}`;
const useTauri = process.argv.includes("--tauri");
const say = (line) => process.stdout.write(line + "\n");

const BROWSERS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

async function daemonUp() {
  try {
    const probe = await fetch(`http://127.0.0.1:${PORT}/data`, { signal: AbortSignal.timeout(1500) });
    return probe.ok;
  } catch {
    return false;
  }
}

async function ensureDaemon() {
  if (await daemonUp()) {
    say(`daemon already answering on ${URL_}`);
    return;
  }
  say(`starting the daemon on port ${PORT}`);
  const child = spawn(process.execPath, [join(HERE, "serve.mjs")], { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    if (await daemonUp()) return;
  }
  say("daemon did not come up; run `node window/serve.mjs` by hand to see why");
}

/**
 * Pin the window above everything else, and place it ourselves.
 *
 * Two things learned the hard way. `FindWindow(null, title)` does not reliably
 * match a browser's app window, so this goes through the process's
 * MainWindowHandle instead — retrying, because the handle is zero until the
 * window exists. And Edge ignores `--window-position` when it restores prior
 * window state, so SetWindowPos carries the geometry and we do not pass
 * SWP_NOMOVE/SWP_NOSIZE: the position is ours to choose, not the browser's.
 *
 * Written to a file rather than passed as -Command: PowerShell here-strings mangle
 * embedded quotes, and this script is mostly quotes.
 */
function makeTopmost(title, { x = 40, y = 80, w = 380, h = 600 } = {}) {
  if (process.platform !== "win32") return undefined;
  const ps = join(tmpdir(), "acm-topmost.ps1");
  const script = `
$deadline = (Get-Date).AddSeconds(20)
$handle = [IntPtr]::Zero
while ((Get-Date) -lt $deadline -and $handle -eq [IntPtr]::Zero) {
  $p = Get-Process -ErrorAction SilentlyContinue |
       Where-Object { $_.MainWindowTitle -like "*${title}*" } |
       Select-Object -First 1
  if ($p) { $handle = $p.MainWindowHandle }
  if ($handle -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 400 }
}
if ($handle -eq [IntPtr]::Zero) { Write-Output "window not found"; exit 0 }
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AcmWin {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@
# HWND_TOPMOST = -1, SWP_SHOWWINDOW = 0x0040
$ok = [AcmWin]::SetWindowPos($handle, [IntPtr](-1), ${x}, ${y}, ${w}, ${h}, 0x0040)
Write-Output $(if ($ok) { "topmost at ${x},${y} ${w}x${h}" } else { "SetWindowPos refused" })
`;
  try {
    writeFileSync(ps, script);
  } catch {
    return undefined;
  }
  return ps;
}

function launchBrowser() {
  const browser = BROWSERS.find((p) => existsSync(p));
  if (browser === undefined) {
    say("no Edge or Chrome found; open " + URL_ + " yourself");
    return;
  }
  say(`opening ${URL_} in ${browser.split("/").pop()}`);
  const child = spawn(
    browser,
    [`--app=${URL_}`, "--window-size=380,600", "--window-position=40,80", "--no-first-run", "--no-default-browser-check"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  // Give the window a moment to exist, then pin it above everything else.
  setTimeout(() => {
    const ps = makeTopmost("agent-cost-monitor", { x: 40, y: 80, w: 380, h: 600 });
    if (ps === undefined) return;
    const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps], { encoding: "utf8" });
    say(`always-on-top: ${(result.stdout ?? "").trim() || (result.stderr ?? "").trim() || "no output"}`);
    say("close it like any window; it is a browser window, so nothing is left running");
  }, 2500);
}

if (useTauri) {
  say("building and running the Tauri window (first build compiles Rust; expect minutes)");
  const run = spawnSync("npx", ["tauri", "dev"], { cwd: ROOT, shell: true, stdio: "inherit" });
  process.exit(run.status ?? 1);
}

await ensureDaemon();
launchBrowser();
