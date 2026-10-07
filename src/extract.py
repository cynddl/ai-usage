"""Extract usage records from Claude Code, Codex, OpenCode and pi logs."""

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

SOURCE_HOME = Path(sys.argv[1] if len(sys.argv) > 1 else "~").expanduser()
LOG_LOCATIONS = {
    "claude": (".claude", ["projects"]),
    "codex": (".codex", ["sessions", "archived_sessions"]),
    "pi": (".pi/agent", ["sessions"]),
}
OPENCODE_DIRECTORY = ".local/share/opencode"


def select_fields(record: dict, fields: tuple) -> dict:
    return {field: record[field] for field in fields if field in record}


def read_log_entries(path: Path) -> dict:
    """Read JSON objects, skipping invalid lines and other JSON values."""
    with path.open(encoding="utf-8", errors="replace") as log_file:
        for line in log_file:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if isinstance(entry, dict):
                yield entry


def extract_claude_usage(path: Path) -> dict[str, list[dict]]:
    records = []
    for entry in read_log_entries(path):
        message = entry.get("message")
        if isinstance(message, dict) and isinstance(message.get("usage"), dict):
            records.append(
                {
                    **select_fields(
                        entry,
                        ("type", "timestamp", "sessionId", "version", "requestId", "isApiErrorMessage"),
                    ),
                    "message": select_fields(message, ("id", "model", "usage")),
                },
            )
    return {"anthropic": records}


EXCLUDED_CODEX_MODELS = {"codex-auto-review"}


def extract_codex_usage(path: Path) -> dict[str, list[dict]]:
    records, provider = [], "openai"
    for entry in read_log_entries(path):
        entry_type, payload = entry.get("type"), entry.get("payload")
        if not isinstance(payload, dict):
            continue
        if entry_type == "session_meta":
            provider = payload.get("model_provider") or provider
            # Keep fields that identify copied session history.
            payload = select_fields(
                payload,
                (
                    "id",
                    "session_id",
                    "timestamp",
                    "cli_version",
                    "model_provider",
                    "originator",
                    "context_window",
                    "source",
                    "thread_source",
                    "history_mode",
                    "subagent_history_start_ordinal",
                    "forked_from_id",
                ),
            )
        elif entry_type == "turn_context":
            if payload.get("model") in EXCLUDED_CODEX_MODELS:
                return {}
            payload = select_fields(payload, ("model", "effort", "turn_id", "root_turn_id", "service_tier"))
        elif entry_type == "event_msg" and payload.get("type") == "token_count":
            payload = select_fields(payload, ("type", "info"))
        elif entry_type != "token_usage_record":
            continue
        records.append({**select_fields(entry, ("type", "timestamp", "ordinal")), "payload": payload})
    has_usage = any(record["type"] in ("event_msg", "token_usage_record") for record in records)
    return {provider: records} if has_usage else {}


def extract_pi_usage(path: Path) -> dict[str, list[dict]]:
    session_records, messages_by_provider = [], defaultdict(list)
    for entry in read_log_entries(path):
        message = entry.get("message")
        if entry.get("type") == "session":
            session_records.append(select_fields(entry, ("type", "id", "timestamp", "version", "parentSession")))
        elif entry.get("type") == "model_change":
            session_records.append(select_fields(entry, ("type", "id", "parentId", "timestamp", "provider", "modelId")))
        elif (
            entry.get("type") == "message"
            and isinstance(message, dict)
            and message.get("role") == "assistant"
            and isinstance(message.get("usage"), dict)
        ):
            messages_by_provider[message.get("provider") or "unknown"].append(
                {
                    **select_fields(entry, ("type", "id", "parentId", "timestamp")),
                    "message": select_fields(
                        message,
                        (
                            "role",
                            "provider",
                            "api",
                            "model",
                            "responseModel",
                            "responseId",
                            "usage",
                            "stopReason",
                            "timestamp",
                        ),
                    ),
                },
            )
    return {provider: session_records + records for provider, records in messages_by_provider.items()}


def safe_name(name) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", str(name))


def read_opencode_messages(data_directory: Path) -> tuple[str, dict]:
    """Read messages from older OpenCode JSON files, then from its SQLite databases."""
    for path in sorted((data_directory / "storage" / "message").glob("*/*.json")):
        try:
            message = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        except ValueError:
            continue
        if isinstance(message, dict):
            yield f"storage/{safe_name(path.parent.name)}.jsonl", message
    for path in sorted(data_directory.glob("opencode*.db")):
        import sqlite3  # Some Python builds lack sqlite3, so import it only when needed.

        connection = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)
        try:
            query = "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message'"
            if not connection.execute(query).fetchone():
                continue
            for message_id, session_id, data in connection.execute(
                "SELECT id, session_id, data FROM message ORDER BY session_id, time_created, id",
            ):
                try:
                    message = json.loads(data)
                except (TypeError, ValueError):
                    continue
                if isinstance(message, dict):
                    # The database keeps message and session IDs outside the JSON data.
                    message = {**message, "id": message_id, "sessionID": session_id}
                    yield f"{path.stem}/{safe_name(session_id)}.jsonl", message
        finally:
            connection.close()


def extract_opencode_usage(data_directory: Path) -> tuple[str, str, dict]:
    """Yield (provider, session path, record) for each assistant message with token counts."""
    for relative_path, message in read_opencode_messages(data_directory):
        if message.get("role") == "assistant" and isinstance(message.get("tokens"), dict):
            record = select_fields(message, ("id", "sessionID", "role", "time", "providerID", "modelID", "tokens"))
            yield message.get("providerID") or "unknown", relative_path, record


def write_record(assistant: str, provider: str, relative_path: str, record: dict) -> None:
    line = json.dumps(record, separators=(",", ":"))
    sys.stdout.write(f"{assistant}/{safe_name(provider)}/{relative_path}\t{line}\n")


if __name__ == "__main__":
    EXTRACTORS = {"claude": extract_claude_usage, "codex": extract_codex_usage, "pi": extract_pi_usage}

    found_log_directory = False
    for assistant, (data_directory, log_folders) in LOG_LOCATIONS.items():
        for log_directory in (SOURCE_HOME / data_directory / folder for folder in log_folders):
            found_log_directory |= log_directory.is_dir()
            for path in sorted(log_directory.rglob("*.jsonl")):
                relative_path = path.relative_to(SOURCE_HOME / data_directory).as_posix()
                for provider, records in EXTRACTORS[assistant](path).items():
                    for record in records:
                        write_record(assistant, provider, relative_path, record)

    opencode_directory = SOURCE_HOME / OPENCODE_DIRECTORY
    found_log_directory |= opencode_directory.is_dir()
    for provider, relative_path, record in extract_opencode_usage(opencode_directory):
        write_record("opencode", provider, relative_path, record)

    sys.exit(0 if found_log_directory else 3)
