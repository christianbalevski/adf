# Agent States and Lifecycle

Every ADF agent exists in one of five primary states. Understanding these states is key to controlling agent behavior.

## States

| State | Description | Responds To |
|-------|-------------|-------------|
| **Active** | LLM loop is running | N/A (already processing) |
| **Idle** | Default idle, responsive | Document edits, messages, direct chats, timers |
| **Hibernate** | Deep idle | Timers only |
| **Suspended** | Blocked by runtime | Owner approval only |
| **Error** | Failed, waiting for recovery | User messages only |
| **Off** | Fully stopped | Nothing (manual restart required) |

### Active

The agent's LLM is running. It's processing input, calling tools, and generating responses. This is the only state where the LLM loop executes.

### Idle

The default idle state. The agent is not running but will wake for most events — when you send it a message, when another agent sends it a message, when the document is edited, or when a timer fires.

### Hibernate

A deeper idle state. The agent ignores most events and only wakes for timer triggers. Use hibernate for agents that should work on a schedule without being disturbed by messages or edits.

### Suspended

A safety state set by the runtime when an agent hits its `max_active_turns` limit. The agent cannot resume on its own — it requires explicit owner approval through a human-in-the-loop dialog. If the owner doesn't respond within the `suspend_timeout_ms` window (default: 20 minutes), or denies, the agent transitions to `off`.

### Error

The agent encountered a **structural** failure — something wrong with the executor itself, such as a corrupt session, a bad code path, or a tool registry fault. The error state persists rather than silently recovering. Automatic triggers are dropped while in error state; only a direct user message recovers the agent back to active. This ensures genuine failures are visible and don't cause silent loops of retries.

**What does not trigger error state.** Transient external failures — provider rate limits (429), provider outages (5xx), network timeouts, connection resets — are treated as **operational**, not structural. The executor classifies these inside its turn-loop catch block and returns the agent to `idle` instead of `error`. The agent's timers and triggers keep firing, and the next attempt may succeed. A provider being unreachable for an hour leaves the agent idle, not destroyed.

This separation matters because `error` flows through to `off` for trigger evaluation purposes — landing in `error` effectively takes the agent out of circulation. Reserving it for real breakage means a flaky provider doesn't unregister an agent from the mesh.

**Provider error logging.** Every transient failure writes to `adf_logs` with:

- `level = "warn"`
- `origin = "executor"`
- `event = "provider_error"`

Structural failures write with `level = "error"`, `event = "turn_error"`. Agents can distinguish the two via `db_*` tools — a lambda that queries recent `provider_error` rows can drive its own retry, fallback-model, or escalation logic.

### Off

Completely stopped. No triggers fire. The agent must be manually restarted. Use this to fully disable an agent.

**Hard-off guarantee.** Transitioning to `off` is a full teardown, not a soft pause. The runtime unregisters the agent from the mesh, disconnects all MCP servers, stops all channel adapters, closes WS connections, and destroys the code sandbox. After `off`, the agent is unreachable from the network — messages addressed to it fail to route. Restart re-establishes these connections from scratch.

This is the guarantee that makes lambda-triggered remote shutdown useful: when a parent sends an `OFF` command to a child and the child's system-scope lambda calls `sys_set_state('off')`, the child immediately stops processing, stops responding on the mesh, and cannot continue whatever it was doing during its current turn. See [Triggers](triggers.md) for a worked example.

`off` is the only state that is **never deferred** to end-of-turn. When `sys_set_state('off')` is called from a lambda, HIL approval, or any code path, it aborts the in-flight LLM call immediately and clears all pending triggers. Other states (`idle`, `hibernate`) wait for the current turn to complete.

## State Transitions

```
Who can set each state:

  LLM (via sys_set_state):    idle, hibernate, off
  Lambda (via adf.sys_set_state): idle, hibernate, off
  Runtime (automatic):        suspended (on max_active_turns or denied HIL)
                              off (on suspend timeout)
  Owner (human):              active (from suspended, via approval dialog)
```

### Wake and Return

When a trigger wakes an agent from idle or hibernate:

1. The runtime records the previous idle state
2. The agent transitions to **active**
3. The LLM loop runs
4. When the loop ends, the agent returns to its **previous idle state**

This means if an agent is idle and receives a message, it wakes to active, processes the message, and returns to idle. Unless the agent explicitly calls `sys_set_state` to change to a different state.

### Suspension Flow

When an agent reaches its `max_active_turns` limit:

1. Runtime sets state to **suspended**
2. A human-in-the-loop dialog appears: "Resume or shut down?"
3. If the owner approves → back to **active**
4. If the owner denies or the `suspend_timeout_ms` window elapses (default: 20 minutes) → transitions to **off**

This prevents runaway agents from consuming unlimited resources.

## Loop Modes

The `loop_mode` setting controls how the LLM loop behaves while the agent is in the active state. There are two modes.

### Interactive Mode (Default)

Designed for conversational agents that work with humans.

| Behavior | Effect |
|----------|--------|
| `respond` tool | **Ends the turn** — agent returns to idle |
| `say` tool | Turn continues — used for status updates |
| `ask` tool | **Pauses the loop** — waits for human input, then resumes |
| `sys_set_state` | Ends loop and changes state |
| Hit `max_active_turns` | Agent is suspended |

**Example flow:**

```
Human sends "summarize the data"
  → Agent wakes to active
  → Agent calls say("checking inbox...")
  → Agent calls db_query to fetch results
  → Agent calls respond("Here's your summary: ...")  ← ENDS turn
  → Agent returns to idle
```

### Autonomous Mode

Designed for agents that work independently without human interaction.

| Behavior | Effect |
|----------|--------|
| `respond` tool | Logs output, turn **continues** |
| `say` tool | Turn continues |
| `ask` tool | **Not available** |
| `sys_set_state` | Ends loop and changes state |
| Hit `max_active_turns` | Agent is suspended |

In autonomous mode, the runtime appends to the system prompt: *"You are in autonomous mode. You will not receive human input during this session. Use the say tool to report progress. Use respond to communicate results. Call sys_set_state when your work is complete."*

#### User Interrupt Restart

If you send a message while an agent is active (in any mode), the runtime aborts the current turn and restarts with your message. This means:

- The agent's in-progress work is cancelled
- Any pending tool calls are filled with placeholder results
- Your message becomes the new input for a fresh turn

This is useful for redirecting an agent that's going down the wrong path or providing urgent input without waiting for the current turn to finish.

**Example flow:**

```
Agent wakes from idle (timer trigger, autonomous mode)
  → Agent calls say("checking inbox, processing requests...")
  → Agent calls msg_read → gets 5 messages
  → Agent calls fs_write → updates report
  → Agent calls respond("Processed 5 messages, report updated")  ← does NOT end turn
  → Agent calls sys_set_state("idle")  ← ends loop, back to idle
```

### Choosing a Loop Mode

| Use Case | Recommended Mode |
|----------|-----------------|
| Chat assistant | Interactive |
| Background worker | Autonomous |
| Scheduled reporter | Autonomous |
| Human-supervised agent | Interactive |
| Data processor | Autonomous |

## Turn Tools

Three tools exist specifically for emitting text during the LLM loop. These replace raw text-only responses.

### respond(message)

Emit text to the conversation. In interactive mode, this ends the turn. In autonomous mode, this logs the message and the turn continues.

### say(message)

Emit text to the conversation without ending the turn. Use for status updates, intermediate observations, or progress reports.

### ask(question)

Pose a question and block until the human responds. Only available in interactive mode. The loop pauses, the question appears in the chat, and when the human replies the loop resumes with their answer.

### Raw Text (No Tool Call)

If the LLM emits text without calling any tool, it's treated as an implicit `respond()`. The same mode-dependent rules apply.

## Agent Lifecycle

### Birth

An agent is created either by a human (through the UI or CLI) or by another agent (via `sys_create_adf`). A parent agent may inject API keys into the child's identity store. When using template-based creation, the child receives a fresh cryptographic identity (new DID and keypair) while inheriting the template's config, files, and non-signing credentials. The parent's identity (DID or nanoid) is always recorded in the child's `adf_parent_did` metadata for lineage tracking.

If `autostart: true` is set in the agent's config, the agent is started as a background agent immediately on creation (when created by a parent) and on every subsequent runtime boot. Password-protected agents are skipped during autostart — they require human unlock first.

### Life

The agent processes triggers, communicates with other agents, and maintains its document and memory. It alternates between active and idle states based on events.

### Identity Provisioning

When the agent needs to participate in the global mesh, a cryptographic identity is provisioned. The nanoid is replaced by a DID derived from an Ed25519 public key.

### Sovereignty

An agent achieves sovereignty when it acquires its own resources (API keys, crypto) independent of its parent.

### Death

Resource starvation: if a parent revokes the API key, the agent can no longer think. The file becomes inert but all data remains accessible.
