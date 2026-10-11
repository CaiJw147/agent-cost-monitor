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
  claudeCommandFile,
  claudeCommandPath,
  configPath,
  hasBlock,
  mergeConfig,
  profilePaths,
  removeBlock,
  resolveConfig,
} from "../src/autostart.mjs";
import {
  CODEX_TRUST_NOTE,
  planClaudeHookInstall,
  planClaudeHookRemove,
  planCodexHookInstall,
  planCodexHookRemove,
} from "../src/hooks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const STATUSLINE = join(PACKAGE_ROOT, "claude", "statusline.mjs");
const CACHE_DIR = join(homedir(), ".cache", "agent-cost-monitor");
const PRICING_CACHE = process.env.SPEND_WATCH_CACHE ?? join(homedir(), ".cache", "spend-watch");
const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");

const DSH_PROFILE = process.env.ACM_DSH_PROFILE ?? "dsh-tui";
const PLUGIN_REPO = process.env.ACM_PLUGIN_REPO ?? "https://github.com/NeutronStar714/dsh-budget-watcher";
const LAUNCH_SCRIPT = join(PACKAGE_ROOT, "window", "launch.mjs");
const CONFIG_FILE = configPath(homedir());
const LOG_FILE = join(homedir(), ".cache", "agent-cost-monitor", "window.log");
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

/** Any file acm edits gets a timestamped copy first — config.toml as much as settings.json. */
function withBackup(path, write) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(path, `${path}.bak-${stamp}`);
    say(`  backed up to ${path}.bak-${stamp}`);
  }
  write();
}

// ------------------------------------------------------------------ hooks ---

/**
 * A `SessionStart` hook, so the window comes up with the session.
 *
 * This is the extension point both harnesses now offer, and it is the right one: unlike
 * the withdrawn shell shim, it needs no edits to a shell profile and it fires on the
 * event rather than on a command name.
 */
function hookClaude(mode) {
  let settings;
  try {
    settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8"));
  } catch (error) {
    say(`  skipped: ${CLAUDE_SETTINGS} ${existsSync(CLAUDE_SETTINGS) ? "does not parse" : "does not exist"} (${error.code ?? error.message})`);
    return 1;
  }
  const planned = mode === "on" ? planClaudeHookInstall(settings, "claude") : planClaudeHookRemove(settings);
  if (!planned.changed) {
    say(mode === "on" ? "  already installed" : "  not installed");
    return 0;
  }
  if (dryRun) {
    say(`  would ${mode === "on" ? "add" : "remove"} hooks.SessionStart in ${CLAUDE_SETTINGS}`);
    return 0;
  }
  withBackup(CLAUDE_SETTINGS, () => writeFileSync(CLAUDE_SETTINGS, JSON.stringify(planned.settings, null, 2) + "\n"));
  say(`  ${mode === "on" ? "installed" : "removed"}  hooks.SessionStart (startup) in ${CLAUDE_SETTINGS}`);
  return 0;
}

function hookCodex(mode) {
  if (!existsSync(CODEX_CONFIG)) {
    say(`  skipped: ${CODEX_CONFIG} does not exist`);
    return 1;
  }
  const text = readFileSync(CODEX_CONFIG, "utf8");
  const planned = mode === "on" ? planCodexHookInstall(text, "codex") : planCodexHookRemove(text);
  if (!planned.changed) {
    say(mode === "on" ? "  already installed" : "  not installed");
    return 0;
  }
  if (dryRun) {
    say(`  would ${mode === "on" ? "add" : "remove"} the SessionStart block in ${CODEX_CONFIG}`);
    return 0;
  }
  withBackup(CODEX_CONFIG, () => writeFileSync(CODEX_CONFIG, planned.text));
  say(`  ${mode === "on" ? "installed" : "removed"}  [[hooks.SessionStart]] in ${CODEX_CONFIG}`);
  if (mode === "on") say(`  note: ${CODEX_TRUST_NOTE}`);
  return 0;
}

function hookStatus() {
  let claude = "no settings file";
  try {
    const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8"));
    claude = (settings.hooks?.SessionStart ?? []).some((e) => (e.hooks ?? []).some((h) => String(h.command ?? "").includes("acm launch")))
      ? "installed"
      : "not installed";
  } catch {
    /* leave the message above */
  }
  let codex = "no config.toml";
  try {
    codex = hasBlock(readFileSync(CODEX_CONFIG, "utf8")) ? "installed" : "not installed";
  } catch {
    /* leave the message above */
  }
  say(`  claude code  ${claude}  ${CLAUDE_SETTINGS}`);
  say(`  codex        ${codex}  ${CODEX_CONFIG}`);
  say("  The window starts on SessionStart, so `acm launch` stays available by hand too.");
  return 0;
}

function runHookCommand(mode) {
  const scopes = hostArg === "all" || hostArg === "auto" ? ["claude", "codex"] : [hostArg];
  if (mode === "status") return hookStatus();
  let failures = 0;
  for (const scope of scopes) {
    if (scope === "claude") failures += hookClaude(mode);
    else if (scope === "codex") failures += hookCodex(mode);
    else {
      say(`  unknown host "${scope}" (use claude, codex or all)`);
      failures += 1;
    }
  }
  return failures;
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

/** Start the window now. This is what `/acm` and the user call. */
function launch({ quiet }) {
  if (!existsSync(LAUNCH_SCRIPT)) {
    if (!quiet) say(`  the window is not in this install (${LAUNCH_SCRIPT} is missing)`);
    return 1;
  }
  const host = option("host") ?? "";
  // Detached and unref'd: a GUI process must never hold this one open, and the window
  // takes long enough to start that waiting on it would be felt.
  spawn(process.execPath, [LAUNCH_SCRIPT, ...(host === "" ? [] : ["--host", host])], { detached: true, stdio: "ignore" }).unref();
  if (!quiet) say(`  window starting at ${WINDOW_URL}${host === "" ? "" : ` (host: ${host})`}`);
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
 * Remove a shim block written by a version that had auto-launch.
 *
 * Nothing writes one any more — both remaining hosts were given up, because the
 * window that rode along with them showed the wrong host's numbers half the time. But
 * a withdrawn feature still has to be cleanly reversible on machines that ran it, so
 * this stays and `uninstall` calls it.
 */
function removeShimBlock() {
  let removed = 0;
  for (const path of profilePaths(homedir())) {
    if (!existsSync(path)) continue;
    const existing = readFileSync(path, "utf8");
    if (!hasBlock(existing)) continue;
    if (dryRun) {
      say(`  would remove an old auto-launch block from ${path}`);
      continue;
    }
    writeFileSync(path, removeBlock(existing).text);
    removed += 1;
    say(`  removed   ${path}`);
  }
  if (!dryRun) say(removed === 0 ? "  (no old auto-launch block in either profile)" : "  (old auto-launch block removed)");
  return removed;
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

  say("\nsession-start hooks");
  runHookCommand("off");

  say("\nold auto-launch block");
  removeShimBlock();

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
    say("  acm launch [--host h]      start the window now (--host codex points it at Codex)");
    say("  acm status                 what is detected and configured");
    say("  acm uninstall              remove everything acm added to your machine");
    say("                             (--self also uninstalls the npm package)");
    say("                             (--keep-cache leaves the pricing cache)");
    say("  acm clean-profiles         remove an old auto-launch block, if you have one");
    say("  acm hook on|off|status     a SessionStart hook that opens the window");
    say("    [--host claude|codex|all]  (default: both, when their config exists)");
    say("  acm doctor                 check the pieces the status line needs\n");
    say("  --dry-run                  print the plan, change nothing");
    say("  --force                    replace a status line configured by something else");
    return 0;
  }
  if (command === "status") return status();
  if (command === "launch") return launch({ quiet: flag("quiet") });
  if (command === "clean-profiles") {
    // Auto-launch is withdrawn, but machines that ran it still carry the block.
    say("old auto-launch block");
    removeShimBlock();
    return 0;
  }

  if (command === "hook") {
    const mode = argv.find((a) => ["on", "off", "status"].includes(a)) ?? "status";
    if (mode !== "status") say(`hook ${mode}${dryRun ? " (dry run)" : ""}`);
    return runHookCommand(mode) === 0 ? 0 : 1;
  }

  if (command === "doctor") {
    say(`  node            ${process.version}`);
    say(`  statusline.mjs  ${existsSync(STATUSLINE) ? "present" : "MISSING"} ${STATUSLINE}`);
    say(`  git             ${hasCommand("git") ? "present" : "missing"}`);
    say(`  dsh             ${hasCommand("dsh") ? "present" : "missing"}`);
    const cfg = resolveConfig(homedir());
    say(`  window          ${cfg.width}x${cfg.height} at ${cfg.x},${cfg.y}  backend=${cfg.backend}  onTop=${cfg.alwaysOnTop}  port=${cfg.port}`);
    say(`  config file     ${existsSync(CONFIG_FILE) ? CONFIG_FILE : `${CONFIG_FILE} (not written yet; defaults apply)`}`);
    say(`  log file        ${existsSync(LOG_FILE) ? LOG_FILE : `${LOG_FILE} (nothing logged yet)`}`);
    say(pricingCache());
    return 0;
  }

  if (command === "log") {
    const count = Number(option("lines") ?? 40);
    if (!existsSync(LOG_FILE)) {
      say(`nothing logged yet at ${LOG_FILE}`);
      return 0;
    }
    const lines = readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
    for (const line of lines.slice(-count)) say(`  ${line}`);
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
    // The config is written so there is something to edit, and `/acm` is written so
    // the window is always one command away. There is no auto-launch step any more:
    // wrapping the host commands meant editing two shell profiles to save one command,
    // and the window it opened showed the wrong host's numbers half the time.
    const config = mergeConfig(readConfig(), {});
    say("\nconfig and /acm");
    if (!dryRun && !writeConfig(config)) say(`  could not write ${CONFIG_FILE}`);
    else if (!dryRun) say(`  config    ${CONFIG_FILE}`);
    if (!dryRun) writeClaudeCommand();
    say("  Codex has no custom slash commands, so inside it use: !acm launch");
  }

  if (command === "uninstall") {
    failures += removeEverything({ self: flag("self"), keepCache: flag("keep-cache") });
  }

  say(failures === 0 ? "\ndone." : `\ndone, with ${failures} problem(s).`);
  return failures === 0 ? 0 : 1;
}

process.exitCode = main();
