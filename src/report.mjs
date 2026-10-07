import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeCompiler } from "@myriaddreamin/typst-ts-node-compiler";
import { ASSISTANT_NAMES } from "./config.mjs";
import { replaceFile, validateName, outputPath } from "./files.mjs";
import { runProcess } from "./process.mjs";

const ASSETS_DIR = fileURLToPath(new URL("../assets/", import.meta.url));
const require = createRequire(import.meta.url);
const INTER_FONT_DIR = dirname(require.resolve("inter-font/ttf/Inter-Regular.ttf"));
const CCUSAGE_SCRIPT = join(dirname(require.resolve("ccusage/package.json")), require("ccusage/package.json").bin.ccusage);
// ccusage accepts comma-separated log directories in these environment variables.
const LOG_PATH_VARIABLES = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", opencode: "OPENCODE_DATA_DIR", pi: "PI_AGENT_DIR" };
const TOKEN_FIELDS = ["input", "output", "cacheWrite", "cacheRead"];
const COUNT_FIELDS = [...TOKEN_FIELDS, "tokens"];
const countFormat = new Intl.NumberFormat("en-US");
const listFormat = new Intl.ListFormat("en-GB", { type: "conjunction" });
const monthFormat = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const timeFormat = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "UTC", timeZoneName: "short" });
const dayFormats = new Map();

/** Write collected OpenCode messages as the message files ccusage reads, and return the data directory. */
export function writeOpencodeStorage(sourceDirs, dataDir) {
  const fileName = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, "_");
  for (const sourceDir of sourceDirs) {
    for (const file of readdirSync(sourceDir, { recursive: true }).filter((name) => name.endsWith(".jsonl"))) {
      for (const line of readFileSync(join(sourceDir, file), "utf8").split("\n")) {
        if (!line) continue;
        const message = JSON.parse(line);
        // OpenCode counts reasoning apart from output tokens. Add it to output as for other assistants.
        const { reasoning = 0, ...tokens } = message.tokens;
        tokens.output = (tokens.output ?? 0) + reasoning;
        // Copies of a message from several sources share a path, so they are counted once.
        const path = outputPath(dataDir, "storage", "message", fileName(message.sessionID), `${fileName(message.id)}.json`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ ...message, tokens }));
      }
    }
  }
  return dataDir;
}

/** Read daily usage from collected logs with ccusage. */
export async function runCcusage(assistant, sourceDirs, timezone) {
  // An empty home directory keeps uncollected logs out of the report.
  const temporaryHome = mkdtempSync(join(tmpdir(), "ai-usage-"));
  try {
    const paths = assistant === "opencode"
      ? [writeOpencodeStorage(sourceDirs, join(temporaryHome, "opencode"))]
      : sourceDirs.map((directory) => (assistant === "pi" ? join(directory, "sessions") : directory));
    const env = { ...process.env, HOME: temporaryHome };
    for (const name of [...Object.values(LOG_PATH_VARIABLES), "XDG_DATA_HOME"]) delete env[name];
    env[LOG_PATH_VARIABLES[assistant]] = paths.join(",");
    const args = ["daily", "--json", "--breakdown", "--no-cost", "--offline", "--timezone", timezone];
    const { stdout } = await runProcess(process.execPath, [CCUSAGE_SCRIPT, ...args], { env });
    return stdout;
  } finally {
    rmSync(temporaryHome, { recursive: true, force: true });
  }
}

/** Load daily token counts by assistant, provider and model. */
export async function loadUsage(usageDir, timezone, ccusage = runCcusage) {
  const subdirectories = (directory) =>
    existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : [];
  const directoriesByLabel = new Map();
  for (const source of subdirectories(usageDir)) {
    for (const assistant of subdirectories(join(usageDir, source)).filter((name) => Object.hasOwn(ASSISTANT_NAMES, name))) {
      const assistantDir = join(usageDir, source, assistant);
      for (const provider of subdirectories(assistantDir)) {
        const label = `${assistant}:${provider}`;
        if (!directoriesByLabel.has(label)) directoriesByLabel.set(label, []);
        directoriesByLabel.get(label).push(join(assistantDir, provider));
      }
    }
  }
  if (!directoriesByLabel.size) throw new Error("nothing collected yet: run `ai-usage collect` first");
  // ccusage does not report providers, so run it once per assistant and provider.
  const rows = [];
  for (const [label, directories] of directoriesByLabel) {
    const [assistant, provider] = label.split(":");
    const dailyJson = await ccusage(assistant, directories, timezone);
    for (const dailyUsage of JSON.parse(dailyJson).daily) {
      for (const model of dailyUsage.modelBreakdowns) {
        const row = {
          day: dailyUsage.date ?? dailyUsage.period,
          assistant,
          provider,
          model: model.modelName.replace(/^\[\w+\] /, ""),
          input: model.inputTokens,
          output: model.outputTokens,
          cacheWrite: model.cacheCreationTokens,
          cacheRead: model.cacheReadTokens,
        };
        row.tokens = TOKEN_FIELDS.reduce((sum, field) => sum + row[field], 0);
        if (row.tokens) rows.push(row);
      }
    }
  }
  return rows;
}

const MODEL_NAMES = { gpt: "GPT", deepseek: "DeepSeek", glm: "GLM" };

/** Format model IDs for display, such as claude-opus-5-5 as Claude Opus 5.5. */
export function formatModelName(modelId) {
  const date = modelId.match(/-(\d{4})(\d{2})(\d{2})$/);
  const parts = modelId.replace(/-\d{8}$/, "").replace(/(\d)-(?=\d)/g, "$1.").split("-");
  const words = parts.map((part) => MODEL_NAMES[part] ?? part.charAt(0).toUpperCase() + part.slice(1));
  return words.join(" ") + (date ? ` (${date.slice(1).join("-")})` : "");
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function sumBy(rows, keyFields) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify(keyFields.map((field) => row[field]));
    if (!groups.has(key)) groups.set(key, Object.fromEntries([
      ...keyFields.map((field) => [field, row[field]]),
      ...COUNT_FIELDS.map((field) => [field, 0]),
    ]));
    const group = groups.get(key);
    for (const field of COUNT_FIELDS) group[field] += row[field];
  }
  return [...groups.values()];
}

export function sumDailyUsage(rows) {
  return sumBy(rows, ["day", "model"]).sort((a, b) => compare(a.day, b.day) || compare(a.model, b.model));
}

/** Format dates, model names and token counts for the report template. */
export function prepareReport(report, month, rows, assistants, timezone, now = new Date()) {
  const [year, monthNumber] = month.split("-").map(Number);
  const monthEnd = `${month}-${String(new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()).padStart(2, "0")}`;
  if (!dayFormats.has(timezone)) dayFormats.set(timezone, new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }));
  const today = dayFormats.get(timezone).format(now);
  const modelTotals = sumBy(rows, ["model"]).sort((a, b) => b.tokens - a.tokens || compare(a.model, b.model));
  const formatRow = ({ day, model, input, output, cacheWrite, cacheRead, tokens }) => ({
    ...(day && { day }),
    ...(model && { model: formatModelName(model) }),
    ...Object.fromEntries(Object.entries({ input, output, cache_write: cacheWrite, cache_read: cacheRead, tokens }).map(([key, value]) => [key, countFormat.format(value)])),
  });
  const assistantNames = listFormat.format(assistants);
  return {
    supplier: report.supplier,
    account: report.account_name && report.account_email
      ? `${report.account_name} <${report.account_email}>`
      : report.account_name ?? report.account_email ?? "",
    subtitle: `Usage through ${assistantNames}, ${monthFormat.format(new Date(Date.UTC(year, monthNumber - 1)))}`,
    assistants: assistantNames,
    timezone,
    first_day: dateFormat.format(new Date(`${month}-01`)),
    last_day: dateFormat.format(new Date(today < monthEnd ? today : monthEnd)),
    generated_at: `${dateFormat.format(now)}, ${timeFormat.format(now)}`,
    models: modelTotals.map(formatRow),
    daily: rows.map(formatRow),
    totals: formatRow(sumBy(rows, []).at(0)),
  };
}

/** Assign each row to the first matching report. */
export function groupReports(rows, reports) {
  const entries = Object.entries(reports);
  const rowsByReport = Object.fromEntries(entries.map(([name]) => [name, []]));
  const unmatched = new Set();
  for (const row of rows) {
    const label = `${row.assistant}:${row.provider}`;
    const name = entries.find(([, report]) => report.match.includes(label))?.[0];
    if (name) rowsByReport[name].push(row);
    else unmatched.add(label);
  }
  return { rowsByReport, unmatched: [...unmatched].sort() };
}

let compiler;

export function writePdf(path, data) {
  compiler ??= NodeCompiler.create({ workspace: ASSETS_DIR, fontArgs: [{ fontPaths: [INTER_FONT_DIR] }] });
  const pdf = compiler.pdf({ mainFilePath: join(ASSETS_DIR, "report.typ"), inputs: { data: JSON.stringify(data) } });
  replaceFile(path, pdf);
}

/** Write a PDF for each report and month with usage, and return the file paths. */
export function writeReports(rows, config, reportsDir, { log = console.error, write = writePdf } = {}) {
  for (const name of Object.keys(config.reports)) validateName(name);
  const { rowsByReport, unmatched } = groupReports(rows, config.reports);
  if (unmatched.length) log(`WARNING: no report matches: ${unmatched.join(", ")}`);
  const paths = [];
  for (const [name, reportRows] of Object.entries(rowsByReport)) {
    const months = Map.groupBy(reportRows, (row) => row.day.slice(0, 7));
    for (const [month, monthRows] of [...months].sort(([a], [b]) => compare(a, b))) {
      if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`invalid usage month: ${month}`);
      const assistants = Object.entries(ASSISTANT_NAMES).filter(([assistant]) => monthRows.some((row) => row.assistant === assistant)).map(([, name]) => name);
      const path = outputPath(reportsDir, `${name}-${month}.pdf`);
      write(path, prepareReport(config.reports[name], month, sumDailyUsage(monthRows), assistants, config.timezone));
      paths.push(path);
    }
  }
  return paths;
}
