import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeToyData } from "./toy-data.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const testDir = mkdtempSync(join(tmpdir(), "ai-usage-package-"));
try {
  const cache = join(testDir, "npm-cache");
  const [{ filename }] = JSON.parse(execFileSync("npm", ["pack", "--cache", cache, "--json", "--pack-destination", testDir], { cwd: packageRoot, encoding: "utf8" }));
  const installDir = join(testDir, "installed");
  mkdirSync(installDir);
  execFileSync("npm", ["install", "--prefix", installDir, "--cache", cache, "--no-audit", "--no-fund", join(testDir, filename)], { encoding: "utf8", timeout: 120_000 });
  const commandPath = join(installDir, "node_modules/.bin/ai-usage");
  const env = { ...process.env, HOME: join(installDir, "home") };
  const run = (...args) => spawnSync(process.execPath, [commandPath, ...args], { cwd: installDir, env, encoding: "utf8", timeout: 30_000 });
  for (const command of ["--help", "init"]) {
    const result = run(command);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(run("init").status, 1);
  writeToyData(installDir);
  const collected = run("collect");
  assert.equal(collected.status, 0, collected.stderr);
  const result = run("report");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reports\/anthropic-2026-09\.pdf/);
  assert.deepEqual(readdirSync(join(installDir, "reports")), ["anthropic-2026-09.pdf"]);
  const path = join(installDir, "reports/anthropic-2026-09.pdf");
  const pdf = readFileSync(path);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const text = execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8" }).split(/\s+/).join(" ");
  for (const expected of [
    "Jane Doe <jane.doe@example.com>", "Usage through Claude Code, September 2026",
    "Claude Opus 5.5 132,000 26,400 260,000 1,560,000 1,978,400",
    "Claude Sonnet 4.6 76,000 15,200 170,000 1,020,000 1,281,200",
    "2026-09-01", "2026-09-03", "2026-09-07",
    "2026-09-09", "2026-09-11", "2026-09-15",
    "2026-09-18", "2026-09-23", "2026-09-28",
  ]) assert.ok(text.includes(expected), expected);
  assert.equal(text.split("TOTAL 208,000 41,600 430,000 2,580,000 3,259,600").length - 1, 2);
  console.log("Package check passed: help, init, log collection and PDF report.");
} finally {
  rmSync(testDir, { recursive: true, force: true });
}
