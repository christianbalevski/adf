---
name: telegram-remote-hil
description: Set up owner-only remote human approvals over Telegram for ADF HIL tasks, with explicit principal ID binding, reply correlation, and expiry.
requires:
  tools: [fs_read, fs_write, sys_get_config, sys_update_config, sys_code, db_query, msg_send, sys_set_timer, sys_list_timers, db_execute]
---

# Experimental Telegram remote human approvals

> **REVISION 3.1 — REVIEW CANDIDATE, NOT LIVE-VALIDATED.** Revision 3 with documentation-only changes (the gateway script is byte-identical to Revision 3): the runtime deployment gate now also covers "Always approve", the protection auto-deny timer and async protection-override conversion. Revision 3 is Revision 2 plus two owner-authorized corrections: protection-override approvals are Studio-only (never sent to Telegram, resolved or swept by the gateway), and every gateway entry point fails closed unless the ledger guard is `authorized` **and owner-locked**, the live ledger matches the published DDL exactly, and no trigger, view, extra index or temp object touches it. Do not activate until ledger protection and runtime atomic resolution (including the Studio approval-card path) have been proved on the installed build and the owner has reviewed it.

Use when the principal explicitly asks to set up remote human-in-the-loop (HIL) approvals using their Telegram bot. Restricted calls still require a real human decision. A small owner-authorized gateway sends the pending request to the principal and resolves it only when that principal replies to that exact message.

**Installing this skill only copies documentation and an unauthorized code template. It does not configure Telegram, enable capabilities, authorize files, change restrictions, or activate triggers.** Check `requires` first. If a tool is unavailable, stop installation/setup and use the normal capability request process separately. Every configuration write in an explicitly requested setup uses normal owner approval. Never use the procedure to approve its own installation.

## What ships

- `scripts/telegram-hil.js`: reference gateway template, with a deliberately invalid owner-ID placeholder. Copy to `lib/telegram-hil.js` and customize before owner review.
- `references/CHANGES.md`: what changed from Revision 2 and why.

Revision 2's mocked Node suite is not shipped with this revision: its mock has no owner lock or schema, so the corrected gateway (correctly) refuses to run there. Integration evidence comes from the runtime harness review, not from mocks. Neither is evidence of live Telegram delivery.

Do not replace an existing remote HIL system without the principal's agreement. This skill is a new reference implementation, not a migration of an installed policy.

## 1. Inspect the runtime and existing approval policy

Read current configuration with `sys_get_config({section:'config'})` and tool schemas with `sys_get_config({section:'tools'})`. Inspect only relevant sections; do not print credentials or the whole configuration into chat. Check:

- Telegram adapter and `messaging.receive` state;
- `triggers.on_task_create`, `triggers.on_inbox`, and `triggers.on_timer`, preserving every unrelated target;
- available code methods: `task_resolve`, `db_query`, `msg_send`;
- existing authorized approval lambdas, task timeouts, and tool restrictions.

Read the current ADF guides listed under Sources. Verify actual table columns with `SELECT name, sql FROM sqlite_master WHERE name IN ('adf_tasks','adf_inbox','adf_outbox')`. For this reference scope, only one runtime process may open and resolve tasks in the agent file. Do not run Studio and a daemon concurrently against it; multi-process serialization is not established.

The template expects `requires_authorization`, `source`, `source_context`, and `parent_id`. Stop on a runtime/schema mismatch; do not guess field names or weaken checks.

The runtime creates restricted calls as `pending_approval` tasks with `requires_authorization = 1`. `task_resolve` is task-authorized on current runtimes; do not replace `code_execution.restricted_methods` or remove an existing restriction to make this work. Ordinary async tasks must not be approved by this gateway.

## 2. Bind the principal's numeric Telegram USER ID

**The owner/principal Telegram ID is mandatory.** It is not the bot token, bot ID, `@username`, display name, group ID, or agent DID.

Ask the principal to open their bot in a **private chat**, press Start (or send `/start`), and send a short message. Read the ingested message with `msg_read({status:'unread',include_original:true})` if available, or read the corresponding `adf_inbox` row and its `original_message`. Establish the principal through a trusted local conversation or an already-known verified owner binding. A stranger sending `/start` does not become the principal.

For the principal's private DM, verify:

- `source === 'telegram'`;
- normalized `from === 'telegram:<numeric-user-id>'`;
- `source_context.chat_type === 'private'`;
- `String(source_context.chat_id) === '<numeric-user-id>'`;
- if raw payload is available, the Telegram sender `from.id` agrees.

Confirm the number with the principal over the trusted setup conversation. Reject negative group IDs. Never choose an ID from a display name or the first person who messages the bot.

Record the routing identifier (not a secret):

```javascript
await adf.sys_set_meta({key:'adapter:telegram:owner',value:'<PRINCIPAL_NUMERIC_USER_ID>'})
```

The conventional metadata key is useful for outreach, but **is not the authorization authority**: ordinary agent code can change unprotected metadata. Bind the approved ID directly in the gateway before the owner authorizes it:

```javascript
const OWNER_ID = '<PRINCIPAL_NUMERIC_USER_ID>';
```

Use `recipient: 'telegram:<PRINCIPAL_NUMERIC_USER_ID>'` for outbound requests. Do not include `address`. Do not ship a reusable package with the author's personal ID. For example, a local principal ID of `123456789` yields `OWNER_ID = '123456789'` and recipient `telegram:123456789`; substitute the actual verified number, never this example.

## 3. Set up Telegram only if needed

If the principal already has a working bot and private inbound messages, reuse it. Do not rotate its token or start another poller.

If no bot exists, have the principal create one with `@BotFather` using `/newbot`. Ask them to provide its token in the **trusted local application chat**, not over Telegram or mesh. Store it through identity storage without logging it or writing it into files:

```javascript
await adf.set_identity({purpose:'adapter:telegram:TELEGRAM_BOT_TOKEN',value:token})
```

Verify `set_identity` access first; if restricted, request owner action instead of working around it. After storing the token, request the normal approved configuration writes:

```javascript
sys_update_config({path:'adapters.telegram.enabled',value:true})
sys_update_config({path:'messaging.receive',value:true})
```

These are explicit setup actions, not effects of skill installation. Existing locked fields remain locked. Only one receiver may poll a given bot token. A Telegram 409 conflict usually means another poller; stop and identify ownership with the principal rather than killing arbitrary processes or resetting tokens.

Verify both directions: send a harmless test DM, have the principal reply, and inspect the real inbound row. `Bot started` and a successful outgoing send alone do not prove approvals can come back.

## 4. Prepare and review the gateway

Read all of `scripts/telegram-hil.js`. Copy it to `lib/telegram-hil.js`, substitute the verified `OWNER_ID`, and agree on expiry (default five minutes **from task creation**, not from message arrival). Expiry is checked at gateway decision time, not enforced as an execution deadline; an approved tool may finish later.

The template:

- reads task and reply authority from runtime-owned `adf_tasks`, `adf_inbox`, and `adf_outbox`, plus the owner-protected gateway ledger, never ordinary writable `local_*` ledgers or caller-supplied verdicts;
- sends one request per task with subject `telegram-hil:<task-id>:<nonce>`;
- sends only the task ID, tool name, fingerprint, and a direction to inspect full input in Studio; arbitrary arguments and commands do not leave the machine;
- accepts only the bound principal's private DM replying to the matching request;
- recognizes exact `yes/y/approve` and `no/n/deny`;
- forwards, resolves and expires **only** ordinary restricted-tool approvals (`approval_meta.reason === 'restricted'`). Protection overrides (`reason === 'protection'`, which relax locks or protections, including this gateway's own guard) and tasks with missing or unknown approval metadata are **Studio-only**: no DM, no remote verdict, no timeout sweep;
- at every entry point (`onTaskCreate`, `onReply`, `onTimeout`) refuses to act unless the ledger guard is `authorized` and owner-locked, the ledger schema is exactly the published DDL, and no trigger/view/extra index/temp object touches the ledger;
- ignores unthreaded yes, strangers, groups, unrelated messages, terminal tasks, and ordinary async tasks;
- denies an expired request even if an old yes arrives later;
- never approves automatically, including container commands;
- sends an approval receipt distinct from a tool-completion receipt.

**Privacy:** Telegram is an external service. This revision uses a strict preview: task ID, tool name, and input fingerprint only. The principal must inspect full input in Studio before approving. This limits remote convenience deliberately; do not add arbitrary commands, content or arguments without a separate reviewed data-disclosure policy. A fingerprint does not explain what a command will do. If the principal cannot inspect the request, they must deny it.

**Owner bootstrap is required:** ask the owner to review the final gateway, mark `lib/telegram-hil.js` **Authorized** in Studio Files, and protect it **read_only**. Skill installation and agent-written code cannot authorize themselves. This is the trust boundary; do not bypass it with inline `sys_code`, SQL edits, permissive auto-approval, or a generic file-authorization gateway.

Any subsequent write deauthorizes the file. Changing the principal ID requires owner review and reauthorization. No secret belongs in the gateway.

## 5. Wire system-scope triggers without replacing existing targets

**Do not wire triggers until the protected-ledger and atomicity gates below pass.**

After owner authorization, read the existing target arrays again. For each target below, compare its lambda, scope and filter with existing entries. Append only a missing target; do not rerun this block blindly. If the same lambda already has a different filter or scope, stop for owner review rather than adding a competing copy. Preserve unrelated targets. Use the exact ID verified in step 2. Configuration changes pass through normal approval; bootstrap them from Studio if the current approval channel is unavailable.

```javascript
sys_update_config({path:'triggers.on_task_create.targets',action:'append',value:{
  scope:'system',lambda:'lib/telegram-hil.js:onTaskCreate',filter:{tools:['*']}
}})
sys_update_config({path:'triggers.on_inbox.targets',action:'append',value:{
  scope:'system',lambda:'lib/telegram-hil.js:onReply',
  filter:{source:'telegram',sender:'telegram:<PRINCIPAL_NUMERIC_USER_ID>'}
}})
sys_update_config({path:'triggers.on_task_create.enabled',value:true})
sys_update_config({path:'triggers.on_inbox.enabled',value:true})
sys_update_config({path:'triggers.on_timer.enabled',value:true})
```

The inbox filter is defense in depth; the gateway also verifies the actual stored sender and private chat. Keep both. Do not rely on an LLM turn for yes/no resolution: the agent can be blocked waiting on synchronous HIL. System-scope dispatch and response let the human answer while that turn waits. Use `_async:true` only for supported calls: `adf_shell`, `sys_code`, `sys_lambda`, `sys_fetch`, and `mcp_*` on the characterized runtime. `fs_write` does not support this flag. Check the installed tool schema before choosing the harmless test; system-scope replies must also work for synchronous HIL.

Ensure `on_timer` has a system-scope target, preserving existing targets. Create **one** system timer after checking `sys_list_timers` for duplicates:

```javascript
sys_set_timer({schedule:{type:'interval',every_ms:60000},scope:['system'],
  lambda:'lib/telegram-hil.js:onTimeout',
  payload:'Deny expired pending human approvals'})
```

The timeout scans actual system tasks and ignores caller payloads. It denies **all** expired ordinary restricted HIL tasks (`approval_meta.reason === 'restricted'`) for this agent, not just successfully notified ones; protection overrides and tasks with other or missing metadata are never swept. Confirm this is the intended policy and reconcile any existing timeout. A missed notification must never mean approval. Logical expiry is five minutes; sweeping can lag by up to one minute while the runtime is online. Offline runtimes cannot execute timers. Current runtimes cancel orphaned executor-managed approvals on restart; never resubmit an outcome-unknown tool without checking side effects.

Owner may lock the gateway trigger targets after review. The agent must not change owner-only `restricted`/`locked` fields. Enabling a tool is not the same as making it restricted.

## 6. End-to-end acceptance test

Do not activate a dangerous tool just to test this. Ask the owner to choose a harmless already-restricted call, or to restrict a harmless temporary test tool themselves. Skill text cannot grant that restriction.

1. Trigger one harmless request with `_async:true` if supported. Confirm its row is `pending_approval`, `requires_authorization = 1`.
2. Confirm exactly one DM arrives at the verified principal ID, with enough context to decide.
3. Have the principal use Telegram's **Reply** on that exact message and say `no`. Confirm `denied` and no tool side effect.
4. Repeat with a second harmless request and `yes`. Confirm execution exactly once and inspect its real completion/result.
5. Send an unthreaded yes and a duplicate reply: neither may execute another call.
6. Leave a third harmless request unanswered. Confirm the timeout denies it; an old yes must not revive it.
7. Confirm ordinary owner messages and other trigger targets still work.

Use DB evidence, not an agent's assertion:

```sql
SELECT id,tool,status,requires_authorization,created_at,completed_at,error
FROM adf_tasks ORDER BY created_at DESC LIMIT 10;
SELECT id,"to",subject,status FROM adf_outbox
WHERE subject LIKE 'telegram-hil:%' ORDER BY created_at DESC LIMIT 10;
```

This revision ships no mock suite. The review's runtime harness (real ADF runtime, simulated Telegram Bot API server and scripted LLM) is not evidence of live Telegram transport either. Label untested steps honestly. If live testing is blocked, deliver the package and state the blocker; do not claim setup complete.

## Troubleshooting and rollback

- **No request DM:** inspect task creation, trigger enabled state, lambda errors, adapter logs and outbox. Never approve because delivery failed.
- **Reply ignored:** verify it was a direct reply, exact verdict, bound user ID, private chat, stored parent correlation, and still-pending task. Do not remove identity checks. The characterized adapter can confuse reply IDs from different chats; the gateway rejects those mismatches. Use Studio for the original task instead of relaxing correlation.
- **Duplicate or ambiguous DMs:** Telegram can accept a send before returning an error, after which the adapter retries. A visible DM can therefore have no usable approval binding. An agent-created identical message during dispatch can also make binding ambiguous. These tested cases block remote approval rather than grant it. Inspect and resolve the original task in Studio; do not resend the tool call or assume any visible copy is authoritative.
- **Protection override:** decisions that bypass file/config/table protections belong in Studio, with the actual protection and input visible. Do not use a generic Telegram preview for these decisions.
- **REQUIRES_AUTHORIZED_CODE:** owner must authorize the reviewed file; also check whether a later edit deauthorized it.
- **Task already resolved / 409:** inspect status; another human decision, timeout, or restart may have won. Never retry execution blindly.
- **Token changed:** identity writes do not restart an active adapter. With owner approval toggle Telegram disabled then enabled. Do not do this merely to test a working bot.
- **Stop remote approvals:** owner disables/removes only these two trigger targets and the timeout timer, preserving unrelated targets and Studio HIL. Existing pending approvals still require a deliberate decision or timeout. Do not make tools unrestricted as rollback.

## Sources

Contracts checked October 9, 2026; refetch for the installed runtime before setup:
- https://raw.githubusercontent.com/christianbalevski/adf/main/docs/guides/authorized-code.md
- https://raw.githubusercontent.com/christianbalevski/adf/main/docs/guides/tasks.md
- https://raw.githubusercontent.com/christianbalevski/adf/main/docs/guides/triggers.md
- https://raw.githubusercontent.com/christianbalevski/adf/main/docs/guides/channels.md
- https://raw.githubusercontent.com/christianbalevski/adf/main/docs/guides/skills.md

## Mandatory ledger security setup

This replaces subject-only trust. An outbox row proves a message was sent, not that trusted code authored it. A random subject/token is not sufficient authentication on its own.

Before owner authorization or trigger activation, create the following **empty** ledger using ordinary reviewed setup code (no fabricated requests). Inspect existing tables; do not reuse an untrusted/prepopulated ledger:

```sql
CREATE TABLE local_telegram_hil_requests (
 task_id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, task_hash TEXT NOT NULL,
 preview_hash TEXT NOT NULL, subject TEXT NOT NULL, recipient TEXT NOT NULL,
 issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL,
 outbox_id TEXT UNIQUE
);
```

Use this DDL **verbatim** (whitespace may differ, nothing else): the gateway compares the stored schema against it and fails closed on any difference, including quoted names, extra columns, constraints or `CREATE TABLE … AS SELECT`.

The **owner** must set `security.table_protections.local_telegram_hil_requests = "authorized"` and add `security.table_protections` to `locked_fields` (a lock on `security` or on the exact table path is also accepted) against ordinary agent edits. Set the protection only **after** the empty table exists and has been inspected: CREATE is exempt from table protection, so a protection set on a missing table does not stop agent code from creating it pre-populated. This is an owner review step, never a skill-granted permission. If the installed runtime does not enforce authorized-only INSERT/UPDATE/DELETE/DROP on this table and prevent ordinary changes to that guard, STOP. Do not substitute an unrestricted local table, metadata key, or an unlocked guard. Confirm the table schema, emptiness, and absence of untrusted SQL triggers/views before authorizing the gateway. Owner must review other authorized code too: any authorized writer shares this trust boundary.

The gateway checks this protection, the owner lock, the exact schema and the absence of triggers/views/extra indexes/temp objects on every entry point, and throws (no send, no resolution) if any check fails. It cannot check emptiness after the fact: the owner's bootstrap inspection is the only defense against rows planted before protection was set. An atomic primary-key INSERT claims dispatch before sending. Its protected record stores the exact task fingerprint, exact preview fingerprint, recipient, expiry, nonce, and eventually one confirmed delivered outbox ID. Only a reply whose parent equals that recorded ID may resolve. Exact content checks bind the immutable preview; a copied message with another ID is not accepted. Duplicate or ambiguous exact sends fail closed. A crash between sending and recording leaves the request unresolvable remotely; use Studio, never reconstruct authority from the subject. `msg_send` currently does not return its outbox ID, so the gateway binds only a unique exact recipient/subject/content/time match and requires delivered status. Verify that behavior on the installed runtime.

**Atomicity deployment gate:** prove that the installed runtime checks pending status and transitions to running/denied without yielding or another writer intervening. This must hold for **every** owner decision surface: the Studio in-chat approval card and approvals menu (`executor.resolveApproval`), "Always approve" and "Approve all", and the executor's protection auto-deny timer. On builds where these paths settle the approval in memory but leave the row `pending_approval`, a later Telegram verdict or timeout "succeeds" against a task the owner already decided: an approved tool still runs at most once but the principal receives a false `Request denied.` (or the sweep writes `denied` while it runs), and, in a same-tick race with a Studio denial, the gateway's approve can report success (a false `Approval recorded`) although nothing runs. Require the runtime fix before activation. Upstream October 9 `handleTaskResolve` in `src/main/runtime/adf-call-handler.ts` does this synchronously before awaiting tool execution. That source observation is not installed-build or multi-process proof. Run an installed-build integration test for simultaneous duplicate yes replies and yes versus timeout; require one resolution and no double execution. If multiple processes can resolve the same file without serialization, require a runtime compare-and-set fix before activation. Do not claim mock tests establish this.

**Protection-conversion deployment gate:** when an approved async call is blocked by a lock, the runtime re-parks the same task as a protection override. The installed build must rewrite that row's `approval_meta` to `reason: 'protection'` (and require authorized resolvers) before it is pending again. On builds that keep the original `reason: 'restricted'`, the gateway cannot tell the override from the request the owner approved: a later correlated Telegram "yes" to the original DM approves the override, and the timeout sweep resolves it. Require the runtime fix before activation.

The deployed gateway does not use dynamic code generation. Keep candidate status until these gates and section 6 live acceptance tests pass.


## Provenance and redistribution

Authored by MIK for the ADF skill-publishing workflow, October 2026; gateway corrections and integration tests by ADF Engineer through its approved worker. Permission to redistribute this package is granted. No bot tokens or real principal IDs are included. Publication acceptance is pending; no live Telegram or packaged Electron validation is claimed. Runtime fixes must be identified by exact source/patch hashes in the accompanying evidence record, not assumed present in an installed build.
