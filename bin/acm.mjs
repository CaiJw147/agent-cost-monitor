#!/usr/bin/env node
// acm — one command to put the spend line in front of whichever agent you run.
//
//   npx agent-cost-monitor install        # detect, then configure what is there
//   npx agent-cost-monitor status         # what is detected, what is configured
//   npx agent-cost-monitor uninstall      # remove only what we added
//
// Downloading, detecting and installing are deliberately three separate steps:
// nothing is fetched until a host is found that needs it, and nothing is written
// until the plan for that host is known.

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describeHosts, looksLikePluginDir, planClaudeInstall, planClaudeUninstall, pluginSpec } from "../src/install.mjs";
import {
  DEFAULT_HOSTS,
  applyBlock,
  buildShimBlock,
  claudeCommandFile,
  claudeCommandPath,
  configPath,
  hasBlock,
  mergeConfig,
  profilePaths,
  removeBlock,
  shimHosts,
} from "../src/autostart.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const STATUSLINE = join(PACKAGE_ROOT, "claude", "statusline.mjs");
const CACHE_DIR = join(homedir(), ".cache", "agent-cost-monitor");
const PRICING_CACHE = process.env.SPEND_WATCH_CACHE ?? join(homedir(), ".cache", "spend-watch");

const DSH_PROFILE = process.env.ACM_DSH_PROFILE ?? "dsh-tui";
const PLUGIN_REPO = process.env.ACM_PLUGIN_REPO ?? "https://github.com/NeutronStar714/dsh-budget-watcher";
const LAUNCH_SCRIPT = join(PACKAGE_ROOT, "window", "launch.mjs");
const CONFIG_FILE = configPath(homedir());
const WINDOW_URL = `http://127.0.0.1:${process.env.ACM_WINDOW_PORT ?? 7420}/`;

const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith("-")) ?? "status";
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const hostArg = option("host") ?? "auto";
const dryRun = flag("dry-run");
const force = flag("force");
const noAutostart = flag("no-autostart");
const say = (line = "") => process.stdout.write(line + "\n");

const settingsPath = () => join(homedir(), ".claude", "settings.json");

/**
 * One command line, through the shell.
 *
 * A single string rather than an args array on purpose. On Windows `dsh` and
 * `claude` are shell shims, so a shell is required — and passing an array *with*
 * `shell: true` makes Node warn (DEP0190), because the arguments are concatenated
 * rather than escaped. Callers quote what needs quoting.
 */
function run(commandLine, { inherit = false } = {}) {
  return spawnSync(commandLine, { shell: true, stdio: inherit ? "inherit" : "ignore", timeout: 120_000 });
}

function hasCommand(name) {
  return run(`${name} --version`).status === 0;
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// --------------------------------------------------------------- detection ---

function detectClaude() {
  const path = settingsPath();
  const present = existsSync(path);
  const settings = present ? readJson(path, undefined) : {};
  const status = settings === undefined ? "unreadable settings.json" : settings.statusLine === undefined ? "not configured" : "configured";
  return {
    detected: present || hasCommand("claude"),
    settingsPath: path,
    settings,
    status,
    detail: settings?.statusLine === undefined ? `no statusLine in ${path}` : `statusLine -> ${settings.statusLine.command}`,
  };
}

function detectDsh() {
  const profileDir = join(homedir(), ".dsh", "profiles", DSH_PROFILE);
  const installed = existsSync(join(profileDir, "node_modules", "dsh-budget-watcher"));
  return {
    detected: hasCommand("dsh-tui") || existsSync(profileDir),
    profileDir,
    installed,
    status: installed ? `installed in profile "${DSH_PROFILE}"` : `not installed in profile "${DSH_PROFILE}"`,
    detail: `profile ${profileDir}`,
  };
}

function detectCodex() {
  return { detected: existsSync(join(homedir(), ".codex", "config.toml")), status: "unsupported" };
}

// -------------------------------------------------------------- claude code ---

function writeSettings(path, settings) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(path, `${path}.bak-${stamp}`);
    say(`  backed up to ${path}.bak-${stamp}`);
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

function claudeInstall(claude) {
  if (claude.settings === undefined) {
    say("  skipped: settings.json exists but does not parse as JSON");
    return 1;
  }
  const plan = planClaudeInstall(claude.settings, STATUSLINE, { force });
  say(`  ${plan.message}`);
  if (plan.action === "conflict") return 1;
  if (plan.action === "unchanged" || dryRun) return 0;
  writeSettings(claude.settingsPath, plan.settings);
  return 0;
}

function claudeUninstall(claude) {
  if (claude.settings === undefined) return 1;
  const plan = planClaudeUninstall(claude.settings);
  say(`  ${plan.message}`);
  if (plan.action === "unchanged" || dryRun) return 0;
  writeSettings(claude.settingsPath, plan.settings);
  return 0;
}

// ------------------------------------------------------------------ dsh-tui ---

/** The plugin is a separate repository, so fetch it if it is not already around. */
function ensurePlugin() {
  const local = process.env.ACM_PLUGIN_DIR;
  if (local !== undefined && looksLikePluginDir(readJson(join(local, "package.json"), {}))) return local;

  // A sibling checkout is the normal case when working on both at once.
  const sibling = resolve(PACKAGE_ROOT, "..", "dsh-budget-watcher");
  if (looksLikePluginDir(readJson(join(sibling, "package.json"), {}))) return sibling;

  const cached = join(CACHE_DIR, "dsh-budget-watcher");
  if (looksLikePluginDir(readJson(join(cached, "package.json"), {}))) return cached;

  if (dryRun) {
    say(`  would clone ${PLUGIN_REPO} into ${cached}`);
    return cached;
  }
  say(`  downloading the plugin into ${cached}`);
  mkdirSync(dirname(cached), { recursive: true });
  const clone = run(`git clone --depth 1 "${PLUGIN_REPO}" "${cached}"`, { inherit: true });
  if (clone.status !== 0) {
    say("  clone failed — is git installed and the repository reachable?");
    return undefined;
  }
  return cached;
}

function dshInstall() {
  if (!hasCommand("dsh")) {
    say("  skipped: the dsh command is not on PATH");
    return 1;
  }
  const pluginDir = ensurePlugin();
  if (pluginDir === undefined) return 1;
  say(`  plugin at ${pluginDir}`);
  if (dryRun) {
    say(`  would run: dsh plugin --profile ${DSH_PROFILE} add ${pluginSpec(pluginDir)}`);
    return 0;
  }
  const add = run(`dsh plugin --profile ${DSH_PROFILE} add "${pluginSpec(pluginDir)}"`, { inherit: true });
  if (add.status !== 0) {
    say("  `dsh plugin add` failed; the profile was left as it was");
    return 1;
  }
  say(`  installed into profile "${DSH_PROFILE}"`);
  say("  note: this gives DSH the cost data and its HTTP route. dsh-tui has no");
  say("        status row to draw it in yet, so nothing appears in the terminal.");
  return 0;
}

function dshUninstall(installed) {
  if (!hasCommand("dsh")) {
    say("  the dsh command is not on PATH; nothing to remove here");
    return 0;
  }
  // Uninstall now runs for every host, so "not installed" is the normal case rather
  // than a failure — asking pnpm to remove a package that was never added would
  // report a problem that is not one.
  if (installed !== true) {
    say(`  nothing of ours in profile "${DSH_PROFILE}"`);
    return 0;
  }
  if (dryRun) {
    say(`  would run: dsh plugin --profile ${DSH_PROFILE} remove dsh-budget-watcher`);
    return 0;
  }
  return run(`dsh plugin --profile ${DSH_PROFILE} remove dsh-budget-watcher`, { inherit: true }).status === 0 ? 0 : 1;
}

// ------------------------------------------------------------------- status ---

function pricingCache() {
  const file = join(PRICING_CACHE, "claude-pricing.json");
  const cache = readJson(file, undefined);
  if (cache === undefined) return `  pricing cache: none yet at ${file} (the first run fetches it)`;
  const age = Number.isFinite(Date.parse(cache.fetchedAt)) ? Math.round((Date.now() - Date.parse(cache.fetchedAt)) / 3_600_000) : undefined;
  return `  pricing cache: ${Object.keys(cache.models ?? {}).length} models, USD->CNY ${cache.usdToCny ?? "unknown"}, ${age === undefined ? "age unknown" : `${age}h old`}`;
}

function status() {
  const hosts = { claude: detectClaude(), dsh: detectDsh(), codex: detectCodex() };
  say(describeHosts(hosts));
  say(pricingCache());
  return 0;
}

// --------------------------------------------------------------- autostart ---

function readConfig() {
  return readJson(CONFIG_FILE, undefined);
}

function writeConfig(next) {
  try {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** Start the window now. This is what the shell shim and `/acm` call. */
function launch({ quiet }) {
  if (!existsSync(LAUNCH_SCRIPT)) {
    if (!quiet) say(`  the window is not in this install (${LAUNCH_SCRIPT} is missing)`);
    return 1;
  }
  // Detached and unref'd: the harness must start at the same speed whether the
  // window comes up or not, and a GUI process must never hold this one open.
  spawn(process.execPath, [LAUNCH_SCRIPT], { detached: true, stdio: "ignore" }).unref();
  if (!quiet) say(`  window starting at ${WINDOW_URL}`);
  return 0;
}

/** The `/acm` command, for the harness whose slash commands are extensible. */
function writeClaudeCommand() {
  const path = claudeCommandPath(homedir());
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, claudeCommandFile());
    say(`  /acm      ${path}`);
    return true;
  } catch (error) {
    say(`  /acm      failed: ${error.message}`);
    return false;
  }
}

/**
 * Put the shim into the user's PowerShell profiles.
 *
 * Both of them, because 5.1 and 7 are separate files. Idempotent by construction:
 * the block is fenced and `applyBlock` replaces it in place, so re-running after the
 * package moves corrects the paths instead of stacking a second copy.
 */
function autostartOn(config) {
  const hosts = shimHosts(config.hosts);
  const block = buildShimBlock({ hosts, acmEntry: join(HERE, "acm.mjs"), nodePath: process.execPath });
  let written = 0;
  for (const path of profilePaths(homedir())) {
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const already = hasBlock(existing);
    if (already && existing.includes(block)) {
      say(`  unchanged ${path}`);
      continue;
    }
    if (dryRun) {
      say(`  would ${already ? "update" : "add"} the block in ${path}`);
      continue;
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, applyBlock(existing, block));
      written += 1;
      say(`  ${already ? "updated  " : "added    "} ${path}`);
    } catch (error) {
      say(`  failed    ${path}: ${error.message}`);
    }
  }
  if (written === 0 && !dryRun) say("  (already in place)");
  return written;
}

function autostartOff() {
  let removed = 0;
  for (const path of profilePaths(homedir())) {
    if (!existsSync(path)) continue;
    const existing = readFileSync(path, "utf8");
    if (!hasBlock(existing)) continue;
    if (dryRun) {
      say(`  would remove the block from ${path}`);
      continue;
    }
    writeFileSync(path, removeBlock(existing).text);
    removed += 1;
    say(`  removed   ${path}`);
  }
  if (removed === 0 && !dryRun) say("  (nothing of ours in either profile)");
  return removed;
}

function autostartStatus(config) {
  for (const path of profilePaths(homedir())) {
    const present = existsSync(path) && hasBlock(readFileSync(path, "utf8"));
    say(`  ${present ? "installed" : "absent   "}  ${path}`);
  }
  say(`  config: autoLaunch=${config.autoLaunch}  hosts=${(config.hosts ?? DEFAULT_HOSTS).join(", ")}`);
  say(`  config file: ${CONFIG_FILE}`);
  return 0;
}

/**
 * Undo everything acm wrote, in one command.
 *
 * A trail of edits across a settings file, two shell profiles, a slash-command
 * directory and a cache is exactly what stops people installing something at all, so
 * `uninstall` means *all of it* rather than whichever host happens to be the default.
 * The package itself is the one thing acm cannot quietly delete from under its own
 * feet, so it is printed, and `--self` does it anyway.
 */
function removeEverything({ self, keepCache }) {
  let failures = 0;

  say("\nauto-launch");
  autostartOff();

  say("\n/acm");
  const commandFile = claudeCommandPath(homedir());
  failures += removePath(commandFile, "file");

  say("\nconfig");
  failures += removePath(CONFIG_FILE, "file");

  if (!keepCache) {
    say("\npricing cache");
    failures += removePath(PRICING_CACHE, "dir");
  }

  say("\nthe package itself");
  if (self) {
    if (dryRun) say("  would run: npm uninstall -g agent-cost-monitor");
    else {
      const removed = run("npm uninstall -g agent-cost-monitor", { inherit: true });
      if (removed.status === 0) say("  removed the global package");
      else {
        say("  npm could not remove it; run it yourself: npm uninstall -g agent-cost-monitor");
        failures += 1;
      }
    }
  } else {
    say("  still installed. Remove it with: npm uninstall -g agent-cost-monitor");
    say("  (or re-run as `acm uninstall --self` and acm will do it)");
  }
  return failures;
}

/** Delete one path, reporting honestly whether there was anything to delete. */
function removePath(path, kind) {
  if (!existsSync(path)) {
    say(`  nothing at ${path}`);
    return 0;
  }
  if (dryRun) {
    say(`  would remove ${path}`);
    return 0;
  }
  try {
    if (kind === "dir") rmSync(path, { recursive: true, force: true });
    else unlinkSync(path);
    say(`  removed   ${path}`);
    return 0;
  } catch (error) {
    say(`  failed    ${path}: ${error.message}`);
    return 1;
  }
}

// --------------------------------------------------------------------- main ---

/**
 * Which hosts a command applies to.
 *
 * Install is conservative — Claude Code by default, the one host every install can
 * configure — but uninstall is total: "remove it all" has to mean all, or reversing
 * an install becomes a list of flags to remember.
 */
const wants = (name) =>
  hostArg === "all" || hostArg === name || (hostArg === "auto" && (command === "uninstall" ? true : name === "claude"));

function main() {
  const hosts = { claude: detectClaude(), dsh: detectDsh(), codex: detectCodex() };

  if (command === "help" || flag("help")) {
    say("acm — live spend for your coding agent\n");
    say("  acm install [--host h]     configure a host (claude | dsh | all; default: claude)");
    say("                             and set up auto-launch, unless --no-autostart");
    say("  acm launch [--quiet]       start the window now (what the shim and /acm call)");
    say("  acm autostart on|off|status  the shim that rides along with `claude` / `codex`");
    say("  acm status                 what is detected and configured");
    say("  acm uninstall              remove everything acm added to your machine");
    say("                             (--self also uninstalls the npm package)");
    say("                             (--keep-cache leaves the pricing cache)");
    say("  acm doctor                 check the pieces the status line needs\n");
    say("  --dry-run                  print the plan, change nothing");
    say("  --force                    replace a status line configured by something else");
    say("  --no-autostart             do not touch your PowerShell profiles");
    return 0;
  }
  if (command === "status") return status();
  if (command === "launch") return launch({ quiet: flag("quiet") });

  if (command === "autostart") {
    const mode = argv.find((a) => ["on", "off", "status"].includes(a)) ?? "status";
    const config = mergeConfig(readConfig(), {});
    if (mode === "on") {
      config.autoLaunch = true;
      if (!dryRun && !writeConfig(config)) say(`  could not write ${CONFIG_FILE}`);
      say("auto-launch on");
      autostartOn(config);
      if (!dryRun) writeClaudeCommand();
      const shimmed = shimHosts(config.hosts);
      say(`\n  Typing ${shimmed.map((h) => `\`${h}\``).join(" or ")} in PowerShell now brings the window up with it.`);
      say("  Claude Code is deliberately not wrapped — its own status line already shows these figures.");
      say("  Codex has no custom slash commands, so inside it use: !acm launch");
      return 0;
    }
    if (mode === "off") {
      config.autoLaunch = false;
      if (!dryRun && !writeConfig(config)) say(`  could not write ${CONFIG_FILE}`);
      say("auto-launch off");
      autostartOff();
      // Left in place on purpose: this is the command the user reaches for now.
      if (!dryRun) writeClaudeCommand();
      say("\n  The window is still one command away: `acm launch`, or `/acm` in Claude Code.");
      return 0;
    }
    return autostartStatus(config);
  }

  if (command === "doctor") {
    say(`  node            ${process.version}`);
    say(`  statusline.mjs  ${existsSync(STATUSLINE) ? "present" : "MISSING"} ${STATUSLINE}`);
    say(`  git             ${hasCommand("git") ? "present" : "missing"}`);
    say(`  dsh             ${hasCommand("dsh") ? "present" : "missing"}`);
    say(pricingCache());
    return 0;
  }

  say(`${command}${dryRun ? " (dry run)" : ""}`);
  let failures = 0;

  if (wants("claude")) {
    say("\nclaude code");
    if (!hosts.claude.detected) say("  not detected; skipping");
    else failures += command === "install" ? claudeInstall(hosts.claude) : claudeUninstall(hosts.claude);
  }
  if (wants("dsh")) {
    say("\ndsh-tui");
    if (!hosts.dsh.detected) say("  not detected; skipping");
    else failures += command === "install" ? dshInstall() : dshUninstall(hosts.dsh.installed);
  }
  if (command === "install" && hostArg === "auto" && hosts.dsh.detected && !hosts.dsh.installed) {
    say(`\ndsh-tui is present but untouched. Add it with: acm install --host dsh`);
  }

  if (command === "install") {
    say("\nauto-launch");
    // A fresh install turns this on; a re-install respects a deliberate `false`,
    // because someone who turned it off did so on purpose.
    const config = mergeConfig(readConfig(), noAutostart ? { autoLaunch: false } : {});
    if (!dryRun && !writeConfig(config)) say(`  could not write ${CONFIG_FILE}`);
    if (config.autoLaunch === false) {
      say("  off in config — the profiles are left alone.");
      say("  Launch it yourself with `acm launch`, or `/acm` inside Claude Code.");
    } else {
      autostartOn(config);
      say("  Codex has no custom slash commands, so inside it use: !acm launch");
    }
    // `/acm` is written either way — with auto-launch off it is the whole mechanism,
    // and with it on it is the manual override.
    if (!dryRun) writeClaudeCommand();
  }

  if (command === "uninstall") {
    failures += removeEverything({ self: flag("self"), keepCache: flag("keep-cache") });
  }

  say(failures === 0 ? "\ndone." : `\ndone, with ${failures} problem(s).`);
  return failures === 0 ? 0 : 1;
}

process.exitCode = main();
