---
type: guide
description: Read and write an .adf file from another harness (a custom loop or an agent SDK) — limits, read access, write rules, turn records, close, check, and a stub-model example that you inspect in ADF Studio
see_also:
  - ../../ADF_SPEC_v0.2.md — the file format; this guide links to its requirements and does not restate them
  - memory-management.md — the loop, compaction and audit inside ADF
  - security-and-identity.md — identity, envelopes and claim
  - tools.md — tool access controls (enabled, visible, restricted)
---

# ADF State in Other Harnesses

## Purpose

The state of an agent stays in a file that the owner holds, so another harness can read the file and continue the agent.

This guide shows how a harness can read and write an `.adf` file. The supplied Python example records a turn with a stub model, then you inspect that turn in ADF Studio. A real-model run needs a model command that you supply. The SDK sections describe integration points; they were not run. The guide applies to ADF commit `d664ea22` and `adf_schema_version` 32.

You need Python 3 and a terminal. This guide is for a developer who writes a harness. It is not a procedure to move an agent between Studio windows.

A harness that writes the file is a runtime that implements a subset of the runtime surfaces. [§2](../../ADF_SPEC_v0.2.md#2-the-adf-stack) lets a runtime do this if it keeps the file semantics that the spec defines. This guide links to the requirements. Each step also tells you the action and the warning that apply at that point.

Language: Uses ASD-STE100 Issue 9 as a writing guide; not assessed for conformance.

## Limits

The example in this guide supports one execution profile:

- An `.adf` file that ADF made, at `adf_schema_version` 32. Use a copy that you can lose.
- `config.state` is `active`, `idle` or `hibernate` ([State](#state)).
- The loop `main` only.
- One new owner message for each run, for example `Continue.`.
- The tools `fs_read` and `fs_write` (modes `write` and `append`) on the text types that ADF uses in `adf_files`. No shell, network, messages, code or timers.
- One runtime has control of the file at a time.
- SDK persistence is off, or it is a cache that the harness makes again from the file for each run.

These parts of the agent do not move to the harness: connected accounts and channels, the sealed provider credential, scheduled work (timers), messages (inbox and mesh), MCP servers, inner loops and compaction. Every tool that the harness does not implement also stays behind. The harness leaves the stored configuration and records unchanged. On return, available capabilities depend on the ADF install, credentials and runtime settings. An open of the file does not show that every connection works or that scheduled work completed.

The example does not do these runtime actions, which the spec defines. Each omission is a gap against the spec, not a permission from §2:

- Skill index ([§5.1](../../ADF_SPEC_v0.2.md#51-top-level-shape)). The example does not index `skills/*` and does not put `skills-registry.json` in the prompt. It sends the last skills catalog that ADF recorded as a keyed injection ([Read access](#read-access)).
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
| subset | A part of the runtime surfaces. The example implements a text loop and two file tools. |
| provider | The service that runs the model, for example Anthropic or OpenAI. |
| context row | A `user` row in `adf_loop` whose first block is text that starts with `[Context: `. It records prompt text that a runtime added ([§1.5](../../ADF_SPEC_v0.2.md#15-no-secrets-in-context)). |
| tracked directory | A directory that ADF Studio or the ADF daemon watches for `.adf` files. |

Other terms: [§0.3](../../ADF_SPEC_v0.2.md#03-terminology).

## Requirements

### Model credential

The file names a provider and a model in `config.model`. `adf_identity` can hold a sealed provider credential. This harness does not unlock it. Supply an external credential.

A model credential does not make you the owner of the file. Do not claim, adopt, rekey or unlock the identity of the agent. Keep `adf_identity`, `adf_attestations` and the identity keys in `adf_meta` as they are.

The example needs Python 3 and nothing more. Its default model is a stub, so no credential is necessary. For a real model, you supply a model command: an SDK or a CLI, and a credential of your own.

### Single writer

Caution: Nothing in the file stops two writers today. ADF keeps its lease outside the file, in a directory on the computer. SQLite locks and `busy_timeout` prevent a damaged database. They do not prevent two runtimes that add turns to one transcript.

ADF can write to a file that you did not open in ADF:

- When Studio or the daemon starts, it starts each agent with `autostart: true` in a tracked directory.
- The daemon also starts a new file with `autostart: true` that appears in a tracked directory. A copy of an agent that ADF reviewed starts in this way.
- ADF cannot start an agent that it did not review, or that has a password. A fleet message from Studio or the daemon to such an agent adds an owner row to its transcript.

Keep the harness copy outside all tracked directories. Do not send a message to the agent from Studio or the daemon while the harness has the file.

ADF deletes `adf_clean_close` from `adf_meta` when it opens a file. If the key is absent, a runtime has the file open, or the last session did not close. The example stops in that case.

### State

The example runs only when `config.state` is `active`, `idle` or `hibernate`. It stops for `off`, `suspended` or another value. A message to the harness does not restart or resume the agent ([§6.1](../../ADF_SPEC_v0.2.md#61-agent-states)).

ADF at commit `d664ea22` does not write `config.state` when you stop the agent in Studio or the daemon. A file that you stopped in the usual way keeps its state, and the example accepts it. If `config.state` is `off` or `suspended`, the owner changes it in ADF before the run, for example with `/config edit` in the terminal app.

### Copy

Do these steps in this order before the first run:

1. Stop the agent in ADF Studio or the ADF daemon.
2. Close the file in Studio.
3. Make sure that no runtime has the file open. Make sure that no `-wal` or `-shm` file is beside it. Make sure that `adf_meta` has the key `adf_clean_close`. The command below prints a row when the key is present and `None` when it is absent. If it prints `None`, a runtime has the file open, or the last session did not close: go back to step 1. The marker alone does not prove that the checkpoint completed or that no runtime can reopen the file. Also confirm the successful-checkpoint conditions in [Close](#close). If sidecar files remain or the checkpoint is uncertain, stop. Do not delete them, and do not copy the `.adf` file alone.
4. Copy the `.adf` file to a directory that Studio and the daemon do not track.
5. Do all runs on the copy. Keep the original until a run and a check succeed.

```sh
python3 -c "import sqlite3, sys; db = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro&immutable=1', uri=True); print(db.execute(\"SELECT value FROM adf_meta WHERE key = 'adf_clean_close'\").fetchone())" agent.adf
```

For the first run, make a disposable agent in Studio for practice. Do not copy an agent that you use, with personal history.

A copy of an open file can miss data that is still in the `-wal` file beside it.

## Example

The example runs one owner turn with the Level 2 rules of this guide. It checks the schema version, the turn state, `config.state` and `adf_clean_close`. It records the owner message and the prompt before it sends a request. It gives the model `fs_read` and `fs_write`, and it closes the file cleanly.

Save the program as `adf_turn.py`. Do the [Copy](#copy) steps, then run the supplied stub exercise on the copy:

```sh
mkdir -p ~/harness-work
cp agent.adf ~/harness-work/work.adf
python3 adf_turn.py ~/harness-work/work.adf "Continue."
python3 adf_turn.py ~/harness-work/work.adf "Continue." --model stub-text
```

`~/harness-work` is an example. Use a directory that ADF does not track.

Optional: a real model. `my_model.py` is your own program; this guide does not supply it. Run this command only after you supply that program and its provider credential:

```sh
python3 adf_turn.py ~/harness-work/work.adf "Continue." --model "python3 my_model.py"
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
import json, os, re, shlex, sqlite3, subprocess, sys, time
from datetime import datetime, timezone
from urllib.request import pathname2url

SCHEMA_VERSION = "32"  # the adf_schema_version this program was written against
IDENTITY_KEYS = ("adf_did", "adf_owner_did", "adf_runtime_did", "adf_did_history")
FINISHED = ("completed", "interrupted", "failed")  # adf_runtime_turn_checkpoint statuses of a finished turn
RUN_STATES = ("active", "idle", "hibernate")  # config.state values that take an owner message here
KEYED = re.compile(r"^\[Context: ([a-z][a-z0-9_.-]{0,63}) \| loop_inject=v2 \| origin=([a-zA-Z0-9_.:/-]{1,128})"
                   r"(?: \| key=([a-zA-Z0-9_.:-]{1,128}))?\] ([\s\S]*)$")  # ADF agent-session.ts:524
UNKNOWN = ("No result was recorded. The harness or runtime stopped before it recorded a result. The call may or may"
           " not have run. Check before you repeat it: read the target first, an append can already be in the file.")
STR = {"type": "string"}
FS_TOOLS = {"fs_read": {"description": "Read a text file.", "input_schema": {"type": "object",
                        "properties": {"path": STR}, "required": ["path"]}},
            "fs_write": {"description": "Write (replace) or append to a text file.", "input_schema": {"type": "object",
                         "properties": {"mode": {"enum": ["write", "append"]}, "path": STR, "content": STR},
                         "required": ["mode", "path", "content"]}}}
last_ms = 0  # created_at floor: never less than the last row (set in open_writable)

def now_ms():
    global last_ms
    last_ms = max(last_ms, int(time.time() * 1000))
    return last_ms
def now_iso(): return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
def dumps(v): return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
def text(t): return [{"type": "text", "text": t}]

def open_writable(path):  # phase 1: check and open
    global last_ms
    try:  # mode=rw: a wrong path stops here and creates no file
        db = sqlite3.connect("file:" + pathname2url(os.path.abspath(path)) + "?mode=rw", uri=True, isolation_level=None)
        meta = lambda k: (db.execute("SELECT value FROM adf_meta WHERE key = ?", (k,)).fetchone() or [None])[0]
        version = meta("adf_schema_version")
    except sqlite3.Error as e: sys.exit(f"stop: cannot read {path} as an .adf file: {e}")
    if version != SCHEMA_VERSION: sys.exit(f"stop: adf_schema_version is {version}; this program supports {SCHEMA_VERSION}")
    if json.loads(meta("adf_runtime_turn_checkpoint") or '{"status": "completed"}').get("status") not in FINISHED:
        sys.exit("stop: an ADF turn is in progress or in an unknown state; open the file in ADF first")
    state = json.loads(db.execute("SELECT config_json FROM adf_config WHERE id = 1").fetchone()[0]).get("state", "active")
    if state not in RUN_STATES: sys.exit(f"stop: config.state is {state}; the owner changes it in ADF first")
    for pragma in ("journal_mode = WAL", "synchronous = NORMAL", "busy_timeout = 5000", "foreign_keys = ON"):
        db.execute("PRAGMA " + pragma)
    db.execute("BEGIN IMMEDIATE")
    if db.execute("DELETE FROM adf_meta WHERE key = 'adf_clean_close'").rowcount != 1:  # read and delete in one step
        db.execute("ROLLBACK"); db.close()
        sys.exit("stop: adf_clean_close is absent; a runtime has the file open, or it did not close."
                 " Open it in ADF, and inspect the transcript and files before the next run.")
    db.execute("UPDATE adf_meta SET protection = 'readonly' WHERE key IN (?, ?, ?, ?)"
               " AND protection <> 'readonly'", IDENTITY_KEYS)  # identity-meta repair (spec 4.4)
    db.execute("COMMIT")
    last_ms = db.execute("SELECT COALESCE(MAX(created_at), 0) FROM adf_loop").fetchone()[0]
    return db

def close(db):  # phase 7: clean close, then checkpoint
    if db.in_transaction: db.execute("ROLLBACK")  # an unfinished tool batch only; earlier phases stay
    db.execute("INSERT INTO adf_meta (key, value, protection) VALUES ('adf_clean_close', ?, 'readonly')", (now_iso(),))
    busy = db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]
    db.close()
    if busy: print("warning: checkpoint incomplete; keep the .adf with its -wal and -shm files", file=sys.stderr)

def append_rows(db, *rows):  # one phase: (role, blocks, model, tokens) rows, then COMMIT
    db.execute("BEGIN IMMEDIATE")
    for role, blocks, model, tokens in rows:
        db.execute("INSERT INTO adf_loop (role, content_json, model, tokens, created_at, ord, loop)"
                   " VALUES (?, ?, ?, ?, ?, NULL, 'main')", (role, dumps(blocks), model, tokens and dumps(tokens), now_ms()))
    db.execute("COMMIT")

def sendable(b):  # file_ref becomes text (spec 13.1); empty text and other block types are not sent
    if b.get("type") == "file_ref":
        ref = b.get("file_ref") or {}
        name = str(ref.get("path", "")).split("/")[-1] or ref.get("path")
        return text(f"[deleted: {name}]" if ref.get("deleted") else f"[file: {ref.get('path')}]")[0]
    return b if b.get("type") in ("tool_use", "tool_result") or (b.get("type") == "text" and b.get("text")) else None

def repair(msgs):  # tool-pair repair in memory, as ADF restoreMessages does (agent-session.ts:303-477)
    out, held, open_ = [], [], set()
    for m in msgs:  # a user row inside an open tool pair moves after the results
        ids = {b.get("tool_use_id") for b in m["content"] if b["type"] == "tool_result"}
        if open_ and m["role"] == "user" and not ids: held.append(m); continue
        if m["role"] == "assistant":
            out += held; held = []; open_ = {b.get("id") for b in m["content"] if b["type"] == "tool_use"}
        else: open_ -= ids
        out.append(m)
        if not open_: out += held; held = []
    out += held
    while out:  # the history starts with a user message and no tool_result
        if out[0]["role"] == "assistant": out.pop(0); continue
        kept = [b for b in out[0]["content"] if b["type"] != "tool_result"]
        if kept: out[0]["content"] = kept; break
        out.pop(0)
    uses = {b.get("id") for m in out for b in m["content"] if b["type"] == "tool_use" and b.get("id")}
    results = {b.get("tool_use_id") for m in out for b in m["content"] if b["type"] == "tool_result" and b.get("tool_use_id")}
    tail = [b["id"] for b in (out[-1]["content"] if out and out[-1]["role"] == "assistant" else [])
            if b["type"] == "tool_use" and b.get("id") and b["id"] not in results]
    if tail:  # a call with no recorded result at the end: an unknown outcome, in the request only
        out.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": i, "content": UNKNOWN,
                                                 "is_error": True} for i in tail]})
        results |= set(tail)
    removed = 0
    for m in out:  # other calls with no result, and results with no call, are removed
        keep = [b for b in m["content"] if not (b["type"] == "tool_use" and b.get("id") not in results)
                and not (b["type"] == "tool_result" and b.get("tool_use_id") not in uses)]
        removed += len(m["content"]) - len(keep)
        m["content"] = keep or text("[Tool call removed — no matching result in history]" if m["role"] == "assistant"
                                    else "[Tool result removed — no matching call in history]")
    note = f"{len(tail)} call(s) with an unknown outcome, {removed} unpaired tool block(s) removed" if tail or removed else ""
    if note: print(f"warning for the owner: request-only repair: {note}.{' The model was told to check the target.' if tail else ''} Inspect the files before the next run.", file=sys.stderr)
    return out, note

def history(db):  # the active history: the stored transcript without context rows, repaired in memory
    messages, keyed = [], {}
    for role, cj in db.execute("SELECT role, content_json FROM adf_loop WHERE loop = 'main' ORDER BY COALESCE(ord, seq), seq"):
        blocks = json.loads(cj)
        blocks = text(blocks) if isinstance(blocks, str) else blocks
        first = blocks[0].get("text", "") if blocks and blocks[0].get("type") == "text" else ""
        if first.startswith("[Context: "):
            m = KEYED.match(first)
            if m and m.group(3) and role == "user" and len(blocks) == 1:  # newest row per key, in ADF's order
                keyed.pop(m.group(3), None); keyed[m.group(3)] = first
            continue  # every other context row is a record only
        blocks = [s for s in map(sendable, blocks) if s]
        if blocks: messages.append({"role": role, "content": blocks})
    return repair(messages) + ([{"role": "user", "content": text(t)} for t in keyed.values()],)

def exposed_tools(config):  # enabled and visible; restricted needs owner approval, so not exposed
    decl = [t for t in config.get("tools", []) if t.get("enabled") and t.get("visible")]
    tools = {t["name"]: FS_TOOLS[t["name"]] for t in decl if t["name"] in FS_TOOLS and not t.get("restricted")}
    absent = [t["name"] for t in decl if t["name"] not in tools]
    if absent: print("note for the owner: not available in this runtime: " + ", ".join(absent), file=sys.stderr)
    return tools

def system_prompt(db, config, tools):
    bare = config.get("bare_prompt") is True
    prompt = config.get("instructions", "")
    if not bare and config.get("include_base_prompt") is not False:
        prompt = "Your memory (mind.md):\n{{mind.md}}\n\nYour voice (soul.md):\n{{soul.md}}\n\n" + prompt
    def fill(m):  # files only, one pass, missing-file marker (spec 5.1)
        row = db.execute("SELECT content FROM adf_files WHERE path = ?", (m.group(1),)).fetchone()
        return bytes(row[0]).decode("utf-8", "replace") if row else f"[missing file: {m.group(1)}]"
    prompt = re.sub(r"\{\{([^{}]+)\}\}", fill, prompt)
    if bare: return prompt  # bare_prompt: instructions only; the tool schemas still go with the request
    return prompt + (f"\n\nThis runtime gives you these tools only: {', '.join(tools) or 'none'}."
                     " Other tools that your instructions name are not available here.")

def run_tool(db, config, tools, name, args):  # runs inside the BEGIN of phases 5 and 6
    path = str(args.get("path", ""))
    if name not in tools: return f"Tool {name} is not available in this runtime.", True
    if not path or path.startswith("/") or ".." in path.split("/"): return f"Refused: bad path {path!r}.", True
    row = db.execute("SELECT content, mime_type, protection FROM adf_files WHERE path = ?", (path,)).fetchone()
    try: old = bytes(row[0]).decode("utf-8") if row else ""
    except UnicodeDecodeError: old = None
    if row and old is None: return f"Refused: {path} is not UTF-8 text.", True  # strict decode; bytes stay as they are
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
    done = subprocess.run(shlex.split(model, posix=os.name != "nt"), input=dumps(request), capture_output=True,
                          text=True, encoding="utf-8")
    if done.returncode != 0: raise RuntimeError(f"model command failed: {done.stderr[-300:]}")
    return json.loads(done.stdout)

def main(path, message, model):
    db = open_writable(path)
    try:
        config = json.loads(db.execute("SELECT config_json FROM adf_config WHERE id = 1").fetchone()[0])
        tools = exposed_tools(config)
        system = system_prompt(db, config, tools)
        past, repaired, injected = history(db)
        messages = past + [{"role": "user", "content": text(message)}] + injected  # ADF's order
        append_rows(db, ("user", text(message), None, None),  # phase 2: record before dispatch
                    ("user", text("[Context: system_prompt] " + system), None, None),
                    *([("user", text(f"[Context: status] Request-only repair: {repaired}."), None, None)] if repaired else []))
        for step in range(10):
            reply = call_model(model, {"system": system, "messages": messages,  # phase 3: dispatch
                                       "tools": [dict(name=n, **t) for n, t in tools.items()]})
            calls = [{"type": "tool_use", "id": f"tu_{int(time.time() * 1000)}_{os.urandom(4).hex()}",  # unique, not from now_ms()
                      "name": str(c.get("name")),
                      "input": c.get("input") if isinstance(c.get("input"), dict) else {"value": c.get("input")}}
                     for c in reply.get("tool_calls") or []]
            blocks = (text(reply["text"]) if reply.get("text") else []) + calls
            if not blocks: print("warning: the model returned no text and no tool call", file=sys.stderr); break
            usage = reply.get("usage")
            append_rows(db, ("assistant", blocks, reply.get("model") or config["model"].get("model_id") or "unknown",
                             {"input": usage.get("input_tokens"), "output": usage.get("output_tokens")} if usage else None))
            messages.append({"role": "assistant", "content": blocks})  # phase 4 done
            if not calls: return print(reply.get("text", ""))
            db.execute("BEGIN IMMEDIATE")  # phases 5 and 6: run the tools, record the results
            results = []
            for c in calls:
                try: out, err = run_tool(db, config, tools, c["name"], c["input"])
                except Exception as e: out, err = f"Tool failed: {e}", True
                results.append({"type": "tool_result", "tool_use_id": c["id"], "content": out, "is_error": err})
            db.execute("INSERT INTO adf_loop (role, content_json, created_at, ord, loop) VALUES ('user', ?, ?, NULL, 'main')",
                       (dumps(results), now_ms()))
            db.execute("COMMIT")
            messages.append({"role": "user", "content": results})
        print("stop: the turn ended without a final reply", file=sys.stderr)
    finally:
        close(db)

if __name__ == "__main__":
    args = sys.argv[1:]
    model = args.pop(args.index("--model") + 1) if "--model" in args else "stub-write"
    main(*[a for a in args if a != "--model"][:2], model)
```

Expected result of a run with the default stub: the program prints `Stub reply. No model ran.` The transcript has five new rows: the owner message, the context row, the tool calls, the tool results and the reply. The file `notes/harness.md` is new. If the program printed no checkpoint warning, no `-wal` or `-shm` file stays beside the `.adf` file ([Close](#close)).

## File layout

| Data | Location in the file | Harness action |
|------|----------------------|----------------|
| Config and instructions | `adf_config.config_json` | Read. Do not write. |
| Memory and voice | `adf_files` paths `mind.md`, `soul.md` | Read for the prompt. Write only through `fs_write`. |
| Other agent files | `adf_files` | Read and write through the file tools. `adf_files` is not a directory on the host. |
| Transcript | `adf_loop` rows with `loop = 'main'` | Read. Append rows. Do not change or delete rows. |
| Inner-loop transcripts | `adf_loop` rows with another `loop` value | Do not read into `main`. Do not change. |
| Identity facts | `adf_meta` keys `adf_did`, `adf_owner_did`, `adf_runtime_did`, `adf_did_history` | Do not change values. Repair the protection only ([Write access](#write-access)). |
| Keys and secrets | `adf_identity` | Do not read. Do not write. It can hold a sealed provider credential; this harness does not unlock it. Never put its contents into a prompt ([§1.5](../../ADF_SPEC_v0.2.md#15-no-secrets-in-context)). |
| Attestations | `adf_attestations` | Do not change. |
| Messages | `adf_inbox`, `adf_outbox` | Do not change. |
| Timers and tasks | `adf_timers`, `adf_tasks` | Do not change. |
| Audit snapshots | `adf_audit` | Do not change. Do not load them into history. |
| Harness state | your own tables and `adf_meta` keys | See [Write set](#write-set). |

These values are different:

- An `adf_loop.seq` or a `tool_use` id is not an SDK run id, response id or checkpoint id.
- SDK `reasoning` items, approval events, handoffs and graph state are not transcript rows.
- An SDK session store is not a second source of truth. It is a cache of `adf_loop`.
- ADF's runtime settings and base prompt are not in the file. The file can hold a sealed provider credential; this harness does not unlock it ([§16](../../ADF_SPEC_v0.2.md#16-portability)).

## Read access

Level 1 gives read access only. Read-only access does not change the file. Most readers start here. Use it for memory, history and files.

Caution: Memory and history can contain personal information. A model command that uses a real provider sends the selected context to that provider.

1. Make sure that the file is safe to read: do all the [Copy](#copy) safety steps.
2. Open the file with `sqlite3.connect("file:agent.adf?mode=ro&immutable=1", uri=True)`.
3. Read `adf_config.config_json` and `instructions`.
4. Read the files that the instructions name in `{{path}}` placeholders.
5. Read the transcript with the query below.

```sql
SELECT seq, role, content_json, model, created_at
FROM adf_loop
WHERE loop = 'main'
ORDER BY COALESCE(ord, seq), seq;
```

With `immutable=1`, SQLite writes nothing, also in a read-only directory. Do not use `immutable=1` while a runtime has the file open: you can then read data that is not consistent. With `mode=ro` only, SQLite makes a `-wal` and a `-shm` file beside a WAL file, and they stay after the close. In a read-only directory, `mode=ro` fails with `attempt to write a readonly database`.

Both parts of the transcript query are necessary. A compaction summary row has an `ord` value, so `COALESCE(ord, seq)` puts it before the rows that it summarizes. Rows of inner loops are in the same table, so `WHERE loop = 'main'` removes them.

Keep three items separate: the stored transcript, the active history, and the request that you send. The stored transcript is all rows. The active history is the rows that you give to the model again, in the order of the query. The request is the active history in the form of your provider, with your system prompt.

Use this replay policy for context rows. ADF at commit `d664ea22` uses the same policy:

| Row | First text | Replay |
|-----|------------|--------|
| System prompt snapshot | `[Context: system_prompt] ` | Skip. Your harness sends its own prompt. |
| Dynamic instructions | `[Context: dynamic_instructions] ` | Skip. They applied to one earlier request. |
| Status notice | `[Context: status] ` | Skip. |
| Provider context | `[Context: provider_context \| from=<name>] ` | Skip. |
| Keyed injection | `[Context: <category> \| loop_inject=v2 \| origin=<origin> \| key=<key>] ` | Send the newest row for each key as a user message, after the new owner message. |
| Injection without a key | `[Context: <category> \| loop_inject=v2 \| origin=<origin>] ` | Skip. It applied one time. |
| Compaction summary | `[Loop Compacted] ` or `[Loop Compacted, audited] ` | Send. It is not a context row. |

A keyed injection is a `user` row with one `text` block that matches the header pattern in the example (`KEYED`). For each key, send the newest row. Order the keys by their newest row. Note: The skills catalog of ADF is a keyed injection with `key=skills_registry`. For `loop_inject` in ADF, see [memory-management.md](memory-management.md#loop_inject-code-execution-only).

Do not send empty `text` blocks. If a message then has no blocks, do not send it.

Do not put the contents of `adf_identity` into a prompt. Do not load `adf_audit` snapshots into the history.

Unread messages in `adf_inbox` stay unread. The model does not see them in a harness that does not read them.

### Tool pairs

A file that ADF wrote can have rows that a provider refuses when you send them unchanged. ADF repairs them in memory when it restores a loop. Do the same repair on the active history, before you add the new owner message. Do not change the rows.

1. A `user` row without `tool_result` blocks that is inside an open tool pair moves to after the results. A message from the fleet or from an inner loop can be in this position.
2. A history that starts with an `assistant` row, or with `tool_result` blocks, loses them.
3. The last row can be an `assistant` row with a call that has no result. Add a `tool_result` for it to the request only, with `is_error: true`. Its text tells the model that the outcome is unknown. It also tells the model to check the target before a new try.
4. Remove other calls that have no result, and results that have no call.
5. Tell the owner about each repair. The example writes a warning and a `[Context: status]` row.

Caution: This repair keeps the request valid. It does not tell you if a call ran. A call to an outside service can have an effect that the file does not show. Before you try a failed request again, examine the transcript and the files.

## Write access

Level 2 gives write access. Before you start, do the [Copy](#copy) steps.

### Open

1. Open the file in read-write mode. Do not let SQLite make a new file: use `mode=rw`.
2. Read `adf_meta.adf_schema_version`.
3. If the value is not 32, close the file or open it with `immutable=1`. Do not write ([§3.5](../../ADF_SPEC_v0.2.md#35-schema-migration)).
4. Read the `status` in `adf_runtime_turn_checkpoint`. If it is not `completed`, `interrupted` or `failed`, stop. Open the file in ADF for recovery.
5. Read `config.state`. If it is not `active`, `idle` or `hibernate`, stop ([State](#state)).
6. Apply the pragmas of [§3.1](../../ADF_SPEC_v0.2.md#31-sqlite-pragmas).
7. Start a write transaction with `BEGIN IMMEDIATE`. Delete `adf_clean_close`, and make sure that the `DELETE` changed one row.
8. If it changed no row, roll back and stop. A runtime has the file open, or a session did not close. Open the file in ADF: ADF examines it and continues. Then stop the agent and close the file in ADF again.
9. Set `readonly` again on the four identity keys with the narrow `UPDATE` below. Then commit.

```sql
UPDATE adf_meta SET protection = 'readonly'
WHERE key IN ('adf_did', 'adf_owner_did', 'adf_runtime_did', 'adf_did_history')
  AND protection <> 'readonly';
```

Steps 7 and 9 are runtime work on the state of the file, the same as the close record. They are not agent metadata tools. Step 9 changes the protection only, never a value, and never makes a protection weaker ([§4.4](../../ADF_SPEC_v0.2.md#44-meta-protection)). A read-only open writes nothing.

Note: ADF at commit `d664ea22` opens a newer schema in read-write mode with a warning. Spec §3.5 asks for a read-only open or a refusal. Do not write to a schema version that this guide does not name.

### Write set

A harness writes only these parts of the file. Replace `myh` with a short name for your harness.

- Append rows to `adf_loop` ([Turn records](#turn-records)).
- Write `adf_files` through the file tools ([File tools](#file-tools)).
- In `adf_meta`: `adf_clean_close`, the identity protection repair ([Open](#open)), and keys that start with `runtime_myh_` ([§3.3](../../ADF_SPEC_v0.2.md#33-field-reference-data-dictionary)).
- Tables that start with `local_myh_` ([§3.4](../../ADF_SPEC_v0.2.md#34-user-tables)).

Write nothing else. Do not change other protections, other `runtime_*` keys, `adf_config` or `adf_identity`.

Use narrow, parameterized `INSERT` and `UPDATE` statements only. Do not use `INSERT OR REPLACE`. Do not make a table again, and do not copy the data into a new database. These actions can lose columns, keys and rows that your harness does not know ([§0.2](../../ADF_SPEC_v0.2.md#02-data-conventions)).

### Turn records

Append rows to `adf_loop`. Do not `UPDATE` or `DELETE` a row. Each new row has these values:

| Column | Value |
|--------|-------|
| `loop` | `'main'` |
| `ord` | `NULL` |
| `created_at` | epoch milliseconds, not less than the largest `created_at` in `adf_loop` |
| `role` | `user` or `assistant` |
| `model` | the model id on `assistant` rows; `NULL` on `user` rows |
| `tokens` | JSON with `input` and `output` on `assistant` rows when the provider reports usage; `NULL` otherwise ([§13.1](../../ADF_SPEC_v0.2.md#131-transcript-rows)) |
| `content_json` | a JSON array of blocks, with no empty `text` block |

Do a turn in these phases. Phases 2, 4 and 6 end with `COMMIT`:

1. Check and open the file ([Open](#open)).
2. Append the owner message as a `user` row. Append your system prompt as a context row: `[Context: system_prompt] ` and the prompt. If you repaired tool pairs, append a `[Context: status]` row that says so. Commit before you send the request.
3. Send the request to the model.
4. Append the response as an `assistant` row, with its tool calls. Commit. If the response has no text and no tool call, do not write a row.
5. Run the supported tools.
6. Append the tool results as one `user` row. Commit with the file changes.
7. Go back to phase 3 until the model replies with no tool call. Then close ([Close](#close)).

A request that reached the provider stays on record, also if the harness fails later ([§1.5](../../ADF_SPEC_v0.2.md#15-no-secrets-in-context)). Do not roll back a phase after you send the request. A `ROLLBACK` cannot cancel the cost of a request or a tool action that occurred.

Caution: After a timeout or a failed request, examine the transcript and the changed files before you try again. A failed command can already have changed files. A new try can do the same work again.

Write only these block types: `text`, `tool_use` and `tool_result`. Put a `tool_result` block for each call in the row after a `tool_use` row. Do not write `thinking` blocks.

If a row has a `file_ref` block, send its path to your model as text. If the block has `deleted: true`, send `[deleted: <file name>]` ([§13.1](../../ADF_SPEC_v0.2.md#131-transcript-rows)). Keep the row as it is.

Use the ADF name for a tool that ADF also has, for example `fs_read` and `fs_write`.

Your harness can run a tool that ADF does not have. Do not write `tool_use` rows for such a tool. Record the call and its result as a `text` block in the `assistant` row. Do not put the result in a `user` row: ADF reads a `user` row as the owner. Do not put it in a context row: replay skips context rows. Tell the model which tools in its instructions your harness does not give.

If the model calls a tool name that your harness does not run, the example writes the `tool_use` and an error `tool_result`. ADF does the same.

### Tool access

Give the model a tool only if its declaration in `config.tools` has `enabled` and `visible` set to `true` ([§5.4](../../ADF_SPEC_v0.2.md#54-tool-declarations)).

A tool with `restricted: true` needs owner approval for each model call ([§8.7](../../ADF_SPEC_v0.2.md#87-restricted-tools-and-methods)). If your harness cannot ask the owner, do not give that tool to the model.

If the harness meets a capability or an approval that it cannot apply, tell the owner. Do not skip it without a message.

### File tools

The example supports `fs_read` and `fs_write` in modes `write` and `append`.

1. Refuse a write to a file with protection `read_only` ([§4.2](../../ADF_SPEC_v0.2.md#42-file-protection)).
2. Set `authorized = 0` on each write ([§4.3](../../ADF_SPEC_v0.2.md#43-file-authorization)).
3. Store `content` as a BLOB, `size` as its length in bytes, and `updated_at` as an ISO-8601 string.
4. Read and write only files whose content is valid UTF-8. Refuse other files. Do not decode a binary file and write it again.

Note: Step 4 is a rule of this guide. ADF's own `fs_write` does not examine the MIME type or the content of the file before it writes.

Rationale for step 2: `authorized = 1` lets the code in a file call restricted tools. A write by the model cannot keep that permission.

`fs_delete` and a file rename are not in the scope of this guide. They have rules that change transcript rows ([§13.1](../../ADF_SPEC_v0.2.md#131-transcript-rows)).

### Compaction

Compaction is not in the scope of this guide. If the history is too long for the model, stop. Use ADF to compact it before another harness run ([§13.2](../../ADF_SPEC_v0.2.md#132-compaction)).

## Close

1. Write `adf_clean_close` with an ISO-8601 time and protection `readonly`. Make it the last write.
2. Run `PRAGMA wal_checkpoint(TRUNCATE)`.
3. Read the first value of the result. If it is 0, the checkpoint is complete.
4. Close the connection.

Only after a successful checkpoint and close can you move the `.adf` file alone. If the checkpoint is incomplete, stop. Keep the `.adf` and its `-wal` and `-shm` files together. Do not delete or separate them.

For the parts that the close does not move, see [Limits](#limits). `adf_clean_close` tells only that the file closed cleanly. It does not tell that the task is complete or that a tool ran one time.

## Check

Do these checks after the first runs. Use a copy from before the run and the file after it. Do the checks only after a successful checkpoint and close, with no `-wal` or `-shm` file beside either file.

1. Run `PRAGMA integrity_check` on the file after the run. The result must be `ok`.
2. Compare the old rows. Each row of `adf_loop` in the copy must have the same values in the file after the run.
3. Examine the new rows. Each new row must have `loop = 'main'`, `ord` NULL, and `model` on `assistant` rows only. `tokens` must be NULL or JSON with `input` and `output`.
4. Examine tool pairs. Each `tool_use` id in a new row must have a `tool_result` in the next non-context row. An interrupted run leaves a call with no result. This is correct; see [Tool pairs](#tool-pairs).
5. Compare `adf_meta`. Only the keys in the [Write set](#write-set) can change.
6. Compare the other tables. Only the tables in the [Write set](#write-set) can change.

```python
import json, sqlite3
def rows(path, sql):
    return sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True).execute(sql).fetchall()
before, after = "before.adf", "after.adf"
print(rows(after, "PRAGMA integrity_check"))
old = rows(before, "SELECT * FROM adf_loop")
top = max((r[0] for r in old), default=0)
assert old == [r for r in rows(after, "SELECT * FROM adf_loop") if r[0] <= top]
new = rows(after, f"SELECT seq, role, model, tokens, ord, loop FROM adf_loop WHERE seq > {top}")
print([r for r in new if r[5] != "main" or r[4] is not None or (r[2] is None) != (r[1] == "user")])
meta = lambda p: dict((k, (v, pr)) for k, v, pr in rows(p, "SELECT key, value, protection FROM adf_meta"))
m0, m1 = meta(before), meta(after)
print([k for k in set(m0) | set(m1) if k != "adf_clean_close" and not k.startswith("runtime_myh_") and m0.get(k) != m1.get(k)])
tables = lambda p: {n for (n,) in rows(p, "SELECT name FROM sqlite_master WHERE type = 'table'")}
print(sorted(tables(after) - tables(before) - {n for n in tables(after) if n.startswith("local_myh_")}))
```

Replace `myh` with your harness name. The script prints four results. The first is `[('ok',)]`. Then come the new rows that break step 3, the changed `adf_meta` keys outside the write set, and the new tables outside the write set. Each list must be empty, except for a protection that changed to `readonly` on an identity key. Step 4 and the contents of old tables are not in this script.

Two more properties are this guide's profile, not format rules: `created_at` does not decrease, and roles alternate when you skip context rows. The example keeps the first. A failed request can break the second, in the example and in ADF.

## Return to ADF

Do the first return on a disposable copy, on a computer with no network connection:

1. Put the copy in a directory that ADF does not track.
2. Open the copy in Studio. Do not start the agent.
3. Examine the transcript: the owner message, the context row, the stub tool calls and the stub reply.
4. Open `notes/harness.md` and make sure that it has the stub line.

A turn with a model in ADF is a separate step. It needs a provider that you configured in ADF.

See [Single writer](#single-writer).

When ADF opens a file that another program wrote, it does these actions:

- It reads `adf_clean_close`. If the key is absent, it runs `PRAGMA integrity_check`. Then it deletes the key.
- It runs migrations if the schema version is less than 32. A newer version opens with a warning only.
- It sets `readonly` again on the four identity keys.
- It adds default tools that are not in `config.tools`, sets `visible` where it is absent, and can add loop tools one time (`adf_loop_tools_backfilled`). It writes the config back.
- When it restores a loop, it repairs tool pairs in memory ([Tool pairs](#tool-pairs)). It does not change the rows.
- Studio and the daemon set `config.name` to the file name.

ADF can change the config of the file in these steps. Do not keep a copy of the config in your harness from one ADF session to the next. Read it again from the file.

After a failed or stopped harness run, examine the transcript and the changed files in ADF before you send a new message. A failed command can already have changed files.

The system prompt is different in each runtime. ADF adds its own base prompt and tool guidance from its runtime settings. These settings are not in the file: `adf_effective_runtime` holds only their hashes. A config with `bare_prompt: true` sends `instructions` only. A config with `include_base_prompt: false` removes the base prompt but keeps other sections ([§5.1](../../ADF_SPEC_v0.2.md#51-top-level-shape)). The agent can act differently in each runtime.

Identity: if this ADF install did not review the agent before, Studio can offer a claim, and a claim gives the agent a new DID. See [claim a foreign agent](security-and-identity.md#claiming-a-foreign-agent), and [Agent DID](security-and-identity.md#agent-did--one-per-file) for rotation and history.

To make a new `.adf` file, use ADF Studio or the ADF CLI. This guide does not make files.

## Agent SDKs

The `.adf` file is the source of truth. The SDK store is a cache that the harness makes again from the file for each run. The sections below name the integration point of each SDK. Each name agrees with the SDK source and documents on 2026-11-26.

### Claude Agent SDK

Not run. Checked: Python `claude-agent-sdk` 0.2.189 and TypeScript `@anthropic-ai/claude-agent-sdk` 0.3.332.

- Prompt: pass your system prompt as a string in `ClaudeAgentOptions.system_prompt`.
- Tools: set `tools=[]` to remove the built-in tools. The built-in `Read`, `Write` and `Bash` tools use the host disk, not `adf_files`. Give `fs_read` and `fs_write` as custom tools with `@tool` and `create_sdk_mcp_server`.
- MCP: set `strict_mcp_config=True` and give only your harness MCP server in `mcp_servers`. The default is `False`, and then the SDK also loads other MCP servers. `tools=[]` does not remove them. Checked in the 0.2.189 source.
- Settings: set `setting_sources=[]`. The default loads user and project settings, for example `CLAUDE.md`. Checked in the 0.2.189 source.
- Transcripts: the SDK keeps its own session transcript in `~/.claude/projects/`, so two transcripts exist. Make the SDK session from `adf_loop` for each run. The SDK does not take a list of messages. The `session_store` option (alpha) loads a session from your store, and the SDK still writes its local copy. Set `CLAUDE_CONFIG_DIR` to a temporary directory to discard that copy.
- Prompt text that the SDK adds is not under your control. Record what you can see as context rows. ADF records such text as `[Context: provider_context | from=<name>]`.

### OpenAI Agents SDK

Not run. Checked: `openai-agents` 0.26.0.

- Integration point: a custom `Session` with `get_items`, `add_items`, `pop_item` and `clear_session`. Pass it to `Runner.run(..., session=...)`.
- `get_items` reads `adf_loop` with the transcript query and converts rows to Responses API input items.
- `add_items` converts the items back to `text`, `tool_use` and `tool_result` blocks and appends rows. Do not store the item JSON as it is.
- `pop_item` and `clear_session` delete items, and the SDK can rewind items for a retry. Do not let them delete committed `adf_loop` rows. Keep a cursor or staged items in your own table ([Write set](#write-set)), and remove items there only. A rewind of the SDK cache does not cancel a request that the provider received.
- Map each function call id to the `tool_use` id. Keep both in your own table ([Write set](#write-set)) if you need them later.
- Do not use `SQLiteSession` at the same time. Choose one store.

### LangGraph

Not run. Checked: `langgraph` 1.2.24, `langgraph-checkpoint` 4.3.2.

- A checkpointer (`BaseCheckpointSaver`) holds the full graph state, not a transcript. A graph can run with no checkpointer.
- Put the messages of `MessagesState` in `adf_loop`. Put other graph state in your own table ([Write set](#write-set)).
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
