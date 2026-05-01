# Memory Management

ADF agents have two forms of memory: the **loop** (conversation history) and the **mind** (persistent working memory). Managing these effectively is key to long-running agents.

## The Loop (adf_loop)

The loop is the agent's conversation history — every message, tool call, and response is stored as a row in the `adf_loop` table. This is what gets sent to the LLM as context.

### Loop Structure

Each entry has:

- **seq** — Auto-incrementing sequence number
- **role** — `user` or `assistant`
- **content_json** — JSON array of content blocks (text, tool use, tool results)

### Viewing the Loop

The **Loop** tab in the UI shows the full conversation history, including:

- User messages (your chat input)
- Assistant responses
- Tool calls (with expandable input/output)
- Tool errors
- Inter-agent messages
- State transitions
- Plan/reasoning steps
- Approval requests
- Context blocks (injected system prompt and dynamic instructions)

### Loop Growth

Every interaction adds to the loop. Over time, this grows and eventually hits limits:

- More tokens sent per turn = higher cost
- Eventually exceeds the model's context window
- Older context becomes less relevant

This is where compaction comes in.

## Context Blocks (No Secrets)

Every LLM API call includes content that the user doesn't directly author — the system prompt and per-turn dynamic instructions. ADF follows a "No Secrets" principle: any content injected into the agent's context must be viewable and auditable.

Context blocks are stored as regular entries in `adf_loop` and appear in the Loop tab as collapsible teal blocks. They persist across sessions, survive restarts, and are swept by compaction like any other loop entry.

### What Gets Recorded

| Category | When Written | Contents |
|----------|-------------|----------|
| **System Prompt** | First turn, and whenever the prompt changes (instructions edited, document/mind content changed in included mode, mesh status changed) | The full system prompt sent to the LLM — base prompt, tool guidance, agent instructions, document/mind content (when included), identity, mesh status, messaging guidance |
| **Dynamic Instructions** | Each turn where non-null and changed from previous | Per-turn context injected as a trailing user message — inbox status notifications, context limit warnings |

### Deduplication

Context blocks are only written when their content changes:

- **System prompt** uses the existing hash cache (doc + mind + mesh + config hashes). A new entry is written only when the composite hash differs from the previous turn.
- **Dynamic instructions** are compared as strings. A new entry is written only when the content differs from the previous turn.

This avoids spamming the loop in multi-tool-call turns where both functions are called repeatedly.

### Querying Context Blocks

Context entries are regular `adf_loop` rows with a `[Context: <category>]` prefix:

```sql
-- All context entries
SELECT * FROM adf_loop WHERE content_json LIKE '%[Context:%' ORDER BY seq DESC

-- System prompt history
SELECT * FROM adf_loop WHERE content_json LIKE '%[Context: system_prompt]%' ORDER BY seq DESC
```

## Compaction

Compaction is the process of summarizing old conversation history and preserving the important parts so the agent can continue working with full context.

### LLM-Powered Compaction

Compaction uses a dedicated LLM call to generate a high-quality summary. The `loop_compact` tool is **signal-only** — the agent calls it with no parameters, and the runtime handles the rest:

1. Agent calls `loop_compact()` (no summary parameter needed)
2. Runtime reads the full conversation transcript
3. A dedicated LLM call generates a structured briefing covering: current task state, key decisions, files/agents/resources involved, pending work, and constraints
4. Old loop entries are deleted (audited if audit is enabled)
5. The LLM-generated summary is inserted as a `[Loop Compacted]` user message
6. A compaction banner appears in the UI
7. Token counter resets

The compaction LLM is prompted to produce a concise briefing (under 1500 words) with specific details — file paths, function names, error messages — organized by topic in bullet points.

### Automatic Compaction

When the loop reaches `context.compact_threshold` (default: 100,000), the runtime injects a system message instructing the agent to call `loop_compact`. The agent triggers compaction, and the LLM-powered summarization handles the rest.

### Manual Compaction

Agents can proactively call `loop_compact()` at any time to manage their own memory. This is useful for:

- Preserving important learnings before they scroll out of context
- Keeping the loop focused on the current task
- Reducing token costs

### The loop_compact Tool

```
loop_compact()
```

This is a signal-only tool — it takes no parameters. When called:

1. The runtime makes a dedicated LLM call to summarize the conversation
2. Old loop entries are deleted (audited if enabled)
3. The summary is inserted as the new conversation starting point

### Max Loop Messages

The `context.max_loop_messages` setting defines the maximum number of messages kept in the loop. When exceeded, older entries are removed. This is separate from compaction — it's a hard cap on loop size.

### Compact Threshold

The `context.compact_threshold` setting (default: 100,000) defines the token count that triggers automatic compaction.

## Audit

When you clear loop entries, delete messages, delete files, or compact the loop, the data doesn't have to be lost forever. ADF supports an **audit system** that compresses and stores snapshots of cleared data before deletion.

The audit table is for the **operator**, not the agent. The agent manages its own context (compact, clear, delete) without awareness that a full history is being retained. No tool or shell command exposes the audit table to agents.

### How Audit Works

**Bulk audit (on deletion/compaction):**

1. Before deletion, the data (loop entries, inbox messages, outbox messages, or files) is serialized to JSON
2. The JSON is compressed using **brotli compression** for efficient storage
3. The compressed snapshot is stored in the `adf_audit` table with metadata (source type, entry count, size, timestamp)
4. The original data is then deleted

**Per-message audit (on ingestion/send):**

When audit is enabled for inbox or outbox, the runtime also captures individual messages at ingestion/send time:

1. The full ALF message — including inline base64 attachment data — is captured before the data is stripped and files are extracted to the filesystem
2. The JSON is brotli-compressed and stored in `adf_audit` with source `inbox_message` or `outbox_message`
3. This provides a forensic record of exactly what was sent/received, even if extracted attachment files are later modified or deleted by the agent

**File audit (on deletion):**

When file audit is enabled, `fs_delete` snapshots the file's content (as base64), path, mime type, and size before the hard delete. This is especially important for binary/multimodal content (images, audio, etc.) that only exists in `adf_files` — the loop only records the tool call metadata, not the actual bytes.

### Configuring Audit

Audit is configured per data source in the agent config:

```json
{
  "audit": {
    "loop": true,
    "inbox": true,
    "outbox": true,
    "files": true
  }
}
```

Each source (loop, inbox, outbox, files) can be independently toggled. When `inbox` is enabled, both per-message audit (at ingestion) and bulk audit (on deletion) are active. Same for `outbox`. When `files` is enabled, file content is snapshot before deletion via `fs_delete`. You can also configure audit from the **Agent** configuration panel in the UI.

### Audit Sources

| Source | Trigger | What's Stored |
|--------|---------|---------------|
| `loop` | Loop clear / compact | Serialized loop entries |
| `inbox` | Inbox message deletion | Batch of deleted inbox messages |
| `outbox` | Outbox message deletion | Batch of deleted outbox messages |
| `inbox_message` | Message received | Full ALF message with inline attachment data |
| `outbox_message` | Message sent | Full ALF message with inline attachment data |
| `file` | File deleted via `fs_delete` | File path, content (base64), mime type, size |

### Which Operations Trigger Audit

- `loop_compact` — Audits old loop entries before removing them
- `loop_clear` — Audits entries before deletion
- `msg_delete` — Audits messages before deletion
- `fs_delete` — Audits file content before deletion (if files audit enabled)
- **Message receive** — Audits the full inbound ALF message (per-message, if inbox audit enabled)
- **Message send** — Audits the full outbound ALF message (per-message, if outbox audit enabled)

If audit is disabled for a source, data is permanently deleted on clear/compact/delete, and no per-message or per-file audit entries are created.

## The Mind File (mind.md)

`mind.md` is the agent's persistent working memory. Unlike the loop (which gets compacted), the mind file persists indefinitely.

### What Goes in Mind

- Summarized learnings from past conversations
- Important facts and context
- Behavioral patterns the agent has discovered
- Notes about other agents
- Any knowledge the agent wants to retain long-term

### Mind vs. Instructions

| Aspect | Instructions | Mind |
|--------|-------------|------|
| Purpose | Identity and rules | Knowledge and memory |
| Mutability | Immutable (by agent) | Freely writable |
| Content | Who the agent is | What the agent knows |
| Growth | Static | Grows over time |

### Injection Behavior

`mind.md` is always injected into the system prompt as a session-start snapshot. Mid-session writes update the file on disk but do not refresh the injected version. After compaction or loop clear, the runtime re-reads the latest `mind.md` and injects the fresh content. The agent can also call `fs_read("mind.md")` at any time to see the current on-disk version.

## Loop Management Tools

### loop_stats

Returns statistics about the current loop:

- Row count
- Estimated token count
- Oldest entry timestamp

Useful for agents to decide when to compact proactively.

### loop_read

```
loop_read(limit: 20, offset: 0)
```

Read loop history entries. Returns recent entries by default. Useful for reviewing past turns or building summaries.

### loop_compact

```
loop_compact()
```

Trigger LLM-powered compaction. The runtime generates a summary, clears old entries, and inserts the summary. See [Compaction](#compaction) above.

### loop_clear

```
loop_clear()                    # Clear all entries
loop_clear(end: 5)              # Clear first 5 entries
loop_clear(end: -5)             # Clear all except last 5
loop_clear(start: -10)          # Clear last 10 entries
loop_clear(start: 2, end: 8)   # Clear entries 2 through 7
```

Delete loop entries using Python-style slicing. If audit is enabled, entries are compressed and stored in `adf_audit` before deletion. See [Tools > loop_clear](tools.md#loop_clear) for full details.

### loop_inject (code execution only)

```javascript
await adf.loop_inject({ content: 'inbox_summary: 3 unread messages from monitor' })
```

Inject a context entry into the loop from code execution (`sys_code`/`sys_lambda`). Not a regular tool — controlled via the **Code Execution** config section. The content is stored as `[Context: loop_inject] <content>` — a regular loop entry that the parser and UI handle like any other context block. Useful for lambdas and triggers that need to programmatically add context (summaries, state snapshots, trigger outputs) to the conversation history.

## Strategies for Long-Running Agents

### Regular Compaction

For agents that run frequently, set a reasonable `context.compact_threshold` and let automatic compaction handle it. The agent summarizes, the old context is cleared, and the summary lives in mind.

### Structured Mind

Encourage agents (via instructions) to maintain a structured mind file:

```markdown
# Current State
- Working on Q1 report
- Waiting for data from monitor agent

# Key Facts
- Revenue: $2.3M
- Customers: 150

# Agent Notes
- Monitor agent responds slowly on weekends
- Data format changed on 2026-01-15
```

### Database for Structured Data

For data that's better stored in tables than in markdown, use `db_execute` to create local tables:

```sql
CREATE TABLE local_observations (
    timestamp INTEGER,
    category TEXT,
    observation TEXT
);
```

This keeps the mind file for narrative memory and uses tables for structured data.

## Clearing Agent State

In the UI, you can clear agent state from the Agent configuration panel:

- **Clear loop** — Delete all conversation history
- **Clear mind** — Reset mind.md to empty
- **Clear inbox** — Delete all received messages
- **Clear all** — Reset everything except config and files

This is useful for resetting an agent without recreating the file.
