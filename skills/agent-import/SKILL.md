---
name: agent-import
description: Bring an OpenClaw workspace, a Hermes profile, or a ChatGPT or Claude chat-history export into this ADF agent when the owner asks to import, migrate, "become" it, or remember it. For OpenClaw and Hermes, a throwaway importer agent reads the owner's notes and sends back only generated pages (mind pages, plus persona, rule, and skill drafts for the owner to approve), so the notes stay out of this agent. Importing in place, without copies, happens only if the owner explicitly agrees.
adf: ">=0.8"
requires:
  tools: [fs_read, fs_write, fs_list, sys_code, msg_send]
  optional: [sys_create_adf, fs_delete, sys_get_config]
version: 0.12.0
---

# Import an OpenClaw or Hermes agent

> **Review candidate, not for general use yet.** The separate-importer path (creating the importer with `sys_create_adf`, the owner's approval card, and the real `msg_send` handover) has not been run end to end by an owner. Tests so far used an inner-loop handover instead of `msg_send`.

A ChatGPT or Claude chat-history export is different: follow "Chat-history exports" below, not steps 0 to 14.

You turn a folder of the owner's notes into generated pages: mind pages, drafts for review, and staged skills. No copy of the owner's notes is written into the owner's agent, redacted or not. You never read the owner's machine.

This skill grants nothing. It never turns on a tool, approves its own calls, authorizes code, or changes config. Where it needs a tool that is off, it tells the owner where the setting is and waits; the owner decides.

## 0. Where the import runs

Deleting a file doesn't erase it from an agent file, so the notes are kept out of the owner's agent from the start. Two roles:
- **Home agent**: the owner's agent, the one that has this skill installed. It never receives the drop.
- **Importer**: a throwaway agent the home agent creates for this import. The owner drops the notes there. It runs steps 1 to 13 and hands the pages to the home agent (step 14). Then the home agent confirms complete receipt and placement before the owner deletes it.

fs_read skills/agent-import/references/where-it-runs.md now.

## Hard rules

1. Never `fs_read` under the drop folder unless the owner accepted the no-code path (step 1). Code reads it (steps 4, 6, 8 to 12, 14). `fs_list` metadata is fine. For complete inventories in code, use `adf.fs_list({ prefix: folder + "/", _full: true })` with a slash-terminated folder prefix; ordinary listings stop at 500 files. Return only the metadata the step needs.
2. Never write a dropped file, or a part of one, into this agent: no copies, no excerpts, no folder of them (the runtime's own `imported/<sender>/` folder for message attachments holds only the generated pages step 14 sends). Only generated pages, and each one passes `pageFilter()` (steps 9, 10, 12). Pages cite the drop by file and line: (MEMORY.md:12 in the drop).
3. Code returns or prints only paths, sizes, counts, line numbers, cites, booleans, labels, and headings it wrote. Never file text, matched values, model replies, or error messages. Raw source text never goes into `sys_code` source either. On an error, return `e.name` and the line (`e.linePos` or `e.mark.line`): messages quote the file, and provider errors can echo the prompt.
4. Never write `soul.md`, `instructions`, or any `## Always` line, or install a converted skill into `skills/`, until the owner approves that exact text or skill. Drafts and staged skills go in `import-review/<source>/`.
5. Credentials, tokens, hooks, permissions, approval settings, schedules, model settings, and identity keys never carry.
6. A converted skill's `requires` is a checklist, never a grant. Do not enable tools, install MCP servers, authorize code, or change config, for a skill or for this import.
7. Deleting the importer removes its file from this computer, not exported, shared, or backed-up copies. Never say it erases every copy. `fs_delete` is not a secure erase: removing the drop takes it off the file list, but traces can stay inside the agent file, and with file auditing on (`context.audit.files`, off by default) deleting a file archives its content in the agent's history. Shared or exported copies of an agent keep that history. Never say or imply that the notes are gone from it, or that removed content can't be recovered.
8. Do not claim continuity. You have the files, not the conversations.
9. Never promise a lossless import, a secret-free result, secure erasure, or that the scrubber caught every secret. It is a heuristic; say so when it matters.

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
- `pageFilter(page, risk, mark)` is the last gate on a generated page. With its cites taken out, a line goes if it trips `scrub()` or `unsafe()`, or if it cites a line in `risk` (a Set or the risk.json array) and holds any risky token (a year alone passes). It returns the page and the dropped lines with their cites. With `mark` (`S.withheldMark`, for staged skills) the line becomes `[withheld: check your original, (<cite> in the drop)]` instead. Placeholders like `<MAPBOX_TOKEN>` pass.
- `citeCheck(page, read, root)` returns the page's cites that point at no file, past its end, or at a blank line, and rejects invalid ranges. Cites must use positive safe integer line numbers and span at most 21 lines; split longer references. Use `(full relative path:line in the drop)` on pages, including paths with spaces, Unicode, or parentheses, and the bare `full relative path:line` in extraction JSON. Citation paths are checked for credentials before exclusion from the page scan; unsafe paths are omitted from reports and withheld markers. All citation helpers share that decoding; `pageFilter()` withholds lines with invalid ranges or ambiguous citation parentheses. For a source filename with unbalanced parentheses, flag the citation and ask the owner to rename the source before retrying; never silently use a filename suffix.
- `flagged(text)` counts lines with broad secret words (step 6). `asText(f)` gives text from an `fs_read` record (base64 for a non-text mime type, like a `.bak`), or null for a binary. `reply(r)` turns a `model_invoke` reply into JSON.

Residual risk: a secret written as an ordinary sentence, with no secret word, prefix, or telltale shape, reaches the model provider and could reach a page. The extraction prompt and the filters keep most of it out. Step 6 tells the owner first.

## Chat-history exports

A ChatGPT export (`conversations.json` whose conversations hold a `mapping` of messages) or Claude's export (`conversations.json` with `chat_messages`), shared so you remember it, needs no importer: attaching it in chat already put it in this agent's files. Steps 0 to 14 don't apply. Parse it in code, write mind pages from what the owner said, dated by conversation, and leave credentials out (hard rule 5). Then:
- Never store an inference as a fact (a surname taken from an email address, a home guessed from a question). Mark it `(inferred from <what>)`, or ask. An identity fact (name, partner, children, home) the export doesn't state: never pick, ask.
- Also keep advice from the assistant's replies that the owner acted on or asked to keep, marked as the assistant's and cited by conversation, so removing the export doesn't lose it.
- When the pages are written, tell the owner what they leave out (the assistant's replies you didn't keep, anything you didn't carry). If the owner asked you to remove the export and still wants that, remove it with `fs_delete`; else offer to. Say what removal does and doesn't do in hard rule 7's words, and that what you read from it stays in your conversation history: `fs_delete` is not a secure erase.

## Questions and defaults

Every question has a default. Ask, wait, and take the default for anything unanswered, or for everything if the owner says go ahead. Defaults taken go under Waiting on you.

## 1. Preflight

If `fs_read`, `fs_write`, or `fs_list` is missing, say which and stop. `fs_delete` and `sys_get_config` are used only in step 14; note whether each is there.

Code keeps the drop out of the transcript. If `sys_code` is off, or `adf.model_invoke` fails inside it, don't enable anything. Tell the owner:

> I can't process your files in code here, so I'd have to read them directly. Any password or token in them would be saved in this agent's conversation history. I recommend you turn on code first: in Studio, open me, click Config in the right-hand panel, and turn on sys_code in the Tools section (and model_invoke under Code Execution, if it's off). Or should I continue anyway?

Continue only on a clear yes. Then read the files yourself and write the pages from them, leaving out anything that looks like a password, code, or key. Treat `config.yaml` and `cron/jobs.json` as SKIP, label SKIP files "not scanned", and say in the report that secrets may be in the transcript. Still write no copies.

With code, load the scripts and run the self-test first. If it fails, stop and tell the owner. In place, also check file auditing now (step 14's check), so the step 6 notice is accurate. The importer skips it.

fs_read skills/agent-import/references/hand-over.md now.

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
- **asset**: `asText()` returns null. Keep it in the drop and mark it SKIP, even when `IDENTITY.md` or a skill references it. Record the reference as a resource the owner must supply separately; do not stage or attach its bytes. Binary files may contain private data or metadata that the text filters cannot inspect.
- **not on allowlist**: the rest, like `BOOTSTRAP.md` or Hermes `skills/<category>/DESCRIPTION.md`.

Content scan: run `scrub()` on every text file except credential-like (name) ones, in line ranges if a read truncates. `scrub()` slows sharply on very long lines (tens of seconds for one line of 60 KB or more), and a call stops at 60 s: check line lengths first, and label a file with any line over 10,000 characters **long line**. It was inspected for line lengths but is not scrubbed or sent to the model (SKIP; Not imported). If a call times out, split the scan into smaller calls rather than skipping the check. Any hit in a SKIP file, `maybe` included, adds **credential-like (content)** and its hit count. Note empty files and files over 60 KB (**large**). For each near-duplicate, return the line numbers of ALLOW lines naming it and how many lines differ from the original.

Code writes `import-review/<source>/manifest.md`: `D` and how it was found, an ALLOW table (path, size, empty, large, scrubber hits), and a SKIP table (path, size, label, scanned in code or not scanned, credential-like (content), hits). Scanning reads content inside code; describe these files as not imported, not unread. It returns paths, labels, sizes, and counts, and writes nothing else from the drop.

## 5. Provenance (code)

The same call writes `import-review/<source>/PROVENANCE.md`: source system, drop folder, `D`, profile, import date (UTC), and per ALLOW file its path, size, and the line numbers and kinds of scrubber hits, never the values. Those values are hidden from the model provider too, since step 9 sends scrubbed text. It says no copies were kept, that pages cite the drop by file and line, and that after step 14 the owner's original is where those lines live. Steps 9, 10, and 12 add a "Withheld from pages" section: source file and line, never text.

## 6. Tell the owner before reading

In one `sys_code` call, run `flagged()` on every ALLOW text file (`cron/jobs.json` yes, `config.yaml` no) and return the count per source and the total. It's broad; most hits are harmless. Send the owner this, plus a last sentence if the total is above zero ("<n> lines in your agent's files mention words like password, code, or key", per source when there are several):

Importer version:

> Next I'll read your agent's files. They're sent to the AI model provider to be read. Only the pages I write from them go to <home agent>, and I remove anything in those pages that looks like a password or key. That filter is a heuristic and can miss a secret written as an ordinary sentence. When I'm done, the home agent checks the handover and tells you when to delete me. My file holds a copy of your agent's files until you do.

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

Write `import-review/<source>/config.proposal.md`, a Field | Proposed | Source table: name, emoji, avatar (its original reference, marked "owner must supply separately"), model (suggestion only), MCP server names, identity entries skills or notes need (names only, UPPER_SNAKE: the source's env var name, else service and kind, like `ROTA_LOGIN`; guessed names marked inferred), and channels (Hermes `platforms`, cron delivery kinds, channels the notes mention). Steps 9 to 11 fill it in; nothing is applied.

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

If `conventional-skill-to-adf` is installed, reuse its mapping and fidelity guidance only; its instructions to write into `skills/` do not apply during import. In every case, follow the staging, filtering, and approval steps below, reading the drop only in code through `model_invoke`. Use one `sys_code` call per skill (each `model_invoke` takes 25–30 s and a call stops at 60 s, so two skills in one call time out). It reads the skill and its allowed linked text files from the drop as conversion context, scrubs them, and sends `model_invoke` this step's list and table (loaded from this file in code) with them, asking for the staged `SKILL.md`. A staged skill is a generated page: code runs the reply through `pageFilter(text, risk, S.withheldMark)`, which turns each risky line into `[withheld: check your original, (<cite> in the drop)]` with its indentation kept, and adds "Withheld in code: line <n>, check your original" to `## Conversion notes` (replacing any "Withheld: none"). `pageFilter()` lets item 5's placeholders through. Stage only the generated `SKILL.md`, never source text resources or binary assets. List every referenced resource as missing from this package, with its relative path and purpose; the owner can inspect and supply it separately before installation. Keep the skill off the approval list while a required resource is missing. Code writes `import-review/<source>/skills/<name>/` and returns counts and paths. Send the model numbered lines so its cites are real. Then `fs_read` the staged `SKILL.md` and check it against the list. Run `citeCheck()` on it in code, and find any cite you add by searching the scrubbed source in code, returning line numbers only.

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

Schedules a skill states ("every Monday") also go to step 11. Install into `skills/<name>/` only after approval: separately supplied and approved resources first, generated `SKILL.md` last.

## 11. Schedules

Create no timers. Write `import-review/<source>/timers.proposed.md`, one row per job: name, schedule as written and in plain words, what it did, enabled or paused, source file and line, and the ADF timer to create. Take them from the notes pages' schedules: `cron/jobs.json`, OpenClaw `HEARTBEAT.md` and `AGENTS.md` schedule sections, and recurring phrasing ("every evening", "daily at 21:00", cron expressions).

When two places in one source give different times, propose the newer and note both. Newer means, in order: a date beside the entry; a dated file; a marker ("copy, editing this one", "updated", "final"); modification time from `fs_list`. If none separates them, list both, marked "pick one". Dates that disagree across a source (jobs a year older than the notes) stay as written, flagged. With no OpenClaw `cron/jobs.json`, ask the owner to paste `openclaw cron list`. Default: none.

Check each cron expression in code, source and proposed; flag one that never fires in a month it names (`0 9 31 1,4,7,10 *` skips April). Cron ORs day-of-month and day-of-week, so "second Sunday" is a weekly timer that checks in its prompt. Use the job's timezone, else the config's, else one the notes imply (marked inferred, and ask), and say which.

## 12. Filter every page (code)

Before the report, one `sys_code` call per source loads `S` and `risk.json` and runs `pageFilter()` over every page this import wrote: everything in `import-review/<source>/` except `manifest.md`, `PROVENANCE.md`, `held.json`, and `risk.json`, plus the mind pages the hub lists. Staged skills use `S.withheldMark`. In a page that existed before the import, check only lines citing the drop. Write back changed pages, add the dropped lines to PROVENANCE by source file and line, and return counts and cites only.

## 13. Report

Write `import-review/<source>/REPORT.md` from this template, copying Not imported from `manifest.md` in code. Number Waiting on you consecutively, only items that apply.

fs_read skills/agent-import/references/report-template.md now.

## 14. Hand over (importer) or remove the drop (in place)

fs_read skills/agent-import/references/hand-over.md now.

## Failure behavior

- A file fails to read or parse, or its `model_invoke` call fails twice: list it under Not carried with the error type and line; continue.
- A skill can't be mapped (unknown toolset, host-only binary with no compute): stage it with the flag and keep it off the approval list until the owner decides. If only one section can't be mapped, keep it on the list with that section flagged.
