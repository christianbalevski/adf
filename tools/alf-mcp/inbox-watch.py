#!/usr/bin/env python
"""ALF inbox watcher — blocks until a new message arrives, then exits.

Used as a "wake bridge" for Claude Code: launched via the Bash tool with
run_in_background, so when it exits the harness re-invokes the agent with this
script's stdout. The agent reads the new message(s) via the alf MCP tools, then
re-arms a fresh watcher.

Detection is by new record `id` (the inbox is append-only), so it never
re-fires on messages already present when the watcher started.
"""
import json, os, sys, time

INBOX = os.environ.get("ALF_INBOX_FILE", r"C:\Users\Christian\.alf-mcp\inbox.json")
POLL_SECONDS = int(os.environ.get("ALF_WATCH_POLL", "5"))
MAX_WAIT_SECONDS = int(os.environ.get("ALF_WATCH_MAX", str(4 * 3600)))  # safety heartbeat


def load_records():
    try:
        with open(INBOX, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, ValueError):
        return None  # transient (mid-write) or missing — retry next tick


def summarize(rec):
    msg = rec.get("message") or {}
    payload = msg.get("payload") or {} if isinstance(msg, dict) else {}
    sender = payload.get("sender_alias") or (msg.get("from") if isinstance(msg, dict) else None) or "?"
    subject = payload.get("subject") or "(no subject)"
    content = (payload.get("content") or "")[:240]
    return rec.get("id"), sender, subject, content


def main():
    start = time.time()
    base = load_records()
    seen = {r.get("id") for r in base} if base is not None else set()

    while True:
        time.sleep(POLL_SECONDS)
        cur = load_records()
        if cur is None:
            continue
        new = [r for r in cur if r.get("id") not in seen]
        if new:
            print(f"NEW_ALF_MESSAGES count={len(new)}", flush=True)
            for rec in new:
                mid, sender, subject, content = summarize(rec)
                print(f"- id={mid} from={sender} subject={subject!r}", flush=True)
                print(f"  preview={content!r}", flush=True)
            sys.exit(0)
        if time.time() - start > MAX_WAIT_SECONDS:
            print("ALF_WATCHER_HEARTBEAT no-new-messages; re-arm watcher", flush=True)
            sys.exit(0)


if __name__ == "__main__":
    main()
