import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const testDir = mkdtempSync(join(tmpdir(), "ai-usage-package-"));
try {
  const cache = join(testDir, "npm-cache");
  const [{ filename }] = JSON.parse(execFileSync("npm", ["pack", "--cache", cache, "--json", "--pack-destination", testDir], { cwd: packageRoot, encoding: "utf8" }));
  const installDir = join(testDir, "installed");
  mkdirSync(installDir);
  execFileSync("npm", ["install", "--prefix", installDir, "--cache", cache, "--no-audit", "--no-fund", join(testDir, filename)], { encoding: "utf8", timeout: 120_000 });
  const commandPath = join(installDir, "node_modules/.bin/ai-usage");
  const run = (...args) => spawnSync(process.execPath, [commandPath, ...args], { cwd: installDir, encoding: "utf8", timeout: 30_000 });
  for (const command of ["--help", "init"]) {
    const result = run(command);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(run("init").status, 1);
  const packageDir = join(installDir, "node_modules/@cynddl/ai-usage");
  const sampleHome = join(testDir, "sample-home");
  const logPath = join(sampleHome, ".claude/projects/project/session.jsonl");
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, JSON.stringify({
    type: "assistant", timestamp: "2026-09-01T10:00:00Z", sessionId: "sample", requestId: "sample-request",
    message: { id: "sample-message", model: "claude-opus-5-5", usage: { input_tokens: 100, output_tokens: 10 } },
  }) + "\n");
  const records = execFileSync("python3", [join(packageDir, "src/extract.py"), sampleHome], { encoding: "utf8" });
  const { saveRecords } = await import(join(packageDir, "src/collect.mjs"));
  saveRecords(join(installDir, "usage"), "sample", records);
  const result = run("report");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reports\/anthropic-2026-09\.pdf/);
  const pdf = readFileSync(join(installDir, "reports/anthropic-2026-09.pdf"));
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  console.log("Package check passed: help, init, log collection and PDF report.");
} finally {
  rmSync(testDir, { recursive: true, force: true });
}
