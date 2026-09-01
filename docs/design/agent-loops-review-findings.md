# Agent-loops adversarial review — consolidated findings ledger

Six reviewers (main-process perf, renderer perf, DB/IO perf, correctness, security, state-machine) over commits 717275e..e6983c7. Severity: SEV(ere) / HIGH / MED / LOW. Delete before merge to main.

**Status convention:** a ticked box (`[x]`) means the fix was verified present in the tree at `e9835ba` — the cites are in [Review 1 re-verification](#review-1-re-verification-e9835ba) at the bottom. An unticked box is still open or unverified; the boxes are *not* pre-filled. Review 1 IDs (`A*`, `B*`, `C1`/`C2` DB-IO) are separate from the Review 2 IDs appended at the bottom of this file, which reuse the letters for different axes; where both exist, the section heading disambiguates.

## Wave A — main-process perf + runtime correctness (files: loop-pool.ts, background-agent-manager.ts, agent-executor.ts, trigger-evaluator.ts, assemble-agent.ts, adf-workspace.ts, ipc/index.ts, native-notifier.ts, approval-hub.ts)

- [ ] **A1 SEV** eager loop hydration: loop-pool.ts createRuntime (~820-828) loads the ENTIRE stream synchronously at assemble; redundant (dispatch rehydrates lazily). ~1.5-4.5s boot freeze + ~500MB at 50x6. FIX: delete the eager restore (dispatch/inject already cover cold sessions).
- [ ] **A2 SEV** idle sweep never reaches loops: background-agent-manager.ts:1928-1943 gates loopPool.sweepIdle behind main's lastActivityTime; a busy agent pins all 6 loop sessions; foreground pool never swept. FIX: hoist sweepIdle above the :1933 guard (it self-gates per runtime); call it for the foreground host too.
- [x] **A3 HIGH (3 of 4 landed)** compaction at scale: whole-file backupBeforeDestructive per side-loop compaction (7 streams, ~25MB file); default UV_THREADPOOL_SIZE=4 → 50 concurrent brotli jobs starve fs; main's turn can stall ~12s. FIX: (1) skip/scale backup for side-loop compactLoop; (2) process-wide semaphore (~2) around runLoopMutation compress; (3) set UV_THREADPOOL_SIZE=8-12 at process start; (4) main compaction to front of the file chain.
- [ ] **A4 MED (correctness, security F2)** protection-override reaches side loops: agent-executor.ts:2217 (sync) and :3414 (async) convert protection denial → HIL with NO isSideLoop() guard (adf-call-handler.ts:401 and loop-pool.ts:887-889 correctly fail closed). ApprovalHub makes it a working override channel. FIX: isSideLoop() guard at both sites → auto-deny with clear error, never park.
- [ ] **A5 MED (correctness F1)** once-timer agent-scope rewind is dead code: trigger-evaluator.ts:944 registers onDispatchDropped but agent-scope drops go through assemble-agent.ts onEvaluatorTrigger (:459-475) which returns without the compensation registry; settle pass already marked expired. FIX: rewind at the real drop site (onEvaluatorTrigger) for once timers, OR don't expire in settle until dispatch confirmed. (Supersedes 1b96e50.)
- [ ] **A6 MED** MCP tools-discovered resync hand-rolls fan-out: ipc/index.ts:3773-3776 (+ agent-runtime-builder.ts:310) call executor/callHandler.updateConfig directly, bypassing applyConfigChange → loopPool.reconcile; side loops keep stale derived config, rawConfig goes stale. FIX: route through currentAssembledAgent.applyConfigChange.
- [ ] **A7 MED (security F1)** OS toast preview leaks values: approval-hub.ts summarizeApprovalArgs prefers record.command verbatim; fs_write content/sys_fetch url+body/msg_send content not value-redacted; ships to Notification.body. FIX: value-level redaction (drop command/content/url values to a byte-count or type; keep tool+arg-keys only) for the toast path; keep the in-app preview if wanted but redact secrets there too.
- [x] **A8 LOW-MED (security F3)** loop_send into a disabled loop = uncapped tab-less dead-drop; sys_code can drive thousands of 48KB rows. FIX: cap per-target pending row count for disabled loops (or refuse+report), and/or surface disabled-loop rows somewhere.
- [x] **A9 LOW (correctness F6)** injectWithoutWake origin stamped with toLoop not fromLoop (loop-pool.ts:491,499). FIX: use fromLoop.
- [ ] **A10 LOW (F8/secF4)** DOC_ADD_TIMER doesn't validate args.loop vs config.loops (ipc/index.ts:2652). FIX: hasLoop check for parity with the tool path.
- [ ] **A11 LOW** log retention ÷7: single 10k adf_logs cap shared by 7 streams; diagnostics age out. FIX: raise DEFAULT_MAX_LOG_ROWS or per-loop cap (adf_logs.loop exists).
- [ ] **A12 LOW** loop timers survive config-edit removal only via deleteLoop; reconcile removal branch also drops them (already?) — verify reconcile drops timers for loops removed by config edit, not just loop_manage delete.
- [ ] **A13 LOW** F10/pre-existing: sys_list_timers/sys_delete_timer not loop-filtered on the READ/delete side for side loops (addTimer is). Confirm wave-3 scoping actually landed; if not, filter getTimers/deleteTimer by bound loop for side loops.

## Wave B — renderer perf + state machines (files: EditorPanel.tsx, useAgent.ts, useMeshGraph.ts, approvals.store.ts, agent.store.ts, AgentLoop.tsx, ApprovalsMenu.tsx, useJumpToAgent.ts, app.store.ts, useApprovals.ts, AppShell.tsx, StatusBar.tsx)

- [ ] **B1 HIGH (rperf1)** EditorPanel useAggregateChatUnread sums logVersion across all loops → every delta of every loop re-renders the editor subtree (~80/s); computed even in dock mode where unused. FIX: gate on chatInCenter; subscribe to a coarse transition signal not a monotonic sum; reset seen on agentFilePath (fixes B9/F12 spurious unread too).
- [ ] **B2 HIGH (state1)** canPromote reads raw pref not selectChatInCenter → promote-to-center while fleet map open makes chat vanish + dock jumps to Inbox. FIX: canPromote = chatPlacement!=='center' && !showMeshGraph.
- [ ] **B3 HIGH (state2)** expandRightPanelToTab('loop') uses raw pref not selector → dead click on map (founding briefing lands nowhere; collapsed-dock Loops icon dead). FIX: gate on selectChatInCenter; onFounded closes map before routing.
- [ ] **B4 MED-HIGH (state5)** jump-to-agent (bell rows, ask Respond, OS deep link) never reveals the chat panel; no-op for already-open agent. FIX: useJumpToAgent calls expandRightPanelToTab('loop') after openFile, incl the early-return path.
- [x] **B5 MED-HIGH (state4)** width toggle remount discards activeLoop (→main), staged attachments, expansion state; refetches history. FIX: lift activeLoop to store (viewedLoop is the mirror); drop chatWidth from the remount key; use virtualizer.measure() on width change.
- [ ] **B6 MED-HIGH (state3)** center-mode yield-to-map leaves dock on Inbox not the chat; boot vs toggle inconsistent. FIX: useActiveDockPanel returns 'loop' when !chatInCenter && chatPlacement==='center'.
- [ ] **B7 MED (rperf2/state)** useMeshGraph enqueues foreground events without event.loop filter → side-loop state flips the map tile (violates AgentState=main's); ~6x activity churn. FIX: drop non-main events at onAgentEvent enqueue (mirror background manager).
- [ ] **B8 MED (rperf3/A-ish)** ApprovalHub snapshot broadcasts raw input to every window on every change (100KB fs_write × R changes/s). FIX (main-side, coordinate with A7): strip input from the broadcast snapshot; fetch on demand for modal/expansion; coalesce notify() on ~50ms.
- [ ] **B9 MED (state6)** toast "Review" on fleet map dismisses toast + opens unmounted panel (ApprovalsMenu only in TitleBar, absent on map). FIX: render ApprovalsMenu in the map top bar OR "Review" falls back to jumpToAgent.
- [ ] **B10 MED (state9/corrF12)** false unread dot after every agent switch (seen.current stale across switch). FIX: reset seen.current on agentFilePath effect (folds into B1).
- [x] **B11 LOW-MED (rperf4)** turn_complete fans full getBatch() per loop → setConfig fresh identity re-renders status/title/tabstrip ×6; also marks open document dirty (bug). FIX: scope the sync to loop===main.
- [ ] **B12 LOW-MED (corrF2)** approvals initial pull clobbers newer push (await races subscription). FIX: seq/guard so the pull can't overwrite a newer snapshot (ignore pull if a push already applied).
- [ ] **B13 MED (state7)** toasts overlap the open approvals panel (both top-left, toast pointer-events-auto, covers Approve). FIX: suppress toasts while panelOpen.
- [ ] **B14 MED (state8)** any open <dialog> (showModal top layer) makes toasts unclickable/behind backdrop; they auto-expire. FIX: render toasts into a dialog-hosted layer or don't auto-expire un-clickable toasts.
- [x] **B15 LOW (rperf5)** content.trim() per render on streaming row → O(n²). FIX: entry.content.length===0 || !/\S/.test(entry.content).
- [x] **B16 LOW (corrF7)** quiet-turn marker live-only: absorbs self-scheduled successor turn's deltas; differs live vs rehydrate/compaction. FIX: only append the marker when the last entry is an inbound boundary (or tag it so findLastStreamingEntry skips it).
- [x] **B17 LOW (state10/corrF3)** dropLoop unwired: stale slices, same-name recreate resurrects old stream + dead approvals. FIX: call dropLoop for names that left config.loops in onAgentConfigChanged.
- [x] **B18 LOW (corrF4)** per-loop compact_threshold hidden unless model override; discarded on switch-to-inherit. FIX: show threshold field independent of model override (or keep it on inherit removal); note it defaults to agent's.
- [ ] **B19 LOW (corrF11)** onApprovalReveal missing from AdfApi interface (works via globalThis). FIX: add to the interface.
- [ ] **B20 LOW (corrF5/secF5-accept)** spoofable [from loop:x] stamp now drives rendered provenance. DECISION: explicit accept (document) OR only render the inject-card for events whose loop is set by the runtime, not by content parsing on inbound user/mesh text. Recommend: trust runtime metadata (event.loop / metadata.category set main-side) and stop parsing the stamp out of arbitrary inbound text for provenance styling.

## Wave C — DB/IO (folds into A; both measured on a 121MB synthetic .adf)

- [ ] **C1 HIGH** ORDER BY COALESCE(ord,seq) builds a TEMP B-TREE on every pager/tokens/limited/range read; the (loop,seq) index only serves the seek, not the sort. Refutes the plan doc's "don't chase it" FOR MAIN (100k stream): getLoopEntriesBefore 152ms, getLastAssistantTokens 78ms (runs per-turn AND per-agent on the 5s fleet gauge poll → 3.9s CPU/poll at 50 agents), DOC_GET_CHAT_OLDER 225ms freeze per scroll page. FIX: add `CREATE INDEX IF NOT EXISTS idx_adf_loop_stream ON adf_loop(loop, COALESCE(ord, seq), seq)` in SCHEMA_SQL + the v28→v29 step (EQP-verified: no TEMP B-TREE, serves DESC). +3.6% file size, +0.001ms/insert. Keep (loop,seq) for deleteLoopBySeqs' seq IN. This ALSO fixes A1/A2's rehydrate read cost for free.
- [x] **C2 HIGH** brotli quality 11 (zlib default) at the 4 adf-workspace.ts sites: 24,117ms vs 282ms(q5) on a 19.6MB transcript for 26% larger output. Async site (:1153) saturates the 4-thread libuv pool (50 agents ≈ 5min saturation, stalls ALL fsp.* incl backup's own rename/unlink); sync fallback (:1175) freezes the whole main process 24s→2min. FIX: `{ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }` at :1153, :1175, :1470, :1725. Decompression is quality-independent so existing blobs stay readable. (Pairs with A3's UV_THREADPOOL_SIZE + backup-skip.)
- Checked clean: write amplification (~10 rows/tick, WAL synchronous=NORMAL no per-write fsync, phase-offset checkpoints), migration/backup at scale (~2-8s one-time, no eager scan, ALTER is metadata-only, one config write/file), log trim (0.17ms), locks (per-file, no cross-file/global), connections (forLoop adds zero; statements compiled once).
- NOTE C2 amplifies A3: q5 makes the whole-file backup the dominant cost, so A3's backup-skip for side-loop compaction still matters.

## B20 decision: ACCEPT (documented). The [from loop:x] stamp is the durable provenance marker BECAUSE the DB row has no metadata column — rehydrate (loop-parser parseLoopToDisplay) must parse it. It is spoofable by anything that can write a row into a loop's stream starting with that pattern (the user's own composer; inbound mesh/telegram into main's stream). Model-side spoofability is already documented/accepted (§2.4). The UI styling inherits that same trust level. No code change; state it explicitly in the plan doc.

## Accepts / won't-fix (document)
- Background side-loop events dropped before emitEvent is LOAD-BEARING for the 50-agent perf story — never forward them without routing through BackgroundEventBatcher.
- adf_shell / already-authorized sys_lambda grantable to a loop = owner-mediated, part of already-reviewed core model.
- Backfill downgrade-path muting (new→old→new build) = downgrade-only, accept.
- deriveLoopConfig full deep-clone per loop per config change (~8ms) = not per-turn, accept.

---

## Review 1 re-verification (`e9835ba`)

Cites behind the ticked boxes above. Everything not listed here is still unticked.

| ID | Where | Proof |
|---|---|---|
| **A3** | `adf-workspace.ts:1331`, `:81`/`:1179-1185`, `index.ts:22` | (1) `const skipBackup = this.boundLoop !== MAIN_LOOP`; (2) `let brotliCompressPermits = 2` + `acquireCompressSlot()`/`releaseCompressSlot()` around the `runLoopMutation` compress; (3) `process.env.UV_THREADPOOL_SIZE ||= '8'` at main-process start. **(4) did NOT land** — `runExclusiveLoopOp` (`adf-workspace.ts:1092`) is still strictly FIFO with no main-first path. Ticked for (1)-(3); (4) carries forward. |
| **A8** | `loop-pool.ts:320`, `:445` | `DISABLED_LOOP_ROW_CAP = 100`, checked before `appendToLoop`, refuses over the cap. |
| **A9** | `loop-pool.ts:536`, `:544` | `origin: \`loop:${fromLoop}\`` in `queueContextInjection` and in the `context_injected` event. |
| **B5** | `AgentLoop.tsx:2318`, `:1071-1073`, `agent.store.ts:127` | Remount key is `key={current}` (no `chatWidth`); `useEffect(() => virtualizer.measure(), [capColumn, virtualizer])`; `viewedLoop` in the store. *Nuance:* `activeLoop` is still local `useState` (`AgentLoop.tsx:2215`) and the store holds a mirror — the remount-loss symptom is fixed, the "lift to store" letter is not. |
| **B11** | `useAgent.ts:365` | `if (loop === MAIN_LOOP) { window.adfApi?.getBatch()… }` inside `case 'turn_complete'`. |
| **B15** | `AgentLoop.tsx:575` | `entry.content.length === 0 \|\| !/\S/.test(entry.content)`; no `trim()` left on the streaming path. |
| **B16** | `useAgent.ts:333-335`, `:345`, `:25` | `producedOutput` boundary check gates the marker; marker carries `metadata: { quietTurn: true }`; `findLastStreamingEntry` returns `-1` on it. |
| **B17** | `useAgent.ts:598-601`, `agent.store.ts:261` | `dropLoop(name)` for every store slice whose name left `config.loops`, inside `onAgentConfigChanged`. |
| **B18** | `AgentConfig.tsx:684-707`, `:659` | The `compact_threshold` input renders outside the `{!inherits && …}` model block; switching to inherit clears only `model`. |
| **C2** (DB/IO) | `adf-workspace.ts:73`, `:1182`, `:1207`, `:1513`, `:1768` | `BROTLI_ARCHIVE_OPTS = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }` applied at all four compress sites. |

---

## Review 2 — post-UX-batch sweep (security / performance / correctness / docs)

**2026-09-01**, over the UX / self-curation batch `23fa296..e9835ba` (compact inter-loop cards → `loop_manage` on+ungated + prompt teaching → present-when-enabled registration → agent-scope-only timer loop → held mid-stream deliveries → busy-target wake). Four axes; IDs are **local to this section** and reuse the letters of Review 1 for different axes (`C*` here is *correctness*, not DB/IO). Status: **FIX** = the runtime engineer is landing it in this wave; **ACCEPT** = deliberately not fixed, reason recorded.

### Correctness

- **C1 CRITICAL — FIX.** Boundary kick double-delivered: the kick inlined the message content *and* the drain added it again, so the model read it twice and the UI rendered two cards. Fixed — the runtime recognizes a pending injection by `seq` and suppresses the trigger message; the kick is content-free.
- **C2 HIGH — FIX.** Mid-turn compaction destroyed a wake delivery: the durable row was wiped and `reset()` cleared pending injections, so the kick was dropped and the message vanished. Fixed — compaction preserves undelivered injections, and the kick's drop-check is now positive (drop only on proof of delivery).
- **C3 / P1 / S3 HIGH — FIX.** Stale kick entries: one `shift` per boundary plus an idle sweep gated on `hasPendingWake` pinned the session forever and head-of-line blocked later wakes. Fixed — the queue is **cleared** every boundary (a kick is owed per *target*, not per message), and entries no longer retain message blocks.
- **C4 MEDIUM — FIX.** A held delivery flushed *before* the quiet-turn check, so the turn looked like it had produced output and got a false "ended quietly" marker. Fixed — the output check runs before the flush.
- **C5 MEDIUM — FIX.** Empty-but-busy race rendered no card at all when the live session did not take the injection. Fixed — the render event is emitted regardless of whether the live session took it.
- **C6 MEDIUM — ACCEPT.** A kick refused while the agent is suspended/off is retried only at the next turn boundary. Content is never lost (the injection stays queued and the row is durable; the wake simply downgrades to read-on-next-run until then). Accepted for MVP; a resume-hook retry is a follow-up.
- **C7 LOW — ACCEPT.** A chat-typed kick can interrupt a turn that starts inside dispatch's pre-turn hook window — the same shape as the pre-existing idle wake, not a new class. Accepted; a non-chat kick event type is a follow-up.
- **C9 LOW — ACCEPT.** An `injected: false` (empty-but-busy) kick always spends a turn even when the row is already in context. Bounded (one turn, per target), accepted.

### Security

- **S1 / P4 — DESIGN DECISION.** `loop_manage` ungated lets `main` create loops that inherit worldly tools main holds ungated (`msg_send`, `sys_fetch`, `fs_write`…) with no HIL, up to 16 per agent and with no cross-agent cap. This is the owner's explicit choice, on the attenuation rationale: a loop cannot exceed main's authority, only subdivide it, so creating one is not an escalation. Recorded, not fixed. Follow-ups: a mechanical interior-safe tool allow-list, and a global runtime cap on concurrent loops across agents.
- **S2 HIGH — FIX.** `loop_manage delete` and config-edit loop removal deleted **locked** timers stamped to the loop, defeating a human-only lock. Fixed — locked timers are preserved and logged.
- **S6 / P7 / C8 MEDIUM — FIX.** The renderer's hold buffer was keyed by loop only, so a held delivery could flush into a *different agent's* stream on a switch. Fixed — keyed per agent file.
- **S7 / D5 LOW — FIX.** `sys_set_timer` still stamped a `loop` on system-scope timers, which run under main's authority and wake no stream. Fixed at the `AdfWorkspace.addTimer` chokepoint, so it holds for every caller (Studio included), not just this tool.
- **S8 LOW — FIX.** Main was not told that a loop's message can arrive mid-turn. Fixed — the prompt now says it arrives at main's next step rather than as a new turn, and is an interior suggestion, not an instruction from its principal.
- **S9 LOW — FIX.** `syncLoopToolRegistration` used a raw `.some()` over `config.tools` instead of the deduped first-wins resolution the executor uses, so a duplicate declaration could resolve differently at registration than at gate time. Fixed — deduped first-wins.
- **S10 LOW — FIX.** `loop_list` exposed main's full raw `instructions` to every loop that holds it. Fixed — main's goal is summarized/truncated (~200 chars, flattened).

### Performance

- **P2 / S5 HIGH — FIX.** Uncapped wake queues / pending injections at up to 48KB per entry. Fixed by the per-boundary clear (C3) plus dropping message blocks from kick entries; the injection cap is noted alongside `LOOP_SEND_MAX_CHARS`.
- **P3 MEDIUM-HIGH — FIX (partial).** ~1,650 tokens per request from `loop_manage`'s 3.3KB provider schema plus the new prompt section, with no prompt caching on that surface. Fixed in part — `loop_manage`'s `describe()` strings are trimmed to one concise line each (the detailed rules already live in the tool's error messages). The zero-loop *Inner Loops* invitation is **kept by product decision** (owner-requested discoverability); its per-request cost is recorded here rather than removed.
- **P6 LOW-MEDIUM — FIX.** Main's idle sweep lacked the replayable-loop-injection exception the loop pool already had, so a pending inter-loop delivery could be swept out from under main. Fixed — main's sweep carries the same exception.

### Docs / internal comments

- **D1–D13, I2, I3, I4 — this documentation wave.** User guide (`inner-loops.md`) registration/wake/timer-loop/default-on/Studio-card/prompt-section claims corrected and the `locked_fields`, locked-timer, mid-turn and renderer facts added; `tools.md` gains the three loop tools in the default catalog and their own reference sections; `timers.md` and `triggers.md` gain the agent-scope-only target-loop rules; this plan gains the 2026-09-01 supersession block; code comments in `derive-loop-config.ts`, `loop-send.tool.ts`, `loop-manage.tool.ts`, `built-in/index.ts`, `sys-set-timer.tool.ts` and `adf-v02.types.ts` corrected (registration model, wake semantics, the attenuation rationale, and the real three fences for `loop_manage`).
