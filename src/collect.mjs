import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { ASSISTANT_NAMES, sourceCommands } from "./config.mjs";
import { replaceFile, validateName, outputPath } from "./files.mjs";
import { runProcess } from "./process.mjs";

const EXTRACT_SCRIPT = readFileSync(new URL("./extract.py", import.meta.url));
const NO_LOGS_EXIT_CODE = 3; // extract.py exit code when no log directory exists

/** Save `<path>\t<record>` lines by session; return record counts by assistant. */
export function saveRecords(usageDir, source, output) {
  const sourceDir = outputPath(usageDir, validateName(source));
  const recordsByPath = new Map();
  for (const line of output.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    let path;
    try { path = outputPath(sourceDir, line.slice(0, tab)); } catch { /* report the malformed line below */ }
    if (tab < 0 || !path?.endsWith(".jsonl") || !Object.hasOwn(ASSISTANT_NAMES, relative(sourceDir, path).split(sep)[0])) {
      throw new Error(`unexpected line from ${source}: ${JSON.stringify(line.slice(0, 80))}`);
    }
    if (!recordsByPath.has(path)) recordsByPath.set(path, []);
    recordsByPath.get(path).push(line.slice(tab + 1));
  }
  const counts = Object.fromEntries(Object.keys(ASSISTANT_NAMES).map((assistant) => [assistant, 0]));
  for (const [path, records] of recordsByPath) {
    replaceFile(path, records.join("\n") + "\n");
    counts[relative(sourceDir, path).split(sep)[0]] += records.length;
  }
  return counts;
}

/** Run the extractor and return its output, exit code and last error. */
export async function runSource({ file, args = [], shell = false }, options = {}) {
  const result = await runProcess(file, args, { ...options, shell, input: EXTRACT_SCRIPT, reject: false });
  let error = result.stderr?.trim().split("\n").at(-1) || result.shortMessage || "no error message";
  if (result.timedOut) error = "timed out";
  else if (result.isMaxBuffer) error = "output limit exceeded";
  return {
    exitCode: result.failed && result.exitCode === 0 ? null : result.exitCode ?? null,
    output: result.stdout,
    error,
  };
}

/** Collect sources one at a time to limit memory use; return 2 if any fail. */
export async function collectUsage(config, usageDir, log = console.error) {
  const failedSources = [];
  for (const [source, command] of Object.entries(sourceCommands(config))) {
    const { exitCode, output, error } = await runSource(command);
    if (exitCode === 0) {
      const counts = saveRecords(usageDir, source, output);
      const summary = Object.entries(counts).filter(([, count]) => count).map(([assistant, count]) => `${ASSISTANT_NAMES[assistant]} ${count}`);
      log(`${source.padEnd(10)} ok: records from ${summary.join(", ") || "none"}`);
    } else if (exitCode === NO_LOGS_EXIT_CODE) {
      log(`${source.padEnd(10)} no usage logs`);
    } else {
      log(`${source.padEnd(10)} FAILED (${exitCode}): ${error}`);
      failedSources.push(source);
    }
  }
  if (failedSources.length) log(`WARNING: collection is incomplete, failed sources: ${failedSources.join(", ")}`);
  return failedSources.length ? 2 : 0;
}
