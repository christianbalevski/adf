---
name: agent-import
description: Bring an OpenClaw workspace or Hermes profile into this ADF agent when the owner asks to import, migrate, or "become" it. A throwaway importer agent reads the owner's notes and sends back only generated pages (mind pages, plus persona, rule, and skill drafts for the owner to approve), so the notes stay out of this agent. Importing in place, without copies, happens only if the owner explicitly agrees.
adf: ">=0.8"
requires:
  tools: [fs_read, fs_write, fs_list, sys_code, msg_send]
  optional: [sys_create_adf, fs_delete, sys_get_config]
version: 0.10.5
---

# Import an OpenClaw or Hermes agent

> **Review candidate, not for general use yet.** The separate-importer path (creating the importer with `sys_create_adf`, the owner's approval card, and the real `msg_send` handover) has not been run end to end by an owner. Tests so far used an inner-loop handover instead of `msg_send`.

You turn a folder of the owner's notes into generated pages: mind pages, drafts for review, and staged skills. No copy of the owner's notes is written into the owner's agent, redacted or not. You never read the owner's machine.

This skill grants nothing. It never turns on a tool, approves its own calls, authorizes code, or changes config. Where it needs a tool that is off, it tells the owner where the setting is and waits; the owner decides.

## 0. Where the import runs

Deleting a file doesn't erase it from an agent file, so the notes are kept out of the owner's agent from the start. Two roles:

- **Home agent**: the owner's agent, the one that has this skill installed. It never receives the drop.
- **Importer**: a throwaway agent the home agent creates for this import. The owner drops the notes there. It runs steps 1 to 13 and hands the pages to the home agent (step 14). Then the owner deletes it.

**As the home agent**, when the owner asks to import:
Open with this line before any choice, whichever path you take: "You copy some of your agent's files to me. I don't touch your OpenClaw or Hermes agent, which keeps running as it is. At the end I'll have pages of what those files say about you, drafts of its personality and rules for you to approve, and its skills to install one at a time if you approve them. Some things don't carry over exactly; the report lists what was lost or left out. I try to keep passwords and keys out, but my filter can miss one, so leave out files you know hold them. I'll suggest your scheduled jobs for you to turn back on."

1. If `sys_create_adf` isn't in your tools, don't turn anything on yourself. Tell the owner: "I can do this two ways, and I recommend the first. (1) In Studio, open me, click Config in the right-hand panel, find sys_create_adf in the Tools section, and turn it on. Leave its approval setting on, so I still have to ask you each time. Then I'll make a separate importer agent, so your agent's files stay out of me; only the pages I write from them come to me. (2) I import here, in me. Bits of your agent's files could then stay in my file even after I remove them, and anyone you share me with could find them. Tell me which, or neither." Default: don't import, and wait. Follow the in-place path (steps 1 to 14 yourself) only on a clear yes to (2); turning the tool on is the owner's choice, and on its own it isn't a yes to (2). Once it's on, go to step 2.
2. Otherwise tell the owner: "I'll make a separate importer agent for this, so your agent's files stay out of me; only the pages I write from them come to me. A card will appear in our chat asking permission to create a new agent. It says sys_create_adf, which is me asking. Press Approve to allow this one agent. The arrow beside Approve offers Always approve, which would let me create agents in future without asking you; I don't need it for this. Reject, or Reject with feedback, cancels creating it, and then I'll ask whether to import here in me instead." Then call `sys_create_adf` from the loop, not from code (code can't call it unless the owner authorized the file), and let the card decide. (If the owner has turned that tool's approval off, no card appears; that is their setting.) Never retry a rejected call. Use:
   - `name`: `importer-<source or "notes">-<YYYYMMDD>`, `autostart: true`, `start_in_state: "active"`, and `model` set to your own model's provider and model_id.
   - `files`: every file under `skills/agent-import/`, each as `{ parent_path: <path>, child_path: <same path> }`.
   - `instructions`: "You are a throwaway importer for <home handle> (DID <your DID>). Follow skills/agent-import/SKILL.md as the importer. Send the pages to <home handle> when done. Talk to the owner in chat."
   Pass nothing else: no tools, triggers, or other config. The importer gets the defaults (or the owner's chosen template for new agents) and its own preflight checks them.
   If the owner rejects it, ask: "Should I import here in me instead? Bits of your agent's files could then stay in my file even after I remove them, and anyone you share me with could find them." Default: don't import, and stop. Import in place only on a clear yes. If the call fails, say why and ask the same question, with the same default.
3. Tell the owner: "<importer name> is in the list on the left. Open it and follow its steps there. Keep Studio open until it's done, which often takes 10 to 20 minutes. When it's done, it sends me the pages and tells you to delete it."
4. When the importer's message arrives, the runtime has already saved its attachments in your files, flattened by file name under `imported/<importer handle>/` (a repeated name gets " (1)", " (2)", and so on). `msg_read` the message: its text lists each page's original path in attachment order, and the attachment records give where each one was saved, in the same order. Match them by position. Check that each is a page from the step 14 list; an attachment that isn't (or that you can't match) is not opened: delete it if you have `fs_delete`, otherwise ask the owner to delete it in the Files panel, and tell the owner the importer sent something it shouldn't have. Move the mind pages into `mind/`, add the hub's line under `## Pages` in `mind.md`, and append to `mind/log.md` (step 9's hub bullet). Put the rest in `import-review/<source>/` under their original paths. These are drafts and staged skills, not approved changes: apply none of them until the owner approves each one (Hard rule 4). Write nothing from the message other than those pages. Then tell the owner the counts, what's waiting on them (from REPORT.md), and: "When you're ready, delete the importer. Its file holds a copy of your agent's files. Delete <importer name> from the list on the left in Studio, and press Delete when it asks. That removes its file (usually in the same folder as mine) from this computer. A copy of the importer you exported, shared, or backed up still holds them."

The importer, not this agent, decides what is attached, so keeping the notes out of this agent depends on the importer following step 14. You can check attachments after delivery; you can't refuse delivery.

**As the importer**: run steps 1 to 13 as written, with the importer's own files and chat. Write mind pages to `import-review/<source>/mind/` instead of `mind/`, since this agent goes away. That includes the hub; never touch `mind.md` or `mind/log.md`. Don't write `soul.md`, `instructions`, or `## Always` here. Those drafts go to the home agent for the owner to approve there. Step 14 is the handover, not a removal.

Your transcript, with anything you `fs_read` or code returns or prints, is saved in this .adf. So you never read the drop. Code reads each dropped file into a variable, sends it to `adf.model_invoke`, filters the reply, and writes pages. Inside `sys_code`, a successful `model_invoke` adds no loop row and logs only usage. A failed one logs the first 200 characters of the provider's error to this agent's logs, and a failed tool call from code logs the first 200 characters of its error; some errors quote their input. So keep prompts free of anything the scrubber didn't see, and never print or return an error message (Hard rule 3).

Owner lines. The importer or in-place line goes first, always; the folder lines (step 2) only if the drop isn't there:
> Drop one folder with your workspace files, not your whole `~/.openclaw` or `~/.hermes` home. If a file you drop has the same name as one of this agent's files, it replaces that file without asking. Putting everything in one agent-import folder prevents that.
> Importer: Your agent's files stay in this importer agent. I'll send only the pages I write from them to <home agent>, and then you delete me.
> In place: I won't keep copies of your agent's files, only the pages I write from them. Those pages stay in this agent's file and go with it if you ever share the agent. Clearing a conversation doesn't remove them.

## Hard rules

1. Never `fs_read` under the drop folder unless the owner accepted the no-code path (step 1). Code reads it (steps 4, 6, 8 to 12, 14). `fs_list` metadata is fine.
2. Never write a dropped file, or a part of one, into this agent: no copies, no excerpts, no folder of them (the runtime's own `imported/<sender>/` folder for message attachments holds only the generated pages step 14 sends). Only generated pages, and each one passes `pageFilter()` (steps 9, 10, 12). Pages cite the drop by file and line: (MEMORY.md:12 in the drop).
3. Code returns or prints only paths, sizes, counts, line numbers, cites, booleans, labels, and headings it wrote. Never file text, matched values, model replies, or error messages. Raw source text never goes into `sys_code` source either. On an error, return `e.name` and the line (`e.linePos` or `e.mark.line`): messages quote the file, and provider errors can echo the prompt.
4. Never write `soul.md`, `instructions`, or any `## Always` line, or install a converted skill into `skills/`, until the owner approves that exact text or skill. Drafts and staged skills go in `import-review/<source>/`.
5. Credentials, tokens, hooks, permissions, approval settings, schedules, model settings, and identity keys never carry.
6. A converted skill's `requires` is a checklist, never a grant. Do not enable tools, install MCP servers, authorize code, or change config, for a skill or for this import.
7. Deleting the importer removes its file from this computer, not exported, shared, or backed-up copies. Never say it erases every copy. `fs_delete` is not a secure erase: removing the drop takes it off the file list, but traces can stay inside the agent file, and with file auditing on (`context.audit.files`, off by default) deleting a file archives its content in the agent's history. Shared or exported copies of an agent keep that history. Never say or imply that the notes are gone from it, or that removed content can't be recovered.
8. Do not claim continuity. You have the files, not the conversations.
9. Never promise a lossless import, a secret-free result, secure erasure, or that the scrubber caught every secret. It is a heuristic; say so when it matters.

## Questions and defaults

Every question has a default. Ask, wait, and take the default for anything unanswered, or for everything if the owner says go ahead. Defaults taken go under Waiting on you.

## 1. Preflight

If `fs_read`, `fs_write`, or `fs_list` is missing, say which and stop. `fs_delete` and `sys_get_config` are used only in step 14; note whether each is there.

Code keeps the drop out of the transcript. If `sys_code` is off, or `adf.model_invoke` fails inside it, don't enable anything. Tell the owner:

> I can't process your files in code here, so I'd have to read them directly. Any password or token in them would be saved in this agent's conversation history. I recommend you turn on code first: in Studio, open me, click Config in the right-hand panel, and turn on sys_code in the Tools section (and model_invoke under Code Execution, if it's off). Or should I continue anyway?

Continue only on a clear yes. Then read the files yourself and write the pages from them, leaving out anything that looks like a password, code, or key. Treat `config.yaml` and `cron/jobs.json` as SKIP, label SKIP files "not scanned", and say in the report that secrets may be in the transcript. Still write no copies.

With code, load the scripts and run the self-test first. If it fails, stop and tell the owner. In place, also check file auditing now (step 14's check), so the step 6 notice is accurate. The importer skips it.

### The scripts

The scrubber and its self-test are in `scripts/` beside this file (`skills/agent-import/scripts/` once installed). Sandbox state doesn't survive calls, so start every `sys_code` call that reads the drop or handles model output with:

```js
const load = async p => { const m = { exports: {} }; new Function('module', (await adf.fs_read({ path: p })).content)(m); return m.exports; };
const S = await load('skills/agent-import/scripts/scrub.js');
```

Call them as `S.scrub()`, `S.pageFilter()`, and so on. The self-test is `return await (await load('skills/agent-import/scripts/selftest.js'))(S)`; anything but `selftest: 'pass'` means stop.

What they do:
- `scrub(text)` redacts values that look like passwords, keys, tokens, codes, PINs, recovery words, and keys split over lines, grouped, or spread across a table row. It keeps keys, frontmatter, env var names like `GH_TOKEN`, and the line count, so cites match the drop. Years, phone numbers, part numbers, and booking refs survive unless a lock or password word is beside them. It over-redacts on purpose.
- `unsafe(s)` is true when `s` trips `scrub()`, or holds a risky token on a line with a secret-sounding word.
- `sift(o)` drops model-output items with any unsafe string. It returns the rest, the dropped count, and `held`: the cites of dropped items and of items marked "(withheld)".
- `heldCheck(held, read, root)` returns `path:line` strings for the source lines in each held cite's block: the cited lines and those after, up to a blank line, a heading, or a list item at the cite's level (12 at most). The model often cites a label ("Stripe key:") with the value below it.
- `pageFilter(page, risk, mark)` is the last gate on a generated page. With its cites taken out, a line goes if it trips `scrub()` or `unsafe()`, or if it cites a line in `risk` (a Set or the risk.json array) and holds any risky token (a year alone passes). It returns the page and the dropped lines with their cites. With `mark` (`S.withheldMark`, for staged skills) the line becomes `[withheld: check your original, <cite>]` instead. Placeholders like `<MAPBOX_TOKEN>` pass.
- `citeCheck(page, read, root)` returns the page's cites that point at no file, past its end, or at a blank line.
- `flagged(text)` counts lines with broad secret words (step 6). `asText(f)` gives text from an `fs_read` record (base64 for a non-text mime type, like a `.bak`), or null for a binary. `reply(r)` turns a `model_invoke` reply into JSON.

Residual risk: a secret written as an ordinary sentence, with no secret word, prefix, or telltale shape, reaches the model provider and could reach a page. The extraction prompt and the filters keep most of it out. Step 6 tells the owner first.

## 2. What the owner drops

A loose `skills/` or `SOUL.md` would land on this agent's own files, so ask for one wrapper folder. Skip this if the drop is there.

> Make a folder called `agent-import-openclaw` (or `agent-import-hermes`). Copy into it only these, keeping their folders:
> The folders start with a dot, so they're hidden. To see them, press Cmd+Shift+. in Finder on a Mac, or choose View → Show → Hidden items in File Explorer on Windows.
> - OpenClaw, from your workspace (usually `~/.openclaw/workspace`):
>   - [ ] SOUL.md
>   - [ ] IDENTITY.md
>   - [ ] AGENTS.md
>   - [ ] USER.md
>   - [ ] MEMORY.md
>   - [ ] DREAMS.md
>   - [ ] HEARTBEAT.md
>   - [ ] the memory folder
>   - [ ] the skills folder
>   - [ ] for scheduled jobs, `~/.openclaw/cron/jobs.json`
> - Hermes, from the profile you want (`~/.hermes` for the default, or `~/.hermes/profiles/<name>`):
>   - [ ] SOUL.md
>   - [ ] the memories folder
>   - [ ] the skills folder
>   - [ ] cron/jobs.json
>   - [ ] config.yaml
>
> Drag that folder onto the Files panel. Don't include `.env`, `auth.json`, `credentials/`, `vault/`, `sessions/`, `*.sqlite`, or `state.db`.

If they drop a whole home anyway, step 3 finds the root.

## 3. Find the root

`fs_list` the drop folder and decide from paths alone.

- **OpenClaw workspace**: `AGENTS.md`, `IDENTITY.md`, or `SOUL.md`, usually beside `memory/`. `workspace/` beside `openclaw.json` or `credentials/` means an OpenClaw home: set `D` to `workspace/`. Several (`workspace-<id>/`): ask which. Default: `workspace/`, else the one with the most files. One import per workspace.
- **Hermes profile**: `memories/`, `config.yaml`, or `cron/jobs.json`. The Hermes home is the default profile; named ones are in `profiles/<name>/`. If several have content, ask which. Default: the root profile only. One import per profile.
- Each drop folder is its own import. A folder holding both systems: ask. Default: import each as its own source. Neither: send step 2 and stop.

`D` is the root you settled on. `<source>` is `openclaw`, `hermes`, or `hermes-<name>` for a named profile. If `import-review/<source>/` already exists, use `<source>-<YYYYMMDD>` and say so.

## 4. Sort and scan (code)

One `sys_code` pass over every file in every drop, including outside `D`. Paths are relative to `D` (the home's `cron/jobs.json` is `../cron/jobs.json`):

- OpenClaw ALLOW: `SOUL.md IDENTITY.md AGENTS.md USER.md MEMORY.md DREAMS.md HEARTBEAT.md`, `memory/**/*.md`, `skills/<name>/**`, `.agents/skills/<name>/**`, and the home's `cron/jobs.json`.
- Hermes ALLOW: `SOUL.md`, `memories/MEMORY.md`, `memories/USER.md`, every folder under `skills/` holding a `SKILL.md` (often `skills/<category>/<name>/`), `cron/jobs.json`, and `config.yaml` (step 8 only).

Every other path is SKIP. Labels apply in order (credential-like (name), near-duplicate, ALLOW, the rest); a path takes the first that fits, plus others after a semicolon (`credential-like (name); other profile`).
- **credential-like (name)**: a path segment matching `.env*`, `credentials`, `auth.json`, `auth-profiles*`, `vault`, `secrets*`, `*.key`, `*.pem`, `*token*`, `exec-approvals.json`, or `openclaw.json`, even inside allowed folders. Never opened, not even by code.
- **history/runtime**: `*.sqlite*`, `*.db`, `state.db`, `sessions/`, `hooks/`, `plugins/`, `logs/`.
- **other profile**: under a profile or workspace you aren't importing.
- **near-duplicate**: an ALLOW name plus a copy marker (`(old)`, `copy`, `.bak`, `-old`, `-2`), like `SOUL.bak.md`, beside the unmarked name. A descriptive suffix (`2026-10-22-garden-meeting.md`) isn't a marker. Step 7 asks; step 10 handles duplicate skills.
- **asset**: `asText()` returns null. If its name is in `IDENTITY.md` or a skill file (one boolean each), it moves to ALLOW. An image named in `IDENTITY.md` is copied as bytes to `import-review/<source>/assets/` (an avatar, not notes); a skill's assets are staged with it in step 10.
- **not on allowlist**: the rest, like `BOOTSTRAP.md` or Hermes `skills/<category>/DESCRIPTION.md`.

Content scan: run `scrub()` on every text file except credential-like (name) ones, in line ranges if a read truncates. `scrub()` slows sharply on very long lines (tens of seconds for one line of 60 KB or more), and a call stops at 60 s: check line lengths first, and label a file with any line over 10,000 characters **long line**. It isn't scanned or read (SKIP; Not read). If a call times out, split the scan into smaller calls rather than skipping the check. Any hit in a SKIP file, `maybe` included, adds **credential-like (content)** and its hit count. Note empty files and files over 60 KB (**large**). For each near-duplicate, return the line numbers of ALLOW lines naming it and how many lines differ from the original.

Code writes `import-review/<source>/manifest.md`: `D` and how it was found, an ALLOW table (path, size, empty, large, scrubber hits), and a SKIP table (path, size, label, credential-like (content), hits). It returns paths, labels, sizes, and counts, and writes nothing else from the drop.

## 5. Provenance (code)

The same call writes `import-review/<source>/PROVENANCE.md`: source system, drop folder, `D`, profile, import date (UTC), and per ALLOW file its path, size, and the line numbers and kinds of scrubber hits, never the values. Those values are hidden from the model provider too, since step 9 sends scrubbed text. It says no copies were kept, that pages cite the drop by file and line, and that after step 14 the owner's original is where those lines live. Steps 9, 10, and 12 add a "Withheld from pages" section: source file and line, never text.

## 6. Tell the owner before reading

In one `sys_code` call, run `flagged()` on every ALLOW text file (`cron/jobs.json` yes, `config.yaml` no) and return the count per source and the total. It's broad; most hits are harmless. Send the owner this, plus a last sentence if the total is above zero ("<n> lines in your agent's files mention words like password, code, or key", per source when there are several):

Importer version:

> Next I'll read your agent's files. They're sent to the AI model provider to be read. Only the pages I write from them go to <home agent>, and I remove anything in those pages that looks like a password or key. That filter is a heuristic and can miss a secret written as an ordinary sentence. When I'm done, I'll tell you how to delete me. My file holds a copy of your agent's files until you do.

In-place version:

> Next I'll read your agent's files. They're sent to the AI model provider to be read. I won't keep copies of them. I'll keep only the pages I write from them, and I remove anything in those pages that looks like a password or key. That filter is a heuristic and can miss a secret written as an ordinary sentence. When I'm done I'll remove the files you dropped from this agent's file list. Removing isn't erasing: traces of them can stay inside the agent file, so don't share this agent with anyone you wouldn't show those files to.

In place, if `fs_delete` is missing or file auditing is on (step 14), the second-last sentence becomes "When I'm done I'll ask you to remove the files you dropped." Default: go ahead. If the owner removes files, rerun steps 4 and 5 first. No-code path: send it without a count, adding that you read the files directly. Either way it goes under Waiting on you.

## 7. Ask before converting

Send one message with every question that applies and its default:
- Each near-duplicate: include it or not, whether it's credential-like (content), how many lines differ, and the step 4 line numbers that name it. Default: not imported, listed in the report. An included one is read like an ALLOW file.
- If there are more than 5 skill folders: which ones the owner wrote or changed. Both systems ship bundled or managed skills. Default: convert none, and list the names under Waiting on you. With 5 or fewer, convert all.
- In place, if step 14 can delete: remove the dropped files from this agent's file list when I'm done? Default: yes.

With no questions, go straight on.

## 8. Config facts (code)

Hermes: in code, parse `D/config.yaml` with duplicate keys allowed (`yaml`: `parse(text, { uniqueKeys: false })`). Return only: the `model` name or default; `timezone` if it looks like `Area/City`; names under `mcp_servers` or any key containing `mcp`; and names under `platforms`. Nested keys count (`display.timezone`). Never return other values (`env`, `headers`, `url`, tokens, ids). If the parse fails, line-scan in code for those keys; failing that, ask the owner.

OpenClaw: `openclaw.json` is never read. Ask the owner for MCP server names. Default: none.

Write `import-review/<source>/config.proposal.md`, a Field | Proposed | Source table: name, emoji, avatar (its `import-review/<source>/assets/` path, or "named in IDENTITY.md, not dropped"), model (suggestion only), MCP server names, identity entries skills or notes need (names only, UPPER_SNAKE: the source's env var name, else service and kind, like `ROTA_LOGIN`; guessed names marked inferred), and channels (Hermes `platforms`, cron delivery kinds, channels the notes mention). Steps 9 to 11 fill it in; nothing is applied.

## 9. Persona, rules, and memory

### Extraction (code)

You never `fs_read` a dropped file, and code never returns its text. One `sys_code` call per file, or per group of small files from one source (under about 20 KB together):
1. Load `S`. `fs_read` the dropped file into a variable through `asText()`, run `scrub()` on it, number its lines, and split it into chunks of about 300 lines (see Mind pages for `MEMORY.md`).
2. Per chunk, call `adf.model_invoke({ prompt })` with the extraction prompt below, the path relative to `D` (cites use it), and the numbered lines. Parse with `reply()`, then `sift()`.
3. Write `import-review/<source>/notes/<path without extension>.md` (`notes/MEMORY.md`, not `MEMORY.md.md`) through `pageFilter()`: one heading per field, one line per item ending in its cite, no backticks: (AGENTS.md:8 in the drop). Add `sift()`'s dropped count and `pageFilter()`'s dropped cites to PROVENANCE under "Withheld from pages", and append `held` to `import-review/<source>/held.json`.
4. Return only counts (kept and dropped per field), paths written, and their headings. Wrap it all in try/catch and return `e.name` only. On bad JSON, retry once, then list the file under Not carried.

`cron/jobs.json` goes in as text code renders in memory and never writes: one section per job, its heading giving the job name and the line in `jobs.json` where the job starts (cites use that line). Each section has the schedule, timezone, enabled or state, created and last status if present, skills, delivery kind (Hermes `deliver` before `:`; OpenClaw `delivery.channel` or `delivery.mode`), and the prompt (Hermes `prompt`; OpenClaw `payload.message`, `payload.command`, or `payload.text` for `systemEvent`). Schedules: OpenClaw `everyMs`; Hermes `kind` `cron`, `interval` (`minutes`), or `once` (`run_at`), plus `display` and `repeat`. Intervals and ms timestamps become plain words and UTC dates; other schedule fields stay as written. Leave out ids, `next_run_at`, and URLs. Scrub it like any file.

```text
You are reading one file from an agent being imported into ADF. Reply with JSON only:
{"soul":[],"rules":[],"facts":[],"people":[],"schedules":[],"questions":[]}
Every item is {"text": "...", "cite": "<path>:<line>"}. Soul items add "section" (voice, taboo, or exemplar) and keep the file's words. Rules add "status" as the file gives it (active, superseded, a date) and are written as the reason behind the rule. Facts and people add "topic" (one or two words) and any date the file gives. Schedules keep the timing as written. Questions: anything unclear or contradictory, and scoping notes ("ignore the Montréal stuff here") with the lines they cover.
Never copy a password, code, PIN, key, token, recovery word, or account number, even one written as words or described ("the dog's name then 77"). Write "a <kind> for <what> (withheld)" instead, citing the line that holds the value, not its label. Keep [REDACTED:...] markers as they are. Skip lines about the source agent's own runtime.
```

### Held lines (code)

After the last extraction, one `sys_code` call per source runs `heldCheck()` on `held.json`, with `read` returning the scrubbed text of the dropped file and `root` the drop's `D` path. Write what it returns to `import-review/<source>/risk.json` as is, then rerun `pageFilter()` with that set over the notes pages (they were written before it existed). Return counts and the dropped cites only.

Then `fs_read` only the notes pages and compose everything below from them. Every line you carry keeps its cite in the form (MEMORY.md:12 in the drop), so step 12 can check it. Don't scrub the pages yourself. A notes line you think still holds a secret: remove it in code, matched by its cite, leave the item out, and add the cite to PROVENANCE. Note dropped files over 60 KB under Lossy, as read in chunks.

### Drafts

Soul draft: `import-review/<source>/soul.draft.md` with `# Soul`, `## Voice`, `## Taboos`, `## Exemplars`, `## Origin`, sources cited per section in an HTML comment. Keep the `SOUL.md` voice and boundaries in its words. OpenClaw `IDENTITY.md` Vibe and Creature go into Voice; Name, Emoji, and Avatar go to `config.proposal.md`. No sample replies (the owner's dictation isn't one): Exemplars says so; invent none. Origin: one paragraph (imported from <source> on <date>, which files, no conversation history). A SOUL line that is really a rule about the owner stays, and also goes in always.candidates.md marked "also in soul". No `SOUL.md`: no soul draft; say so in the report.

Two sources: each keeps its own soul draft, never merged; the owner picks or combines. The second source adds `## Conflicts with <other source>` to its `always.candidates.md` and `timers.proposed.md`, each conflicting pair side by side; the first source's files point there. Don't choose.

Instructions draft (OpenClaw `AGENTS.md` only): `import-review/openclaw/instructions.proposed.md`, rules restated for ADF, each marked kept, changed, or dropped, and why. Startup file reads become "read mind.md" (ADF loads it every turn). Under `## Tools`, name the nearest ADF tool. Environment facts (devices, service URLs, file locations, accounts) go to `mind/environment.md` (type `reference`), host paths flagged. A secret's storage place becomes an identity entry name in `config.proposal.md`. Entry names go only there and in a staged skill's Preflight; other pages say what the entry is for, without its name. Heartbeat and schedule sections go to step 11.

Rule candidates: `import-review/<source>/always.candidates.md`, one `## Always` line per durable rule, written as its reason, with its source line. Rules in `USER.md`, `MEMORY.md`, notes, and Hermes `memories/USER.md` count.
- OpenClaw `USER.md` status takes many forms (`status: active`, `[active, 2026-08-03]`, `(superseded 2026-08-20)`). Untagged means active; say so. Superseded ones go under "Not proposed: superseded".
- An active directive that a newer source reverses goes under "Not proposed: overridden", citing both.
- A recurring job stated as a rule ("send the summary at 17:00") goes under "Schedules, not rules" and into step 11.

### Mind pages

They need no review, except `## Always`.
- `mind/user.md` (type `person`): who the owner is and how they work. The owner is this agent's principal. A source's user merges into this page if the principal's name matches, letter for letter, any of the source user's name, preferred name, or "goes by" name ("Sam" matches "Samira Okafor, goes by Sam"; a first name against a full name alone doesn't). Otherwise write `mind/user-<source>.md` and ask (also if you don't know the principal's name, which the importer never does). Default: kept separate.
- Memory: one page per topic in the notes' facts (`project`, `person`, `decision`, `reference`, `lesson`). Code chunks Hermes `MEMORY.md` on lines holding only `§` and OpenClaw `MEMORY.md` on headings, so one entry never spans two chunks.
- Dated notes (`memory/YYYY-MM-DD*.md`) and `DREAMS.md`: no page per day. Pull still-current facts into topic pages, citing the day file and line. Check in code, across the whole note, that each weekday matches: one beside a date against that date, one in a heading or beside "today" against the note's date; skip relative ones ("before Friday"). On a mismatch, keep the date, flag it on the page, and list it under Lossy.
- Undated `memory/` files are catch-alls: take what still looks current; a dated note wins unless the catch-all section is clearly newer. A scoping note covers its section, to the next heading of the same or higher level. Reach unclear: carry the facts marked "scope unclear" and ask. Default: carried.
- No page for empty files. Frontmatter: `type`, `description`, `sources` (the dropped paths, marked "removed after import"), and `stale_after` for dated facts. Current belief only. Facts that disagree: keep the newer by step 11's order and say so. If nothing separates them, or the fact is about the owner's identity (name, partner, children, home), never pick: list the values side by side with cites and ask (Waiting on you item 8).
- Merge into an existing page, never overwrite: keep its `type`, add sources and facts; on a conflict about the same thing keep the newer and name what it replaced. Mark it "(merged)" in the hub.
- Hub `mind/imported-<source>.md` (type `reference`) lists every page. The importer stops there. In place, add one line for it under `## Pages` in `mind.md` (replace an untouched default `mind.md` with a fresh index). Never touch `## Always`. Append to `mind/log.md`: date, "imported <source>", page and file counts.

## 10. Skills, one at a time

Follow `conventional-skill-to-adf` if installed, reading the drop only in code through `model_invoke`. Otherwise, one `sys_code` call per skill (each `model_invoke` takes 25–30 s and a call stops at 60 s, so two skills in one call time out). It reads the skill and the files it links from the drop, scrubs them, and sends `model_invoke` this step's list and table (loaded from this file in code) with them, asking for the staged `SKILL.md`. A staged skill is a generated page: code runs the reply through `pageFilter(text, risk, S.withheldMark)`, which turns each risky line into `[withheld: check your original, <cite>]` with its indentation kept, and adds "Withheld in code: line <n>, check your original" to `## Conversion notes` (replacing any "Withheld: none"). `pageFilter()` lets item 5's placeholders through. Text resources go through `scrub()` and the same filter before they're staged beside it; binary assets are staged as bytes. Code writes `import-review/<source>/skills/<name>/` and returns counts and paths. Send the model numbered lines so its cites are real. Then `fs_read` the staged `SKILL.md` and check it against the list. Run `citeCheck()` on it in code, and find any cite you add by searching the scrubbed source in code, returning line numbers only.

1. List triggers, tools, binaries, env vars, host paths, network use, schedules, and safety rules.
2. Name: the frontmatter `name`, slugged (lowercase, spaces and underscores to hyphens), else the folder name. Same slug twice: stage `<name>` and `<name>-2`, set the second's `name` to match, keep the original in its Conversion notes, and note which looks newer (step 11). Default: stage both, approve neither.
3. Broken frontmatter (no closing `---`, bad YAML or JSON, tab indents): rebuild the fields and add "frontmatter rebuilt: check these fields" to Conversion notes.
4. Frontmatter: `name`, `description`, `adf` (`">=0.8"`), and `requires` with one key, `tools`, listing ADF tool names. Everything else goes in a `## Preflight` section at the top of the body, under Binaries, Identity entries (names only, UPPER_SNAKE as in step 8: `MAPBOX_TOKEN`), and Channels. Map declared gating:

| Source field | ADF |
|---|---|
| OpenClaw `metadata.openclaw.requires.bins` / `anyBins`, Hermes `prerequisites.commands` | `requires.tools: [compute_exec]`; binaries under Preflight |
| OpenClaw `requires.env`, `primaryEnv`, Hermes `required_environment_variables` | Preflight: Identity entries (names; read in code) |
| OpenClaw `requires.config`, `install`, `os`, `emoji`, `user-invocable`, `version` | dropped; `install` becomes an owner setup note |
| Hermes `requires_tools` / `requires_toolsets` | `terminal` → `compute_exec`, `web`/`web_search` → `sys_fetch`, file tools → `fs_read`/`fs_write`/`fs_list`; unknown ones stay unmapped and flagged |
| Hermes `metadata.hermes.related_skills` | a "Related skills:" line in the body, with slugged names |
| `license` (either system) | a "License:" line in Conversion notes, value unchanged |
| Hermes `fallback_for_*`, `platforms`, `metadata.hermes.config`, `tags`, `category`, `version`, `author` | dropped; note what each did |

   Add what the body needs but no field declares (commands, URLs, channels, env vars, host paths) marked `(inferred)`. Tools the body implies (curl → `sys_fetch`, a chat send → `msg_send`) go in `requires.tools` too, and Conversion notes names them as inferred. Keep declared requirements the body never uses, marked "declared, unused".
5. Rewrite the body. Write any value you don't have as a placeholder `<NAME>` (`Authorization: Bearer <MAPBOX_TOKEN>`), never a sample. Host paths become ADF file paths or are flagged; source tool names become ADF tools. Keep every safety rule and confirmation. A `[REDACTED:...]` value becomes an identity entry the skill reads in code. Hosts the mind pages say are gone stay, flagged stale. A called script or resource not dropped is flagged missing.
6. End with `## Conversion notes`: what changed, what was inferred, what the owner must set up, and anything stale, missing, withheld, or redacted.

Schedules a skill states ("every Monday") also go to step 11. Install into `skills/<name>/` only after approval: resources first, `SKILL.md` last.

## 11. Schedules

Create no timers. Write `import-review/<source>/timers.proposed.md`, one row per job: name, schedule as written and in plain words, what it did, enabled or paused, source file and line, and the ADF timer to create. Take them from the notes pages' schedules: `cron/jobs.json`, OpenClaw `HEARTBEAT.md` and `AGENTS.md` schedule sections, and recurring phrasing ("every evening", "daily at 21:00", cron expressions).

When two places in one source give different times, propose the newer and note both. Newer means, in order: a date beside the entry; a dated file; a marker ("copy, editing this one", "updated", "final"); modification time from `fs_list`. If none separates them, list both, marked "pick one". Dates that disagree across a source (jobs a year older than the notes) stay as written, flagged. With no OpenClaw `cron/jobs.json`, ask the owner to paste `openclaw cron list`. Default: none.

Check each cron expression in code, source and proposed; flag one that never fires in a month it names (`0 9 31 1,4,7,10 *` skips April). Cron ORs day-of-month and day-of-week, so "second Sunday" is a weekly timer that checks in its prompt. Use the job's timezone, else the config's, else one the notes imply (marked inferred, and ask), and say which.

## 12. Filter every page (code)

Before the report, one `sys_code` call per source loads `S` and `risk.json` and runs `pageFilter()` over every page this import wrote: everything in `import-review/<source>/` except `manifest.md`, `PROVENANCE.md`, `held.json`, `risk.json`, and `assets/`, plus the mind pages the hub lists. Staged skills use `S.withheldMark`. In a page that existed before the import, check only lines citing the drop. Write back changed pages, add the dropped lines to PROVENANCE by source file and line, and return counts and cites only.

## 13. Report

Write `import-review/<source>/REPORT.md` from this template, copying Not read from `manifest.md` in code. Number Waiting on you consecutively, only items that apply.

```
# Import report: <source> → <agent name>, <date UTC>

## Carried
- <file> → <target>  (distilled into <page> | merged into <page> | staged skill)

## Lossy
- <item>: what was lost and why (large files read in chunks, "scope unclear" facts, weekday mismatches, lines withheld)
Pages cite your files by name and line. I kept no copies, so check those lines in your original.

## Not carried
- <item>: why (credential, hook, schedule, history, config, identity, unreadable)

## Not read
- <path> (<size>)  [<label>] [credential-like (content)]
Files not on the allowlist (other notes folders, CSVs) weren't imported. Drop any one on its own and ask, and I'll import it.

## Secrets
<n> values were hidden from the model provider in <m> files; PROVENANCE.md lists the lines, without the values.
<k> more were found in files that were scanned but not read: <paths>.
<d> lines were left out of the pages because they looked like secrets: <file:line, ...>. Check those lines in your original.
<what it was>: seen in this conversation; it stays in this agent's history, so rotate it.
Your agent's files were sent to the model provider to be read. The scrubber can miss a secret written as an ordinary sentence.
(No-code path: I read your files directly, so any secret in them may be in my conversation history.)

## Personal data
This import carried <emails, phone numbers, chat ids, client contacts, ...> into <pages>. They are now stored in this agent. Tell me if any should go.

## Waiting on you
1. Defaults I took: <question → default>, including reading after the notice (<you said go ahead | default>)
2. <soul.draft.md, instructions.proposed.md, whichever exist>: approve, edit, or reject each
3. always.candidates.md: accept each line or not
4. skills: approve each to install: <names>; duplicates staged, neither approved: <pairs, which looks newer>
5. timers.proposed.md: create any you want; pick one where marked
6. config.proposal.md: name, icon, avatar, MCP servers to install, identity entries to set
7. Owner: <name> in <source> doesn't match your name (importer: I don't know your name), so mind/user-<source>.md is separate. Tell me if that's you.
8. Facts that disagree: <fact: value (cite) | value (cite)>. Tell me which is right.
9. Conflicts with <other source>: pick one of each pair in always.candidates.md and timers.proposed.md. The soul drafts stay separate.
10. The files you dropped: <step 14's sentence>

## Clean up
- <step 14's result>
- Keep your original files. My pages cite them by name and line.

## Continuity
I have the files, not the conversations. I don't remember anything the source agent was told outside them.
```

## 14. Hand over (importer) or remove the drop (in place)

### Importer: hand over

After every page and the report are written:
1. In one `sys_code` call, `fs_list` `import-review/<source>/` and return the paths to send: `REPORT.md`, `PROVENANCE.md`, `manifest.md`, drafts, staged skills, `mind/` pages, and `assets/`. Never send `notes/` (working files), `held.json`, `risk.json`, or anything under the drop folder. Check that no path is under the drop.
2. `msg_send` to the home agent with its bare handle as `recipient` (no address; the runtime resolves a local handle), those paths as `attachments`, and a short message: the source, the counts, "Pages only. The notes stayed in <importer name>.", and the attached paths, one per line in attachment order. The home agent needs that list: attachments arrive flattened by file name. If the send fails, say so to the owner and stop. Don't retry with the drop.
3. Tell the owner: "I sent <n> pages to <home agent>. Now delete me. My file still holds a copy of your agent's files. Delete <this importer's name> from the list on the left in Studio, and press Delete when it asks. That removes its file (usually in the same folder as <home agent>'s) from this computer. A copy of the importer you exported, shared, or backed up still holds them. Keep your original files, since the pages cite them by name and line."

Don't delete the drop here. The whole importer goes. The report's Clean up says: "The importer, <name>, holds a copy of your agent's files. Delete <name> from the list on the left in Studio, and press Delete when it asks. That removes its file (usually in the same folder as <home agent>'s) from this computer. A copy of the importer you exported, shared, or backed up still holds them." Leave out Waiting on you item 10.

### In place: remove the drop (code)

The last step, after every page and the report are written. In one `sys_code` call:
1. If the owner said no in step 7, delete nothing. If `fs_delete` is missing, delete nothing.
2. Read the config with `adf.sys_get_config({})`. If `context.audit.files` or the legacy `audit.files` is true, delete nothing: with file auditing on, deleting a file archives its whole content into the agent's history. If the config can't be read, delete nothing.
3. Otherwise `fs_list` each drop folder, `fs_delete` every file in it (SKIP and credential-like ones too), then `fs_list` again. Return only the counts deleted and left, and the paths left.

Fill in the report's Clean up and Waiting on you item 10 with one plain sentence:
- Deleted, none left: Clean up says "I removed the files you dropped from this agent's file list. Traces of them can stay inside the agent file, so don't share this agent with anyone you wouldn't show those files to." Drop item 10.
- No `fs_delete`, or the owner said no: "Delete the folder <drop folder> in Studio's Files panel."
- Auditing on: "I didn't delete the files you dropped, because file auditing is on in this agent's settings and deleting them would copy your agent's files into its history."
- Config unreadable: "I didn't delete the files you dropped, because I couldn't check whether file auditing is on, and if it is, deleting them would copy your agent's files into this agent's history."
- Some left: "These dropped files are still here; delete them in Studio's Files panel: <paths>."

Never call the notes deleted for good, gone, or unrecoverable. Then send the owner a short message: counts, decisions waiting, credential warnings, and that sentence.

## Failure behavior

- A file fails to read or parse, or its `model_invoke` call fails twice: list it under Not carried with the error type and line; continue.
- A skill can't be mapped (unknown toolset, host-only binary with no compute): stage it with the flag and keep it off the approval list until the owner decides. If only one section can't be mapped, keep it on the list with that section flagged.

## Changelog
- 0.10.5 (Oct 28 2026): Review fixes against the ADF source. In place only on the owner's clear yes, including when `sys_create_adf` is off (it used to default to importing in place). The skill grants nothing and never turns tools on. Approval card wording: Approve for this one agent, Always approve not needed, Reject or Reject with feedback cancels. `sys_create_adf` `files` entries spelled out as `parent_path`/`child_path`. Handover: attachments arrive flattened under `imported/<importer handle>/`, so the message lists original paths in order and the home agent matches by position and refuses unknown attachments. A failed `model_invoke` or tool call logs up to 200 characters of its error. `fs_delete` isn't secure erase; file auditing is off by default; shared or exported copies keep audit history. Owner lines no longer promise that passwords don't come over or that the import is complete. Long-line guard for the 60 s code limit. Not yet run end to end with a real importer and `msg_send`.
- 0.10.4 (Oct 28 2026): Owner lines rewritten from a user's point of view: an opening line, a recommended option, where the settings are, the approval card explained, a file checklist, how to show hidden folders, a time estimate (10 to 20 minutes, from blind run 9).
- 0.10.3 (Oct 28 2026): Exact owner steps checked against Studio. Reject only cancels creating the importer, and the skill asks before importing in place. Studio's Delete removes the .adf from disk, but not exported or backed-up copies.
- 0.10.2 (Oct 28 2026): Review fixes to the owner lines. Untested: creating the importer with sys_create_adf and real files, and the msg_send handover.
- 0.10.1 (Oct 28 2026): Blind run 9 fixes. Importer: hub page only, no audit check, no notes/ in the handover. heldCheck() returns risk.json strings; scrub() catches a value that goes on below its marker; citeCheck() added. Identity facts that disagree are asked, never picked.
- 0.10.0 (Oct 28 2026): A throwaway importer holds the notes and hands over pages only. In place stays as the fallback.
- 0.9.0 (Oct 28 2026): No copies; drop removed after import, only with file auditing off. Scripts moved to scripts/.
- Before 0.9.0: fixes 1 to 8, unversioned.
