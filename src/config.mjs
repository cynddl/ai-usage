import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import * as v from "valibot";
import { validateName, NAME_PATTERN } from "./files.mjs";

export const ASSISTANT_NAMES = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", pi: "pi" };
const ASSISTANTS = Object.keys(ASSISTANT_NAMES);
const nonemptyText = v.pipe(v.string(), v.trim(), v.minLength(1, "must not be empty"));
const fileName = v.pipe(v.string(), v.regex(NAME_PATTERN, "must start with a letter or digit and contain only letters, digits, dots, underscores or hyphens"));
const sshHost = v.pipe(nonemptyText, v.regex(/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be an SSH host name or user@host"));
const reportMatch = v.pipe(v.string(), v.regex(
  new RegExp(`^(${ASSISTANTS.join("|")}):[A-Za-z0-9._-]+$`),
  `must be "<assistant>:<provider>" with assistant ${ASSISTANTS.slice(0, -1).join(", ")} or ${ASSISTANTS.at(-1)}`,
));
const configSchema = v.strictObject({
  timezone: v.pipe(nonemptyText, v.check((zone) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, "must be a valid time zone name")),
  ssh: v.optional(v.array(sshHost), []),
  commands: v.optional(v.record(fileName, nonemptyText), {}),
  reports: v.pipe(v.record(fileName, v.strictObject({
    supplier: nonemptyText,
    match: v.pipe(v.array(reportMatch), v.minLength(1, "must list at least one assistant and provider")),
    account_name: v.optional(nonemptyText),
    account_email: v.optional(v.pipe(nonemptyText, v.email("must be a valid email address"))),
  })), v.check((reports) => Object.keys(reports).length > 0, "add at least one [reports.<name>] table")),
});

/** Build commands for local, SSH and custom sources. */
export function sourceCommands(config) {
  const sources = { local: { file: "python3", args: ["-"] } };
  const addSource = (name, command) => {
    validateName(name);
    if (Object.hasOwn(sources, name)) throw new Error(`config: source "${name}" is listed twice`);
    sources[name] = command;
  };
  for (const host of config.ssh ?? []) {
    const name = host.split("@").at(-1).split(".")[0];
    addSource(name, { file: "ssh", args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "python3", "-"] });
  }
  for (const [name, command] of Object.entries(config.commands ?? {})) addSource(name, { file: command, shell: true });
  return sources;
}

export function validateConfig(input) {
  const result = v.safeParse(configSchema, input);
  if (!result.success) {
    const issue = result.issues[0];
    throw new Error(`${v.getDotPath(issue) || "config"}: ${issue.message}`);
  }
  sourceCommands(result.output); // Check for duplicate source names before collecting.
  return result.output;
}

export function loadConfig(path) {
  try {
    return validateConfig(parseToml(readFileSync(path, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`no ${path} here: run \`ai-usage init\` first`);
    throw new Error(`${path}: ${error.message}`);
  }
}
