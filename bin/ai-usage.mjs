#!/usr/bin/env node
import { constants, copyFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { collectUsage } from "../src/collect.mjs";
import { loadConfig } from "../src/config.mjs";

const HELP = `Monthly PDF reports of token usage from Claude Code, Codex, OpenCode and pi logs.

Usage: ai-usage [command]

  init      write an example ai-usage.toml in the current directory
  collect   save usage records from each source to usage/
  report    write reports/<report>-<YYYY-MM>.pdf for every month collected
  (none)    both collect and report

Run commands from the directory containing ai-usage.toml.
ai-usage requires requires Python 3.9 or newer on each computer.`;

const CONFIG_FILE = "ai-usage.toml";
const USAGE_DIR = resolve("usage");
const REPORTS_DIR = resolve("reports");

async function report(config) {
  const { loadUsage, writeReports } = await import("../src/report.mjs");
  const rows = await loadUsage(USAGE_DIR, config.timezone);
  for (const path of writeReports(rows, config, REPORTS_DIR)) console.log(relative(process.cwd(), path));
  return 0;
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { help: { type: "boolean", short: "h" } } });
  const [command = "all", ...extra] = positionals;
  if (values.help || extra.length || !["init", "collect", "report", "all"].includes(command)) {
    console.log(HELP);
    return values.help ? 0 : 1;
  }
  if (command === "init") {
    try {
      copyFileSync(new URL("../assets/config.example.toml", import.meta.url), CONFIG_FILE, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code === "EEXIST") throw new Error(`${CONFIG_FILE} already exists`);
      throw error;
    }
    console.error(`wrote ${CONFIG_FILE}: edit it to configure sources and reporting, then run ai-usage`);
    return 0;
  }
  const config = loadConfig(CONFIG_FILE);
  if (command === "collect") return collectUsage(config, USAGE_DIR);
  if (command === "report") return report(config);
  const exitCode = await collectUsage(config, USAGE_DIR);
  await report(config);
  return exitCode;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`ai-usage: ${error.message}`);
  process.exitCode = 1;
}
