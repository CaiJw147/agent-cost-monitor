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

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describeHosts, looksLikePluginDir, planClaudeInstall, planClaudeUninstall, pluginSpec } from "../src/install.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const STATUSLINE = join(PACKAGE_ROOT, "claude", "statusline.mjs");
const CACHE_DIR = join(homedir(), ".cache", "agent-cost-monitor");
const PRICING_CACHE = process.env.SPEND_WATCH_CACHE ?? join(homedir(), ".cache", "spend-watch");

const DSH_PROFILE = process.env.ACM_DSH_PROFILE ?? "dsh-tui";
const PLUGIN_REPO = process.env.ACM_PLUGIN_REPO ?? "https://github.com/NeutronStar714/dsh-budget-watcher";

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

function dshUninstall() {
  if (!hasCommand("dsh")) return 1;
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

// --------------------------------------------------------------------- main ---

const wants = (name) => hostArg === "all" || hostArg === name || (hostArg === "auto" && name === "claude");

function main() {
  const hosts = { claude: detectClaude(), dsh: detectDsh(), codex: detectCodex() };

  if (command === "help" || flag("help")) {
    say("acm — live spend for your coding agent\n");
    say("  acm status                 what is detected and configured");
    say("  acm install [--host h]     configure a host (claude | dsh | all; default: claude)");
    say("  acm uninstall [--host h]   remove only what this installer added");
    say("  acm doctor                 check the pieces the status line needs\n");
    say("  --dry-run                  print the plan, change nothing");
    say("  --force                    replace a status line configured by something else");
    return 0;
  }
  if (command === "status") return status();

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
    else failures += command === "install" ? dshInstall() : dshUninstall();
  }
  if (command === "install" && hostArg === "auto" && hosts.dsh.detected && !hosts.dsh.installed) {
    say(`\ndsh-tui is present but untouched. Add it with: acm install --host dsh`);
  }

  say(failures === 0 ? "\ndone." : `\ndone, with ${failures} problem(s).`);
  return failures === 0 ? 0 : 1;
}

process.exitCode = main();
