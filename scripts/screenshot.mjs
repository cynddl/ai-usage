import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { loadUsage, writeReports } from "../src/report.mjs";
import { writeToyData } from "./toy-data.mjs";

const directory = mkdtempSync(join(tmpdir(), "ai-usage-screenshot-"));
const output = fileURLToPath(new URL("../docs/report-example", import.meta.url));
try {
  const home = writeToyData(directory);
  const command = fileURLToPath(new URL("../bin/ai-usage.mjs", import.meta.url));
  execFileSync(process.execPath, [command, "collect"], { cwd: directory, env: { ...process.env, HOME: home }, stdio: "inherit" });
  const config = loadConfig(join(directory, "ai-usage.toml"));
  const rows = await loadUsage(join(directory, "usage"), config.timezone);
  const [pdf] = writeReports(rows, config, join(directory, "reports"), { now: new Date("2026-10-01T09:00:00Z") });
  mkdirSync(dirname(output), { recursive: true });
  execFileSync("pdftoppm", ["-f", "1", "-singlefile", "-scale-to", "1600", "-png", pdf, output]);
  console.log(`Wrote ${output}.png`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
