import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "node:test";
import { collectUsage, runSource, saveRecords } from "../src/collect.mjs";
import { sourceCommands, validateConfig } from "../src/config.mjs";
import { replaceFile } from "../src/files.mjs";
import { groupReports, formatModelName, loadUsage, sumDailyUsage, writePdf, prepareReport, runCcusage, writeReports } from "../src/report.mjs";

let directory;
beforeEach(() => (directory = mkdtempSync(join(tmpdir(), "ai-usage-test-"))));
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function writeJsonl(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map((record) => JSON.stringify(record) + "\n").join(""));
}

const piMessage = (id) => ({
  type: "message",
  id,
  timestamp: "2026-09-01T10:00:00Z",
  message: {
    role: "assistant",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
  },
});

const row = (day, assistant, provider, model, input, output, cacheWrite, cacheRead) => ({
  day, assistant, provider, model, input, output, cacheWrite, cacheRead, tokens: input + output + cacheWrite + cacheRead,
});
const sampleConfig = () => ({ timezone: "Europe/London", reports: { main: { supplier: "Supplier", match: ["claude:anthropic"] } } });
const commandPath = fileURLToPath(new URL("../bin/ai-usage.mjs", import.meta.url));
const runCommand = (...args) => spawnSync(process.execPath, [commandPath, ...args], { cwd: directory, encoding: "utf8" });

describe("config and commands", () => {
  test("config defaults are applied and invalid values are rejected", () => {
    assert.deepEqual(validateConfig(sampleConfig()), { ...sampleConfig(), ssh: [], commands: {}, reports: sampleConfig().reports });
    for (const patch of [
      { timezone: "Not/AZone" }, { timezon: "UTC" }, { ssh: ["-oProxyCommand=anything"] },
      { commands: "echo" }, { commands: { "../escape": "echo" } }, { commands: { local: "echo" } },
      { reports: {} }, { reports: { "../escape": sampleConfig().reports.main } },
      { reports: { main: { supplier: "Supplier", match: [] } } },
      { reports: { main: { supplier: "Supplier", match: ["unknown:provider"] } } },
      { reports: { main: { supplier: "Supplier", match: ["claude:anthropic"], billng: "api" } } },
    ]) assert.throws(() => validateConfig({ ...sampleConfig(), ...patch }), JSON.stringify(patch));
    assert.throws(() => validateConfig({ ...sampleConfig(), ssh: ["same.one", "user@same.two"] }), /listed twice/);
  });

  test("help, invalid arguments, init and missing config have useful exit codes", () => {
    const help = runCommand("--help");
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: ai-usage/);
    assert.equal(runCommand("unknown").status, 1);
    assert.match(runCommand("collect").stderr, /init.*first/);
    assert.equal(runCommand("init").status, 0);
    const original = readFileSync(join(directory, "ai-usage.toml"), "utf8");
    assert.equal(runCommand("init").status, 1);
    assert.equal(readFileSync(join(directory, "ai-usage.toml"), "utf8"), original);
    writeFileSync(join(directory, "ai-usage.toml"), 'timezone = "Not/AZone"');
    assert.equal(runCommand("collect").status, 1);
    assert.match(runCommand("collect").stderr, /timezone/);
  });

  test("a failed write preserves the previous file and removes temporary files", () => {
    const path = join(directory, "complete.txt");
    replaceFile(path, "previous");
    assert.throws(() => replaceFile(path, { invalid: "content" }));
    assert.equal(readFileSync(path, "utf8"), "previous");
    assert.deepEqual(readdirSync(directory), ["complete.txt"]);
    replaceFile(path, "next");
    assert.equal(readFileSync(path, "utf8"), "next");
  });
});

describe("collect", () => {
  test("sources are this computer, SSH hosts by short name, then commands", () => {
    const sources = sourceCommands({ ssh: ["alan.example.org"], commands: { box: "docker exec -i box python3 -" } });
    assert.deepEqual(Object.keys(sources), ["local", "alan", "box"]);
    assert.deepEqual(sources.alan, { file: "ssh", args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "alan.example.org", "python3", "-"] });
    assert.deepEqual(sourceCommands({ ssh: ["user@alan.example.org"] }).alan.args.slice(-3), ["user@alan.example.org", "python3", "-"]);
    assert.throws(() => sourceCommands({ ssh: ["local.example.org"] }), /listed twice/);
  });

  test("saved logs remain after the originals are deleted", async () => {
    const home = join(directory, "home");
    const sessions = join(home, ".pi/agent/sessions/project");
    writeJsonl(join(sessions, "a.jsonl"), [piMessage("first")]);
    writeJsonl(join(sessions, "b.jsonl"), [piMessage("second")]);
    const collect = async () => {
      const { exitCode, output } = await runSource({ file: "python3", args: ["-", home] });
      assert.equal(exitCode, 0);
      return saveRecords(join(directory, "usage"), "local", output);
    };
    assert.equal((await collect()).pi, 2);
    rmSync(join(sessions, "a.jsonl"));
    assert.equal((await collect()).pi, 1);
    for (const name of ["a", "b"]) {
      readFileSync(join(directory, "usage/local/pi/deepseek/sessions/project", `${name}.jsonl`));
    }
  });

  test("a home without logs exits with code 3", async () => {
    assert.equal((await runSource({ file: "python3", args: ["-", directory] })).exitCode, 3);
  });

  test("records outside the source directory are rejected", () => {
    assert.throws(() => saveRecords(directory, "local", "../escape.jsonl\t{}\n"), /unexpected line/);
    assert.throws(() => saveRecords(directory, "../escape", "claude/escape.jsonl\t{}\n"), /invalid.*name/);
    assert.throws(() => saveRecords(directory, "local", "unknown/escape.jsonl\t{}\n"), /unexpected line/);
  });

  test("missing commands and excess output are reported as failures", async () => {
    const missing = await runSource({ file: join(directory, "missing-command") });
    assert.equal(missing.exitCode, null);
    assert.match(missing.error, /ENOENT/);
    const overflow = await runSource({ file: process.execPath, args: ["-e", 'process.stdout.write("x".repeat(10000))'] }, { maxBuffer: 100 });
    assert.notEqual(overflow.exitCode, 0);
    assert.equal(overflow.error, "output limit exceeded");
  });

  test("a timeout stops the shell and its child processes", { skip: process.platform === "win32", timeout: 5000 }, async () => {
    const marker = join(directory, "survived");
    const result = await runSource({ file: `(sleep 1; touch '${marker}') & wait`, shell: true }, { timeout: 100 });
    assert.equal(result.exitCode, null);
    assert.equal(result.error, "timed out");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.throws(() => readFileSync(marker), { code: "ENOENT" });
  });

  test("collection returns 2 when a custom command fails", async () => {
    const config = { commands: { failed: "exit 7" } };
    // Use a dummy Python command to avoid reading local logs.
    const previousPath = process.env.PATH;
    const python = join(directory, "python3");
    writeFileSync(python, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    process.env.PATH = directory;
    try {
      const messages = [];
      assert.equal(await collectUsage(config, join(directory, "usage"), (message) => messages.push(message)), 2);
      assert.ok(messages.some((message) => /local.*no usage logs/.test(message)));
      assert.ok(messages.some((message) => /failed.*FAILED \(7\)/.test(message)));
    } finally { process.env.PATH = previousPath; }
  });
});

describe("load", () => {
  test("ccusage reads all sources for each assistant and provider", async () => {
    for (const path of ["a/claude/anthropic", "b/claude/anthropic", "a/codex/openai", "a/opencode/openai", "a/pi/deepseek", "b/pi/deepseek"]) {
      mkdirSync(join(directory, path), { recursive: true });
    }
    const calls = {};
    await loadUsage(directory, "Europe/London", async (assistant, sourceDirs) => {
      calls[assistant] = sourceDirs.map((sourceDir) => sourceDir.slice(directory.length + 1));
      return '{"daily": []}';
    });
    assert.deepEqual(calls, {
      claude: ["a/claude/anthropic", "b/claude/anthropic"],
      codex: ["a/codex/openai"],
      opencode: ["a/opencode/openai"],
      pi: ["a/pi/deepseek", "b/pi/deepseek"],
    });
  });

  test("pi prefix is removed and empty rows are dropped", async () => {
    mkdirSync(join(directory, "local/pi/deepseek"), { recursive: true });
    const breakdown = (modelName, tokens) => ({ modelName, inputTokens: tokens, outputTokens: tokens, cacheCreationTokens: 0, cacheReadTokens: 0 });
    const daily = { daily: [{ period: "2026-09-01", modelBreakdowns: [breakdown("[pi] model", 1), breakdown("<synthetic>", 0)] }] };
    const rows = await loadUsage(directory, "Europe/London", async () => JSON.stringify(daily));
    assert.deepEqual(rows, [row("2026-09-01", "pi", "deepseek", "model", 1, 1, 0, 0)]);
  });

  test("nothing collected is an error", async () => {
    await assert.rejects(loadUsage(join(directory, "missing"), "Europe/London"), /nothing collected/);
  });

  test("ccusage reads only the collected logs", async () => {
    const message = (id, input) => ({
      type: "assistant",
      timestamp: "2026-09-01T10:00:00.000Z",
      sessionId: "session",
      requestId: `request-${id}`,
      message: { id, model: "claude-opus-5-5", usage: { input_tokens: input, output_tokens: 1 } },
    });
    const sourceDir = join(directory, "local/claude/anthropic");
    writeJsonl(join(sourceDir, "projects/project/session.jsonl"), [message("a", 100), message("a", 100), message("b", 20)]);
    const { daily } = JSON.parse(await runCcusage("claude", [sourceDir], "Europe/London"));
    assert.deepEqual(daily.map((day) => [day.date ?? day.period, day.modelBreakdowns.map((model) => [model.modelName, model.inputTokens])]), [
      ["2026-09-01", [["claude-opus-5-5", 120]]],
    ]);
  });

  test("Codex and pi logs produce separate totals for each provider", async () => {
    const home = join(directory, "sample-home");
    const timestamp = "2026-09-01T10:00:00Z";
    const usage = { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 };
    writeJsonl(join(home, ".codex/sessions/2026/09/01/session.jsonl"), [
      { type: "session_meta", timestamp, payload: { id: "sample-session", timestamp, model_provider: "openai" } },
      { type: "turn_context", timestamp, payload: { model: "gpt-5.6", turn_id: "sample-turn" } },
      { type: "event_msg", timestamp, payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage, model_context_window: 200000 } } },
    ]);
    writeJsonl(join(home, ".pi/agent/sessions/project/session.jsonl"), [
      { type: "session", version: 3, id: "sample-pi", timestamp }, piMessage("pi-one"),
      { ...piMessage("pi-two"), message: { ...piMessage("pi-two").message, provider: "anthropic", model: "claude-opus-5-5" } },
    ]);
    const extracted = await runSource({ file: "python3", args: ["-", home] });
    assert.equal(extracted.exitCode, 0, extracted.error);
    const usageDir = join(directory, "usage");
    assert.deepEqual(saveRecords(usageDir, "local", extracted.output), { claude: 0, codex: 3, opencode: 0, pi: 4 });
    const rows = await loadUsage(usageDir, "Europe/London");
    assert.deepEqual(rows.map(({ day, assistant, provider, model, input, output, cacheRead, tokens }) => ({ day, assistant, provider, model, input, output, cacheRead, tokens })), [
      { day: "2026-09-01", assistant: "codex", provider: "openai", model: "gpt-5.6", input: 80, output: 10, cacheRead: 20, tokens: 110 },
      { day: "2026-09-01", assistant: "pi", provider: "anthropic", model: "claude-opus-5-5", input: 10, output: 2, cacheRead: 0, tokens: 12 },
      { day: "2026-09-01", assistant: "pi", provider: "deepseek", model: "deepseek-v4-flash", input: 10, output: 2, cacheRead: 0, tokens: 12 },
    ]);
  });

  test("OpenCode messages from files and databases are counted once, with reasoning as output", async () => {
    const home = join(directory, "sample-home");
    const dataDir = join(home, ".local/share/opencode");
    const message = (id, providerID, output, reasoning) => ({
      id, sessionID: "ses_one", role: "assistant", time: { created: Date.parse("2026-09-01T10:00:00Z") },
      providerID, modelID: "claude-opus-5-5", tokens: { input: 100, output, reasoning, cache: { read: 20, write: 5 } },
    });
    const legacy = join(dataDir, "storage/message/ses_one");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "msg_one.json"), JSON.stringify(message("msg_one", "anthropic", 10, 0)));
    writeFileSync(join(legacy, "msg_user.json"), JSON.stringify({ id: "msg_user", sessionID: "ses_one", role: "user" }));
    // The database repeats msg_one, as after OpenCode moved its storage to SQLite.
    const rows = [message("msg_one", "anthropic", 10, 0), message("msg_two", "anthropic", 10, 3), message("msg_three", "openrouter", 1, 0)];
    execFileSync("python3", ["-c", `
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
for m in json.loads(sys.argv[2]):
    db.execute("INSERT INTO message VALUES (?, ?, ?, ?, ?)", (m.pop("id"), m.pop("sessionID"), m["time"]["created"], m["time"]["created"], json.dumps(m)))
db.commit()
`, join(dataDir, "opencode.db"), JSON.stringify(rows)]);
    const extracted = await runSource({ file: "python3", args: ["-", home] });
    assert.equal(extracted.exitCode, 0, extracted.error);
    const usageDir = join(directory, "usage");
    assert.deepEqual(saveRecords(usageDir, "local", extracted.output), { claude: 0, codex: 0, opencode: 4, pi: 0 });
    assert.deepEqual(readdirSync(join(usageDir, "local/opencode/anthropic"), { recursive: true }).sort(), [
      "opencode", "opencode/ses_one.jsonl", "storage", "storage/ses_one.jsonl",
    ]);
    const usage = await loadUsage(usageDir, "Europe/London");
    assert.deepEqual(usage.map(({ assistant, provider, input, output, cacheWrite, cacheRead }) => ({ assistant, provider, input, output, cacheWrite, cacheRead })), [
      { assistant: "opencode", provider: "anthropic", input: 200, output: 23, cacheWrite: 10, cacheRead: 40 },
      { assistant: "opencode", provider: "openrouter", input: 100, output: 1, cacheWrite: 5, cacheRead: 20 },
    ]);
  });
});

describe("report", () => {
  test("each row uses the first report listing its assistant and provider", () => {
    const report = (supplier, ...match) => ({ supplier, match });
    const reports = { first: report("First", "claude:anthropic"), overlap: report("Overlap", "claude:anthropic", "pi:anthropic") };
    const rows = [
      row("2026-10-01", "claude", "anthropic", "claude-opus-5", 1, 2, 3, 4),
      row("2026-10-01", "pi", "anthropic", "claude-sonnet-5", 1, 2, 3, 4),
      row("2026-10-01", "codex", "openai", "gpt-6", 1, 2, 3, 4),
    ];
    const { rowsByReport, unmatched } = groupReports(rows, reports);
    assert.deepEqual(rowsByReport.first.map((row) => row.model), ["claude-opus-5"]);
    assert.deepEqual(rowsByReport.overlap.map((row) => row.model), ["claude-sonnet-5"]);
    assert.deepEqual(unmatched, ["codex:openai"]);
  });

  test("merging across assistants sums tokens", () => {
    const rows = sumDailyUsage([
      row("2026-09-01", "claude", "a", "Model", 1, 2, 3, 4),
      row("2026-09-01", "pi", "b", "Model", 10, 20, 30, 40),
      row("2026-09-02", "pi", "b", "Model", 1, 0, 0, 0),
    ]);
    assert.deepEqual(rows, [
      { day: "2026-09-01", model: "Model", input: 11, output: 22, cacheWrite: 33, cacheRead: 44, tokens: 110 },
      { day: "2026-09-02", model: "Model", input: 1, output: 0, cacheWrite: 0, cacheRead: 0, tokens: 1 },
    ]);
  });

  test("models are ordered by tokens and values formatted", () => {
    const rows = sumDailyUsage([
      row("2026-09-02", "pi", "a", "Small", 1000, 2, 3, 4),
      row("2026-09-01", "pi", "a", "Small", 1000, 2, 3, 4),
      row("2026-09-01", "pi", "a", "Large", 10, 20, 30, 4000),
    ]);
    const now = new Date("2026-09-10T13:05:00Z");
    const data = prepareReport({ supplier: "Supplier" }, "2026-09", rows, ["pi"], "Europe/London", now);
    assert.deepEqual(data.models.map((model) => model.model), ["Large", "Small"]);
    assert.equal(data.totals.tokens, "6,078");
    assert.equal(data.daily[0].day, "2026-09-01");
    assert.equal(data.subtitle, "Usage through pi, September 2026");
    assert.equal(data.first_day, "1 September 2026");
    assert.equal(data.last_day, "10 September 2026");
    assert.equal(data.generated_at, "10 September 2026, 01:05 PM UTC");
  });

  test("model IDs are formatted for display", () => {
    for (const [modelId, name] of [
      ["claude-opus-5-5", "Claude Opus 5.5"],
      ["claude-haiku-4-5-20251001", "Claude Haiku 4.5 (2025-10-01)"],
      ["gpt-5.6-sol", "GPT 5.6 Sol"],
      ["deepseek-v4-flash", "DeepSeek V4 Flash"],
    ]) {
      assert.equal(formatModelName(modelId), name);
    }
  });

  test("reports sort months, reject invalid paths and keep dated models separate", () => {
    const config = sampleConfig();
    const rows = [
      row("2026-10-01", "claude", "anthropic", "claude-haiku-4-5-20251001", 1, 0, 0, 0),
      row("2026-09-01", "claude", "anthropic", "claude-haiku-4-5-20251001", 2, 0, 0, 0),
      row("2026-09-01", "claude", "anthropic", "claude-haiku-4-5-20251002", 3, 0, 0, 0),
    ];
    const reports = [];
    const paths = writeReports(rows, config, directory, { write: (path, data) => reports.push(data) });
    assert.deepEqual(paths.map((path) => path.slice(directory.length + 1)), ["main-2026-09.pdf", "main-2026-10.pdf"]);
    assert.deepEqual(reports[0].models.map((model) => [model.model, model.tokens]), [["Claude Haiku 4.5 (2025-10-02)", "3"], ["Claude Haiku 4.5 (2025-10-01)", "2"]]);
    assert.throws(() => writeReports(rows, { ...config, reports: { "../escaped": config.reports.main } }, directory), /invalid.*name/);
    const data = prepareReport(config.reports.main, "2026-09", sumDailyUsage(rows.slice(1)), ["Claude Code", "Codex", "pi"], "Europe/London");
    assert.equal(data.assistants, "Claude Code, Codex and pi");
  });

  test("PDF embeds Inter and shows tokens without costs or requests", (context) => {
    try {
      execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
      execFileSync("pdffonts", ["-v"], { stdio: "ignore" });
    } catch {
      return context.skip("requires Poppler (pdftotext and pdffonts)");
    }
    const rows = [{ day: "2026-09-01", model: "Model", input: 12345, output: 6, cacheWrite: 7, cacheRead: 8, tokens: 12366 }];
    const path = join(directory, "sample-2026-09.pdf");
    writePdf(path, prepareReport({ supplier: "Supplier" }, "2026-09", rows, ["pi"], "Europe/London"));
    const fonts = execFileSync("pdffonts", [path], { encoding: "utf8" });
    for (const weight of ["Regular", "SemiBold"]) assert.match(fonts, new RegExp(`Inter-${weight}.*\\byes\\s+yes\\s+yes\\b`));
    const text = execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8" }).split(/\s+/).join(" ");
    for (const expected of ["Tokens by Model", "Daily Tokens", "About These Figures", "12,345", "12,366"]) assert.ok(text.includes(expected), expected);
    for (const excluded of ["cost", "$", "request", "invoice", "price"]) assert.ok(!text.toLowerCase().includes(excluded), excluded);
  });
});
