---
type: guide
description: Continue a text conversation from an .adf file in another harness (a custom loop or an agent SDK), then return the file to ADF — limits, read access, write rules, turn records, close, check
see_also:
  - ../../ADF_SPEC_v0.2.md — the file format; this guide links to its requirements and does not restate them
  - memory-management.md — the loop, compaction and audit inside ADF
  - security-and-identity.md — identity, envelopes and claim
  - tools.md — tool access controls (enabled, visible, restricted)
---

# ADF State in Other Harnesses

## Purpose

The state of an agent stays in a file that the owner holds, so another harness can read the file and continue the agent.

This guide gives one result: continue a text conversation from an `.adf` file in another harness, then return the file to ADF. The harness can be your own loop or an agent SDK. The guide applies to ADF commit `d664ea22` and `adf_schema_version` 32.

A harness that writes the file is a runtime that implements a subset of the runtime surfaces. [§2](../../ADF_SPEC_v0.2.md#2-the-adf-stack) lets a runtime do this if it keeps the file semantics that the spec defines. This guide links to the requirements. Each step also tells you the action and the warning that apply at that point.

Language: written to ASD-STE100 rules (Issue 9); not reviewed by a qualified STE reviewer.

## Limits

The example in this guide supports one execution profile:

- An existing `.adf` file at `adf_schema_version` 32. Use a copy that you can lose.
- The loop `main` only.
- One new owner message for each run, for example `Continue.`.
- The tools `fs_read` and `fs_write` (modes `write` and `append`) on text files in `adf_files`. No shell, network, messages, code or timers.
- One runtime has control of the file at a time.
- SDK persistence is off, or it is a cache that the harness makes again from the file for each run.

These parts of the agent do not move to the harness: connected accounts and channels, the sealed provider credential, scheduled work (timers), messages (inbox and mesh), MCP servers, inner loops and compaction. Every tool that the harness does not implement also stays behind. The file keeps all of these, and ADF uses them again when it runs the agent.

The example does not do these runtime actions, which the spec defines. Each omission is a gap against the spec, not a permission from §2:

- Skill index and catalog injection ([§5.1](../../ADF_SPEC_v0.2.md#51-top-level-shape)). The example does not index `skills/*` and does not send `skills-registry.json`.
- Tool-result limits from `limits.max_tool_result_tokens` ([§5.7](../../ADF_SPEC_v0.2.md#57-limits)).
- Dynamic instructions: inbox hints, context warnings, idle reminders and mesh updates ([§5.19](../../ADF_SPEC_v0.2.md#519-context-and-audit-configuration)).
- Media from `file_ref` blocks. The example sends the path as text ([§13.1](../../ADF_SPEC_v0.2.md#131-transcript-rows)).
- Autonomous turn behaviour, `say`, `ask` and owner approval ([§6.3](../../ADF_SPEC_v0.2.md#63-turn-behaviour), [§8.7](../../ADF_SPEC_v0.2.md#87-restricted-tools-and-methods)).
- The `pre_llm_hook` lambda and the `model` request settings, for example `temperature`.

If the config asks for an action that your harness does not support, refuse the run or tell the owner. Do not delete or change config fields to make the agent run.

## Terms

| Term | Definition in this guide |
|------|------------------------|
| harness | A program with its own agent loop: your own code, or a loop that an agent SDK gives. |
| runtime | A program that opens an `.adf` file and runs the agent: ADF Studio, the ADF daemon, or a harness that writes the file ([§0.3](../../ADF_SPEC_v0.2.md#03-terminology)). |
| turn | One run of a loop, from the owner message that starts it until the loop stops. A turn can contain more than one model request. |
| subset | A part of the runtime surfaces. The example implements a text loop and two file tools. |
| provider | The service that runs the model, for example Anthropic or OpenAI. |
| owner | The person who controls the agent and its keys. |
| body | The `.adf` file of one agent. |
| loop | A conversation stream in the agent. `main` is the loop that faces the owner. |
| transcript | The rows of one loop in `adf_loop`. |
| context row | A `user` row in `adf_loop` whose first block is text that starts with `[Context: `. It records prompt text that a runtime added ([§1.5](../../ADF_SPEC_v0.2.md#15-no-secrets-in-context)). |

## Requirements

### Model credential

The file names a provider and a model in `config.model`. `adf_identity` holds the key for that provider in a sealed form. The harness does not read it. Bring a credential of your own.

A model credential does not make you the owner of the file. Do not claim, adopt, rekey or unlock the identity of the agent. Keep `adf_identity`, `adf_attestations` and the identity keys in `adf_meta` as they are.

The example needs Python 3 and nothing more. Its default model is a stub, so no credential is necessary. For a real model, you supply a model command: an SDK or a CLI, and a credential of your own.

### Single writer

Before you write to the file (Level 2), stop the agent in ADF Studio or the ADF daemon. Then close the file in Studio.

Caution: Nothing in the file stops two writers today. ADF keeps its lease outside the file, in a directory on the computer. SQLite locks and `busy_timeout` prevent a damaged database. They do not prevent two runtimes that add turns to one transcript.

ADF deletes `adf_clean_close` from `adf_meta` when it opens a file. If the key is absent, a runtime has the file open, or the last session did not close. The example stops in that case.

### Copy

1. Stop the agent in ADF ([Single writer](#single-writer)).
2. Copy the `.adf` file before the first run.
3. Do all runs on the copy.
4. Keep the original until a run and a check succeed.

Copy a file only when no runtime has it open. A copy of an open file can miss data that is still in the `-wal` file beside it.

## Example

The example runs one owner turn with the Level 2 rules of this guide. It checks the schema version and `adf_clean_close`. It records the owner message and the prompt before it sends a request. It gives the model `fs_read` and `fs_write`, and it closes the file cleanly.

Save the program as `adf_turn.py` and run it on a copy:

```sh
cp agent.adf work.adf
python3 adf_turn.py work.adf "Continue."
python3 adf_turn.py work.adf "Continue." --model stub-text
python3 adf_turn.py work.adf "Continue." --model "python3 my_model.py"
```

The model options:

- `stub-write` (default): the stub reads `mind.md`, appends a line to `notes/harness.md`, then replies.
- `stub-text`: the stub replies with text only.
- Any other value is a model command. The program starts it one time for each model request.

The model command protocol:

1. The program writes one JSON object to the standard input of the command: `{"system": text, "messages": [...], "tools": [...]}`.
2. `messages` use the block shapes in the [appendix](#appendix-block-shapes). Each tool has `name`, `description` and `input_schema`.
3. The command writes one JSON object to standard output: `{"text", "tool_calls": [{"name", "input"}], "model", "usage"}`. All keys are optional.
4. `usage` has `input_tokens` and `output_tokens`. An exit status that is not 0 is a failed request.

```python
#!/usr/bin/env python3
"""Run one owner turn of an .adf agent outside ADF. Python 3 standard library only.
Usage: python3 adf_turn.py AGENT.adf "MESSAGE" [--model stub-write|stub-text|"COMMAND"]"""
import json, re, shlex, sqlite3, subprocess, sys, time
from datetime import datetime, timezone

SCHEMA_VERSION = "32"  # the adf_schema_version this program was written against
IDENTITY_KEYS = ("adf_did", "adf_owner_did", "adf_runtime_did", "adf_did_history")
FINISHED = ("completed", "interrupted", "failed")  # adf_runtime_turn_checkpoint statuses of a finished turn
STR = {"type": "string"}
FS_TOOLS = {"fs_read": {"description": "Read a text file.", "input_schema": {"type": "object",
                        "properties": {"path": STR}, "required": ["path"]}},
            "fs_write": {"description": "Write (replace) or append to a text file.", "input_schema": {"type": "object",
                         "properties": {"mode": {"enum": ["write", "append"]}, "path": STR, "content": STR},
                         "required": ["mode", "path", "content"]}}}

def now_ms(): return int(time.time() * 1000)
def now_iso(): return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
def dumps(v): return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
def text(t): return [{"type": "text", "text": t}]

def open_writable(path):  # phase 1: validate and open
    db = sqlite3.connect(path, isolation_level=None)  # each write phase has its own BEGIN and COMMIT
    meta = lambda k: (db.execute("SELECT value FROM adf_meta WHERE key = ?", (k,)).fetchone() or [None])[0]
    if meta("adf_schema_version") != SCHEMA_VERSION:
        sys.exit(f"stop: adf_schema_version is {meta('adf_schema_version')}; this program supports {SCHEMA_VERSION}")
    if meta("adf_clean_close") is None:
        sys.exit("stop: adf_clean_close is absent; a runtime has the file open, or it did not close")
    if json.loads(meta("adf_runtime_turn_checkpoint") or '{"status": "completed"}').get("status") not in FINISHED:
        sys.exit("stop: an ADF turn is in progress or in an unknown state; open the file in ADF first")
    for pragma in ("journal_mode = WAL", "synchronous = NORMAL", "busy_timeout = 5000", "foreign_keys = ON"):
        db.execute("PRAGMA " + pragma)
    db.execute("BEGIN IMMEDIATE")
    db.execute("DELETE FROM adf_meta WHERE key = 'adf_clean_close'")
    db.execute("UPDATE adf_meta SET protection = 'readonly' WHERE key IN (?, ?, ?, ?)"
               " AND protection <> 'readonly'", IDENTITY_KEYS)  # identity-meta repair (spec 4.4)
    db.execute("COMMIT")
    return db

def close(db):  # phase 7: clean close, then checkpoint
    if db.in_transaction: db.execute("ROLLBACK")  # an unfinished tool batch only; earlier phases stay
    db.execute("INSERT INTO adf_meta (key, value, protection) VALUES ('adf_clean_close', ?, 'readonly')", (now_iso(),))
    busy = db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]
    db.close()
    if busy: print("warning: checkpoint incomplete; keep the -wal file beside the .adf", file=sys.stderr)

def append_rows(db, *rows):  # one phase: (role, blocks, model, tokens) rows, then COMMIT
    db.execute("BEGIN IMMEDIATE")
    for role, blocks, model, tokens in rows:
        db.execute("INSERT INTO adf_loop (role, content_json, model, tokens, created_at, ord, loop)"
                   " VALUES (?, ?, ?, ?, ?, NULL, 'main')", (role, dumps(blocks), model, tokens and dumps(tokens), now_ms()))
    db.execute("COMMIT")

def history(db):  # the active history: the stored transcript without context rows
    messages, keyed = [], {}
    for role, cj in db.execute("SELECT role, content_json FROM adf_loop WHERE loop = 'main' ORDER BY COALESCE(ord, seq), seq"):
        blocks = json.loads(cj)
        blocks = text(blocks) if isinstance(blocks, str) else blocks
        first = blocks[0].get("text", "") if blocks and blocks[0].get("type") == "text" else ""
        if first.startswith("[Context: "):
            key = re.match(r"\[Context: \S+ \| loop_inject=v2 \| origin=\S+ \| key=([\w.:-]+)\] ", first)
            if key and role == "user" and len(blocks) == 1: keyed[key.group(1)] = first  # newest row per key
            continue  # every other context row is a record only
        blocks = [text(f"[file: {b['file_ref']['path']}]")[0] if b.get("type") == "file_ref" else b for b in blocks]
        blocks = [b for b in blocks if b.get("type") in ("text", "tool_use", "tool_result")]
        if blocks: messages.append({"role": role, "content": blocks})
    return messages + [{"role": "user", "content": text(t)} for t in keyed.values()]

def exposed_tools(config):  # enabled and visible; restricted needs owner approval, so not exposed
    decl = [t for t in config.get("tools", []) if t.get("enabled") and t.get("visible")]
    tools = {t["name"]: FS_TOOLS[t["name"]] for t in decl if t["name"] in FS_TOOLS and not t.get("restricted")}
    absent = [t["name"] for t in decl if t["name"] not in tools]
    if absent: print("note for the owner: not available in this runtime: " + ", ".join(absent), file=sys.stderr)
    return tools

def system_prompt(db, config, tools):
    prompt = config.get("instructions", "")
    if not config.get("bare_prompt") and config.get("include_base_prompt") is not False:
        prompt = "Your memory (mind.md):\n{{mind.md}}\n\nYour voice (soul.md):\n{{soul.md}}\n\n" + prompt
    def fill(m):  # files only, one pass, missing-file marker (spec 5.1)
        row = db.execute("SELECT content FROM adf_files WHERE path = ?", (m.group(1),)).fetchone()
        return bytes(row[0]).decode("utf-8", "replace") if row else f"[missing file: {m.group(1)}]"
    return re.sub(r"\{\{([^{}]+)\}\}", fill, prompt) + (f"\n\nThis runtime gives you these tools only: "
        f"{', '.join(tools) or 'none'}. Other tools that your instructions name are not available here.")

def run_tool(db, config, tools, name, args):  # runs inside the BEGIN of phases 5 and 6
    path = str(args.get("path", ""))
    if name not in tools: return f"Tool {name} is not available in this runtime.", True
    if not path or path.startswith("/") or ".." in path.split("/"): return f"Refused: bad path {path!r}.", True
    row = db.execute("SELECT content, mime_type, protection FROM adf_files WHERE path = ?", (path,)).fetchone()
    try: old = bytes(row[0]).decode("utf-8") if row else ""
    except UnicodeDecodeError: old = None
    if row and (old is None or not str(row[1] or "").startswith(("text/", "application/json"))):
        return f"Refused: {path} is not a text file.", True
    if name == "fs_read": return (old, False) if row else (f'File not found: "{path}"', True)
    if row and row[2] == "read_only": return f'Cannot write to "{path}": file is read-only.', True
    if args.get("mode") not in ("write", "append"): return "Only modes write and append are available.", True
    data = ((old if args["mode"] == "append" else "") + str(args.get("content", ""))).encode("utf-8")
    if len(data) > config.get("limits", {}).get("max_file_write_bytes", 5000000): return "Refused: too large.", True
    if row:  # an agent write clears authorized (spec 4.3)
        db.execute("UPDATE adf_files SET content = ?, size = ?, authorized = 0, updated_at = ? WHERE path = ?",
                   (data, len(data), now_iso(), path))
    else:
        db.execute("INSERT INTO adf_files (path, content, mime_type, size, protection, authorized, created_at, updated_at)"
                   " VALUES (?, ?, ?, ?, 'none', 0, ?, ?)", (path, data, "text/markdown" if path.endswith(".md")
                   else "text/plain", len(data), now_iso(), now_iso()))
    return f'Wrote {len(data)} bytes to "{path}" ({args["mode"]}).', False

def call_model(model, request):  # one JSON request on stdin, one JSON reply on stdout
    if model == "stub-write" and request["messages"][-1]["content"][0]["type"] != "tool_result":
        return {"model": "stub", "tool_calls": [{"name": "fs_read", "input": {"path": "mind.md"}},
                {"name": "fs_write", "input": {"mode": "append", "path": "notes/harness.md", "content": "One turn.\n"}}]}
    if model.startswith("stub-"): return {"model": "stub", "text": "Stub reply. No model ran."}
    done = subprocess.run(shlex.split(model), input=dumps(request), capture_output=True, text=True)
    if done.returncode != 0: raise RuntimeError(f"model command failed: {done.stderr[-300:]}")
    return json.loads(done.stdout)

def main(path, message, model):
    db = open_writable(path)
    try:
        config = json.loads(db.execute("SELECT config_json FROM adf_config WHERE id = 1").fetchone()[0])
        tools = exposed_tools(config)
        system = system_prompt(db, config, tools)
        messages = history(db) + [{"role": "user", "content": text(message)}]
        append_rows(db, ("user", text(message), None, None),  # phase 2: record before dispatch
                    ("user", text("[Context: system_prompt] " + system), None, None))
        for step in range(10):
            reply = call_model(model, {"system": system, "messages": messages,  # phase 3: dispatch
                                       "tools": [dict(name=n, **t) for n, t in tools.items()]})
            calls = [{"type": "tool_use", "id": f"tu_{now_ms()}_{step}_{i}", "name": c["name"], "input": c.get("input", {})}
                     for i, c in enumerate(reply.get("tool_calls") or [])]
            blocks = (text(reply["text"]) if reply.get("text") else []) + calls
            usage = reply.get("usage") or {}
            append_rows(db, ("assistant", blocks or text(""), reply.get("model") or config["model"].get("model_id")
                             or "unknown", {"input": usage.get("input_tokens", 0), "output": usage.get("output_tokens", 0)}))
            messages.append({"role": "assistant", "content": blocks})  # phase 4 done
            if not calls: return print(reply.get("text", ""))
            db.execute("BEGIN IMMEDIATE")  # phases 5 and 6: run the tools, record the results
            results = [{"type": "tool_result", "tool_use_id": c["id"], "content": out, "is_error": err}
                       for c in calls for out, err in [run_tool(db, config, tools, c["name"], c["input"])]]
            db.execute("INSERT INTO adf_loop (role, content_json, created_at, ord, loop) VALUES ('user', ?, ?, NULL, 'main')",
                       (dumps(results), now_ms()))
            db.execute("COMMIT")
            messages.append({"role": "user", "content": results})
        print("stop: 10 model requests in one turn", file=sys.stderr)
    finally:
        close(db)

if __name__ == "__main__":
    args = sys.argv[1:]
    model = args.pop(args.index("--model") + 1) if "--model" in args else "stub-write"
    main(*[a for a in args if a != "--model"][:2], model)
```

Expected result of a run with the default stub: the program prints `Stub reply. No model ran.` The transcript has five new rows: the owner message, the context row, the tool calls, the tool results and the reply. The file `notes/harness.md` is new, and no `-wal` or `-shm` file stays beside the `.adf` file.

## File layout

| Data | Location in the file | Harness action |
|------|----------------------|----------------|
| Config and instructions | `adf_config.config_json` | Read. Do not write. |
| Memory and voice | `adf_files` paths `mind.md`, `soul.md` | Read for the prompt. Write only through `fs_write`. |
| Other agent files | `adf_files` | Read and write through the file tools. `adf_files` is not a directory on the host. |
| Transcript | `adf_loop` rows with `loop = 'main'` | Read. Append rows. Do not change or delete rows. |
| Inner-loop transcripts | `adf_loop` rows with another `loop` value | Do not read into `main`. Do not change. |
| Identity facts | `adf_meta` keys `adf_did`, `adf_owner_did`, `adf_runtime_did`, `adf_did_history` | Do not change values. Repair the protection only ([Write access](#write-access)). |
| Keys and secrets | `adf_identity` | Do not read. Do not write. Never put its contents into a prompt ([§1.5](../../ADF_SPEC_v0.2.md#15-no-secrets-in-context)). |
| Attestations | `adf_attestations` | Do not change. |
| Messages | `adf_inbox`, `adf_outbox` | Do not change. |
| Timers and tasks | `adf_timers`, `adf_tasks` | Do not change. |
| Audit snapshots | `adf_audit` | Do not change. Do not load them into history. |
| Harness state | your own `local_<harness>_*` tables ([§3.4](../../ADF_SPEC_v0.2.md#34-user-tables)) | Create and write. |
| Small harness cursors | `adf_meta` keys `runtime_<harness>_*` ([§3.3](../../ADF_SPEC_v0.2.md#33-field-reference-data-dictionary)) | Create and write. Keep other `runtime_*` keys as they are. |

These values are different:

- An `adf_loop.seq` or a `tool_use` id is not an SDK run id, response id or checkpoint id.
- SDK `reasoning` items, approval events, handoffs and graph state are not transcript rows.
- An SDK session store is not a second source of truth. It is a cache of `adf_loop`.
- The provider credential, the runtime settings and the base prompt of ADF are not in the file ([§16](../../ADF_SPEC_v0.2.md#16-portability)).

## Read access

Level 1 gives read access only. It cannot damage the file, and most readers start here. Use it for memory, history and files.

1. Open the file in read-only mode: `sqlite3.connect("file:agent.adf?mode=ro", uri=True)`.
2. Read `adf_config.config_json` and `instructions`.
3. Read the files that the instructions name in `{{path}}` placeholders.
4. Read the transcript with the query below.

```sql
SELECT seq, role, content_json, model, created_at
FROM adf_loop
WHERE loop = 'main'
ORDER BY COALESCE(ord, seq), seq;
```

Both parts of this query are necessary. A compaction summary row has an `ord` value, so `COALESCE(ord, seq)` puts it before the rows that it summarizes. Rows of inner loops are in the same table, so `WHERE loop = 'main'` removes them.

Keep three items separate: the stored transcript, the active history, and the request that you send. The stored transcript is all rows. The active history is the rows that you give to the model again, in the order of the query. The request is the active history in the form of your provider, with your system prompt.

Use this replay policy for context rows. ADF at commit `d664ea22` uses the same policy:

| Row | First text | Replay |
|-----|------------|--------|
| System prompt snapshot | `[Context: system_prompt] ` | Skip. Your harness sends its own prompt. |
| Dynamic instructions | `[Context: dynamic_instructions] ` | Skip. They applied to one earlier request. |
| Status notice | `[Context: status] ` | Skip. |
| Provider context | `[Context: provider_context \| from=<name>] ` | Skip. |
| Keyed injection | `[Context: <category> \| loop_inject=v2 \| origin=<origin> \| key=<key>] ` | Send the newest row for each key as a user message. |
| Injection without a key | `[Context: <category> \| loop_inject=v2 \| origin=<origin>] ` | Skip. It applied one time. |
| Compaction summary | `[Loop Compacted] ` or `[Loop Compacted, audited] ` | Send. It is not a context row. |

Note: The skills catalog of ADF is a keyed injection with `key=skills_registry`.

Do not put the contents of `adf_identity` into a prompt. Do not load `adf_audit` snapshots into the history.

Unread messages in `adf_inbox` stay unread. The model does not see them in a harness that does not read them.

## Write access

Level 2 gives write access. Before you start, stop the agent in ADF ([Single writer](#single-writer)) and use a copy ([Copy](#copy)).

### Open

1. Open the file in read-write mode.
2. Read `adf_meta.adf_schema_version`.
3. If the value is not 32, close the file or open it in read-only mode. Do not write ([§3.5](../../ADF_SPEC_v0.2.md#35-schema-migration)).
4. If `adf_clean_close` is absent, stop. A runtime has the file open, or the last session did not close.
5. Read the `status` in `adf_runtime_turn_checkpoint`. If it is not `completed`, `interrupted` or `failed`, stop. Open the file in ADF for recovery.
6. Apply the pragmas of [§3.1](../../ADF_SPEC_v0.2.md#31-sqlite-pragmas).
7. Delete `adf_clean_close`.
8. Set `readonly` again on the four identity keys. Use the narrow `UPDATE` below.

```sql
UPDATE adf_meta SET protection = 'readonly'
WHERE key IN ('adf_did', 'adf_owner_did', 'adf_runtime_did', 'adf_did_history')
  AND protection <> 'readonly';
```

Steps 7 and 8 are runtime work on the state of the file, the same as the close record. They are not agent metadata tools. Step 8 changes the protection only, never a value, and never makes a protection weaker ([§4.4](../../ADF_SPEC_v0.2.md#44-meta-protection)). A read-only open writes nothing.

Write no other `adf_*` key in `adf_meta`. Do not change protections. Do not write `adf_config` or `adf_identity`. Keep harness data in `local_<harness>_*` tables, or in `runtime_<harness>_*` keys for small values.

Use narrow, parameterized `INSERT` and `UPDATE` statements only. Do not use `INSERT OR REPLACE`. Do not make a table again, and do not copy the data into a new database. These actions can lose columns, keys and rows that your harness does not know ([§0.2](../../ADF_SPEC_v0.2.md#02-data-conventions)).

### Turn records

Append rows to `adf_loop`. Do not `UPDATE` or `DELETE` a row. Each new row has these values:

| Column | Value |
|--------|-------|
| `loop` | `'main'` |
| `ord` | `NULL` |
| `created_at` | epoch milliseconds, not less than the last row |
| `role` | `user` or `assistant`; roles alternate, and context rows do not count |
| `model` | the model id on `assistant` rows; `NULL` on `user` rows |
| `tokens` | JSON with `input` and `output` on `assistant` rows |
| `content_json` | a JSON array of blocks |

Do a turn in these phases. Phases 2, 4 and 6 end with `COMMIT`:

1. Check and open the file ([Open](#open)).
2. Append the owner message as a `user` row. Append your system prompt as a context row: `[Context: system_prompt] ` and the prompt. Commit before you send the request.
3. Send the request to the model.
4. Append the response as an `assistant` row, with its tool calls. Commit.
5. Run the supported tools.
6. Append the tool results as one `user` row. Commit with the file changes.
7. Go back to phase 3 until the model replies with no tool call. Then close ([Close](#close)).

A request that reached the provider stays on record, also if the harness fails later ([§1.5](../../ADF_SPEC_v0.2.md#15-no-secrets-in-context)). Do not roll back a phase after you send the request. A `ROLLBACK` cannot cancel the cost of a request or a tool action that occurred.

Write only these block types: `text`, `tool_use` and `tool_result`. Put a `tool_result` block for each call in the row after a `tool_use` row. ADF at commit `d664ea22` sends `text`, `tool_use`, `tool_result` and media blocks to the model. It drops `thinking` blocks, except for OpenRouter `reasoning_details`, and it drops types that it does not know. Do not write `thinking` blocks.

If a row has a `file_ref` block, send its path to your model as text ([§13.1](../../ADF_SPEC_v0.2.md#131-transcript-rows)). Keep the row as it is.

Use the ADF name for a tool that ADF also has, for example `fs_read` and `fs_write`. For a tool that ADF does not have, do not write `tool_use` rows. Record the call and its result as a `text` block in the `assistant` row. Do not put the result in a `user` row: ADF reads a `user` row as the owner. Do not put it in a context row: replay skips context rows. Tell the model which tools in its instructions your harness does not give.

### Tool access

Give the model a tool only if its declaration in `config.tools` has `enabled` and `visible` set to `true` ([§5.4](../../ADF_SPEC_v0.2.md#54-tool-declarations)).

A tool with `restricted: true` needs owner approval for each model call ([§8.7](../../ADF_SPEC_v0.2.md#87-restricted-tools-and-methods)). If your harness cannot ask the owner, do not give that tool to the model.

If the harness meets a capability or an approval that it cannot apply, tell the owner. Do not skip it without a message.

### File tools

The example supports `fs_read` and `fs_write` in modes `write` and `append`.

1. Refuse a write to a file with protection `read_only` ([§4.2](../../ADF_SPEC_v0.2.md#42-file-protection)).
2. Set `authorized = 0` on each write ([§4.3](../../ADF_SPEC_v0.2.md#43-file-authorization)).
3. Store `content` as a BLOB, `size` as its length in bytes, and `updated_at` as an ISO-8601 string.
4. Refuse a binary file. Do not decode it and write it again.

Rationale for step 2: `authorized = 1` lets the code in a file call restricted tools. A write by the model cannot keep that permission.

`fs_delete` and a file rename are not in the scope of this guide. They have rules that change transcript rows ([§13.1](../../ADF_SPEC_v0.2.md#131-transcript-rows)).

### Compaction

Compaction is not in the scope of this guide. If the history is too long for your model, cut it in memory only. Do not delete rows, and do not write a compaction row. To compact the transcript, open the agent in ADF ([§13.2](../../ADF_SPEC_v0.2.md#132-compaction)).

## Close

1. Write `adf_clean_close` with an ISO-8601 time and protection `readonly`. Make it the last write.
2. Run `PRAGMA wal_checkpoint(TRUNCATE)`.
3. Make sure that the first value of the result is 0. If it is 1, keep the `-wal` file beside the `.adf` file.
4. Close the connection.

After these steps, the `.adf` file alone holds the turn. You do not need the `-wal` or `-shm` file beside it. ADF also runs `wal_checkpoint(TRUNCATE)` before it closes a file.

The close does not move the parts in [Limits](#limits): accounts, channels, the provider credential, timers, messages, MCP servers and inner loops. `adf_clean_close` tells only that the file closed cleanly. It does not tell that the task is complete or that a tool ran one time.

## Check

Do a round-trip check after the first runs. Use a copy from before the run and the file after it, each without `-wal` or `-shm` files.

The round-trip check is a script that tests a fixed list of properties. It is not a conformance test. It examines these properties: the SQLite integrity check, an unchanged schema and file header, unchanged tables other than `adf_loop` and `adf_files`, and `adf_meta` key by key. It also examines old `adf_loop` rows byte for byte and the rules for new rows in [Turn records](#turn-records). It also examines tool pairs and the storage types of changed files.

## Return to ADF

Do the first return on a copy that you can lose, on a computer with no network connection. Studio does not start the agent when it opens the file. The daemon can start an agent that has `autostart: true`. A started agent can run triggers, timers and channel adapters.

When ADF opens a file that another program wrote, it does these actions:

- It reads `adf_clean_close`. If the key is absent, it runs `PRAGMA integrity_check`. Then it deletes the key.
- It runs migrations if the schema version is less than 32. A newer version opens with a warning only.
- It sets `readonly` again on the four identity keys.
- It adds missing default tools to `config.tools` and writes the config back.
- When it restores a loop, it repairs a `tool_use` with no result in memory. It does not change the rows.
- Studio sets `config.name` to the file name.

ADF can change the config of the file in these steps. Do not keep a copy of the config in your harness from one ADF session to the next. Read it again from the file.

The system prompt is different in each runtime. ADF adds its own base prompt and tool guidance from its runtime settings. These settings are not in the file: `adf_effective_runtime` holds only their hashes. A config with `bare_prompt: true` sends `instructions` only. A config with `include_base_prompt: false` removes the base prompt but keeps other sections ([§5.1](../../ADF_SPEC_v0.2.md#51-top-level-shape)). The agent can act differently in each runtime.

Identity:

- If this ADF install reviewed the agent before, the file opens as before.
- If not, Studio shows a review. It offers a claim if `adf_owner_did` is absent or names another owner.
- A claim gives the agent a new DID and adds the old DID to `adf_did_history` ([§8.4](../../ADF_SPEC_v0.2.md#84-envelope-and-lock-states)).
- Some files have a plain `crypto:signing:private_key` and no `adf_owner_did`. If you accept the review of such a file without a claim, Studio adds the owner and runtime DIDs. It also seals the key.

To make a new `.adf` file, use ADF Studio or the ADF CLI. This guide does not make files.

## Agent SDKs

The `.adf` file is the source of truth. The SDK store is a cache that the harness makes again from the file for each run. The sections below name the integration point of each SDK. Each name agrees with the SDK source and documents on 2026-11-26.

### Claude Agent SDK

Not run. Checked: Python `claude-agent-sdk` 0.2.189 and TypeScript `@anthropic-ai/claude-agent-sdk` 0.3.332.

- Prompt: pass your system prompt as a string in `ClaudeAgentOptions.system_prompt`.
- Tools: set `tools=[]` to remove the built-in tools. The built-in `Read`, `Write` and `Bash` tools use the host disk, not `adf_files`. Give `fs_read` and `fs_write` as custom tools with `@tool` and `create_sdk_mcp_server`.
- Settings: set `setting_sources=[]`. The default loads user and project settings, for example `CLAUDE.md`.
- Transcripts: the SDK keeps its own session transcript in `~/.claude/projects/`, so two transcripts exist. Make the SDK session from `adf_loop` for each run. The SDK does not take a list of messages. The `session_store` option (alpha) loads a session from your store, and the SDK still writes its local copy. Set `CLAUDE_CONFIG_DIR` to a temporary directory to discard that copy.
- Prompt text that the SDK adds is not under your control. Record what you can see as context rows. ADF records such text as `[Context: provider_context | from=<name>]`.

### OpenAI Agents SDK

Not run. Checked: `openai-agents` 0.26.0.

- Integration point: a custom `Session` with `get_items`, `add_items`, `pop_item` and `clear_session`. Pass it to `Runner.run(..., session=...)`.
- `get_items` reads `adf_loop` with the transcript query and converts rows to Responses API input items.
- `add_items` converts the items back to `text`, `tool_use` and `tool_result` blocks and appends rows. Do not store the item JSON as it is.
- Map each function call id to the `tool_use` id. Keep both in a `local_<harness>_*` table if you need them later.
- Do not use `SQLiteSession` at the same time. Choose one store.

### LangGraph

Not run. Checked: `langgraph` 1.2.24, `langgraph-checkpoint` 4.3.2.

- A checkpointer (`BaseCheckpointSaver`) holds the full graph state, not a transcript. A graph can run with no checkpointer.
- Put the messages of `MessagesState` in `adf_loop`. Put other graph state in a `local_<harness>_*` table.
- The shortest path: compile with no checkpointer, and give the full `messages` list from `adf_loop` for each run.
- A graph retry can run a tool again. A `COMMIT` does not prevent a second effect of the tool. The example in this guide is serial, and it does not resume a graph.

## Appendix: block shapes

These are the block shapes that ADF writes and reads at commit `d664ea22`. The spec does not define these shapes yet.

```json
{"type": "text", "text": "Part 2 is written."}
{"type": "tool_use", "id": "tu_1795692263176_341565", "name": "fs_write", "input": {"mode": "append", "path": "newsletter/PUBLISHED.md", "content": "part-2\n"}}
{"type": "tool_result", "tool_use_id": "tu_1795692263176_341565", "content": "Appended 7 characters to \"newsletter/PUBLISHED.md\"", "is_error": false}
{"type": "text", "text": "[Context: system_prompt] <the full system prompt>"}
{"type": "file_ref", "file_ref": {"path": "loop-upload/photo.png", "mime_type": "image/png", "size": 48213}}
```

A context row is a `user` row with one `text` block of that form. ADF writes `content_json` with no spaces and with non-ASCII characters as they are, as `JSON.stringify` does.
