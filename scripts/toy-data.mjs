import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Write a small synthetic month of Claude logs and return its home directory. */
export function writeToyData(directory) {
  const home = join(directory, "home");
  const path = join(home, ".claude/projects/example/session.jsonl");
  const rows = [
    // Day, model, input, output, cache write, cache read.
    ["01", "claude-opus-5-5", 12000, 2400, 30000, 180000],
    ["01", "claude-sonnet-4-6", 8000, 1600, 20000, 120000],
    ["03", "claude-opus-5-5", 18000, 3600, 45000, 270000],
    ["03", "claude-sonnet-4-6", 10000, 2000, 25000, 150000],
    ["07", "claude-opus-5-5", 9000, 1800, 15000, 90000],
    ["07", "claude-sonnet-4-6", 6000, 1200, 10000, 60000],
    ["09", "claude-opus-5-5", 15000, 3000, 20000, 120000],
    ["09", "claude-sonnet-4-6", 7000, 1400, 15000, 90000],
    ["11", "claude-opus-5-5", 21000, 4200, 35000, 210000],
    ["11", "claude-sonnet-4-6", 12000, 2400, 30000, 180000],
    ["15", "claude-opus-5-5", 11000, 2200, 25000, 150000],
    ["15", "claude-sonnet-4-6", 9000, 1800, 20000, 120000],
    ["18", "claude-opus-5-5", 16000, 3200, 30000, 180000],
    ["18", "claude-sonnet-4-6", 5000, 1000, 10000, 60000],
    ["23", "claude-opus-5-5", 13000, 2600, 20000, 120000],
    ["23", "claude-sonnet-4-6", 11000, 2200, 25000, 150000],
    ["28", "claude-opus-5-5", 17000, 3400, 40000, 240000],
    ["28", "claude-sonnet-4-6", 8000, 1600, 15000, 90000],
  ];
  const records = rows.map(([day, model, input, output, cacheWrite, cacheRead], index) => ({
    type: "assistant",
    timestamp: `2026-09-${day}T10:00:00Z`,
    sessionId: "example-session",
    requestId: `example-request-${index}`,
    message: {
      id: `example-message-${index}`,
      model,
      usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead },
    },
  }));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  writeFileSync(join(directory, "ai-usage.toml"), `timezone = "Europe/London"

[reports.anthropic]
supplier = "Anthropic"
match = ["claude:anthropic"]
account_name = "Jane Doe"
account_email = "jane.doe@example.com"
`);
  return home;
}
