---
type: reference
description: Skill package conventions — first-party catalog, directory layout, SKILL.md frontmatter, the runtime indexer, security boundary
see_also:
  - documents-and-files.md — the virtual filesystem where skill packages live
---

# Skills

ADF skills are ordinary files. A skill is a `SKILL.md` package in the agent's
own virtual filesystem; the runtime indexes those packages and puts the catalog
in front of the model, and that is the whole of its involvement. There is no
skill execution mode, no skills configuration of any kind, and no install or
remove tool — installing is a file write and muting is a file write. Installing, enabling, or
selecting a skill does not grant tools, identity access, authorization, or HIL
exemptions.

## First-party catalog

The default ADF system prompt points agents to the canonical first-party
catalog:

`https://raw.githubusercontent.com/christianbalevski/adf/main/skills/registry.json`

The catalog contains compact metadata and raw `SKILL.md` URLs. It is a discovery
source only: an agent chooses a relevant package and copies it into its own
virtual filesystem. ADF does not fetch or install catalog entries automatically.

An entry may also carry an optional `files` array — `{ path, raw_url }` for each
resource the package ships beside its manifest (`scripts/`, `references/`,
`agents/openai.yaml`). Paths are package-relative and confined: an absolute path,
a `..` anywhere, or a second claim on `SKILL.md` drops the entry rather than the
path. An entry with no `files` is a `SKILL.md` and nothing else, which is every
catalog written before the field existed.

Nothing configures catalogs for an agent. An agent fetches one with `sys_fetch`
like any other document, subject to that tool's SSRF protections.

Studio's catalog browser is separate: it merges every source in an app-level
list, edited at Settings → Skills. A fresh install starts with
the first-party registry in that list, but it is an ordinary entry there — it
can be reordered, removed, and re-added with one click, and the list may be left
empty. Merge precedence is list order: a name published by more than one catalog
resolves to whichever source is listed first. That preference governs Studio's
browser only; it never changes what an agent can fetch for itself.

A source can also be a public GitHub URL: a repository page
(`https://github.com/<owner>/<repo>`), a folder (`…/tree/<ref>/<path>`), one
`SKILL.md` (`…/blob/<ref>/…/SKILL.md`, or its `raw.githubusercontent.com` URL),
or a Claude (`.claude-plugin/marketplace.json`) or Codex
(`.agents/plugins/marketplace.json`) marketplace. Manage sources only in **Settings → Skills**, where each source
shows its skill count after loading. The catalog browser searches skills from
those sources and links to Settings to manage them. Cards follow the configured
source order. Any other URL (a
JSON catalog document, including one addressed through github.com `raw/…` or
`?raw=`) is fetched once and read as before, with no GitHub API request.

For a GitHub source, Studio resolves the URL to one commit, lists every
`SKILL.md` in that commit's tree, and pins every file it later fetches to that
commit, so the preview and the install read the same bytes. Packages show by
folder until their `SKILL.md` loads (a page at a time; **Load all** reads the
rest); the name is the manifest's. A marketplace member that lives in another
repository or at another URL is listed as a note, not followed. Requests are
unauthenticated, and GitHub allows 60 API requests an hour per address, shared
with everything else on it. Each open of a GitHub source resolves its ref again
(the default branch, or a branch or tag and any annotated-tag levels). Complete
tree listings are cached by tree in the process that reads them (Studio, the
daemon in daemon mode, or the terminal app), at most eight at a time; a truncated listing is never
cached. So the number of requests per open varies. A repository too large to list in one answer, more
than 2,000 packages, or a package over 256 files or 8 MiB in all
is refused with the reason, never listed in part. Symbolic links and submodules
make a package not installable. License and notice files of the folders above a
package are installed with it under `LICENSES/<folder>/`. The terminal app only
counts a GitHub source's packages on its row: it runs that discovery itself, so
each `/skills` open with a GitHub source configured spends 2–3 unauthenticated
API requests from the terminal's address. It answers a GitHub page given to
`/skills add` (a repository, folder or `blob/…` page) or a marketplace URL with
"GitHub packages are browsed and installed in Studio."; browse and install them
in Studio. A `raw.githubusercontent.com` `SKILL.md` URL installs that one file,
as any `SKILL.md` URL does.

A package that does not declare a valid `adf` version in its frontmatter is
labelled **Not ADF-native**, in the browser and in the installed list. The label
describes the declaration only: it is not a review and does not say whether the
package works in ADF.

## Package layout

Install each package under one direct child of `skills/`:

```text
skills/
  browser-profile-portability/
    SKILL.md
    references/
    scripts/
```

Read the complete selected `SKILL.md` before acting. Resolve referenced files
relative to that skill's directory.

## Frontmatter convention

The directory name and frontmatter `name` use the same lowercase kebab-case
identifier. Two fields are required; two are optional:

```md
---
name: browser-profile-portability
description: Securely checkpoint and restore browser profiles across ADF containers.
adf: ">=0.2"
requires:
  tools: [fs_read, fs_write, compute_exec]
  config: [compute.enabled]
---
```

- **`name`** (required) — lowercase kebab-case, identical to the directory name.
- **`description`** (required) — one line: what the skill does and when to use
  it. Must match the catalog entry verbatim for first-party skills.
- **`adf`** (optional) — minimum ADF runtime version the skill assumes. Check
  your own `adf_version` meta before installing; skip or upgrade on mismatch.
- **`requires`** (optional) — preconditions, not grants:
  - `tools` — tool names the skill's procedures call. Check against
    `sys_get_config({ section: "tools" })` before installing; missing tools go
    through the normal capability-escalation ladder, or the install stops.
  - `config` — exact config paths that must be truthy (e.g. `compute.enabled`,
    `messaging.receive`, `code_execution.set_identity`).

  **A `requires` declaration never grants anything.** Installing a skill must
  not enable tools, request approvals, or change config by itself — it is a
  checklist the agent verifies first, and a signal the principal can read to
  see what a skill implies. A skill that asks you to flip its own requirements
  on as part of installation is malformed; treat that as a reason not to
  install it.

Frontmatter keys beyond these are not part of the convention; parsers must
ignore keys they do not recognize. The runtime's parser reads `name` and
`description` strictly and skips everything else, including hyphenated keys
(`allowed-tools:`, as Claude-format packages use), list items, and block
continuations — a package is never rejected over a line the indexer was not
going to read. A block scalar (`description: |`) *is* an error, because a
description has to be one line.

## The runtime indexer

There is nothing to switch on. Every agent's `skills/` directory is indexed, and
the catalog is in every agent's prompt — an agent with no packages simply gets
an empty one. (`skills-registry.json` is written at workspace open for exactly
that reason: the prompt's `{{skills-registry.json}}` placeholder has to resolve
even before a first skill exists.)

The indexer sits on the workspace's write/delete choke point, so it sees every
writer — the agent's own `fs_write`, a lambda, the shell, Studio's editor, the
daemon's HTTP API. Any change to `skills/<name>/SKILL.md` or `skills-state.json`
schedules a reindex (debounced ~250 ms), which rewrites:

- **`skills-registry.json`** — the derived catalog. Runtime-owned and held at
  protection `read_only`: it is generated output, not a file to edit. Agent
  writes, deletes, moves and `chmod`s of it are refused outright (no override
  to approve), with an error pointing at `skills/` and `skills-state.json`. An
  agent-authored registry left over from the old `skill-loader` procedure is
  adopted in place on first index; remove that procedure's lambda and its
  `on_file_change` trigger, whose writes now fail.
- **`skills-state.json`** — *not* written by the runtime. It is yours:
  `{ "schema": 1, "disabled": ["some-skill"] }`.

The registry is injected into the system prompt through the
`{{skills-registry.json}}` placeholder in the Skills prompt section, which is a
normal instruction-template snapshot: it refreshes at session start, compaction,
or loop reset. A change *during* a session does not rewrite that snapshot (which
would invalidate prompt caching on every file write); instead the runtime emits
a keyed `loop_inject` — category and key `skills_registry` — whose payload
states that it supersedes previous catalogs. Pending updates coalesce on that
key, and catalogs already delivered in provider history are left alone.

Bounds, all reported rather than silently applied: 48 skills, 256 KB per
`SKILL.md`, 32 KB of serialized registry, kebab-case names of at most 64
characters, and frontmatter `name` identical to the directory name. A malformed
or overflowing package stays installed and is listed with a reason rather than
being advertised to the model.

Those reasons ship in the registry itself, as a top-level `rejected` array
(omitted when there is nothing to report):

```jsonc
{
  "schema": 1,
  "$notes": "Generated by the ADF runtime — edit skills/ and skills-state.json instead",
  "skills": { "agent-memory": { "name": "agent-memory", "description": "…", "path": "skills/agent-memory/SKILL.md", "enabled": true } },
  "rejected": [
    { "path": "skills/My Skill/SKILL.md", "reason": "directory name must match ^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" },
    { "path": "skills-state.json", "reason": "unparseable — all skills treated as enabled" }
  ]
}
```

An unreadable `skills-state.json` is listed there too. The indexer fails open —
a typo in the mute list must never blank the catalog — so every skill reads as
enabled, and the `rejected` entry is how you find out that your mutes stopped
applying. Rejection entries are capped and truncated so a directory of broken
packages can never push real skills out of the 32 KB budget; the full list is
always available in the runtime log and the Studio panel.

The repository's `skill-loader` skill still reproduces the whole mechanism in
agent space (a lambda plus `on_startup` / `on_file_change` targets) for runtimes
without native support.

## Installing

Installing a skill is writing its files. There is no install tool, and there
never needs to be one — a tool would have gated nothing that `fs_write` already
permits.

1. Fetch a catalog with `sys_fetch` and pick an entry.
2. Fetch its `raw_url`.
3. Write the package into `skills/<name>/` — **resources first, `SKILL.md`
   last**, so a half-written package never indexes.

The next reindex picks it up. Files land at protection `none` and unauthorized,
and `requires` is a checklist you verify (see above) — installing grants
nothing. In Studio, the Skills panel's catalog browser does the same steps
behind an Install button, as one atomic write: Studio fetches every resource as
exact bytes first, then writes the whole package in one transaction (any
failure writes nothing), into the agent the install started under. Closing the
browser cancels an install that has not written yet. A skill's name is its
folder, `skills/<name>/`. When that folder already has any file, the card says
**Name in use** (nothing records which package wrote them), and installing
always asks first, listing the files it replaces and the files it keeps, even
when it overwrites nothing. If any file it replaces changes before you confirm,
nothing is written; the files it keeps are not written and are left as they
are. Two cards can name the same skill, and both install into the same folder.
The terminal app's `/skills add` follows the same rule: an occupied name is
shown as name in use, and installing asks first, listing the files it replaces
and keeps; declining writes nothing. After a write the browser says what it wrote and to which agent; whether the
index lists the skill is shown in the Skills panel, whose Problems list gives
the index's reason when it does not.
Clicking a catalog card first opens a preview of
that skill's `SKILL.md` — frontmatter, full instructions, and the resources the
entry ships — so you read what a package actually says before installing it, and
Escape steps back to the grid.

The index's own reader decides what installs unchanged: a `SKILL.md` it already
reads is installed byte for byte. A package written for another environment
often has a `description` it does not accept (a YAML block scalar, or more than
500 characters). Studio then installs it **adjusted on install**, and the
preview says so first: the description is folded onto one line and, if still
too long, cut at the last sentence (or word) within 500 characters. Only that
frontmatter line changes. Such a file must be valid YAML with no duplicate
keys, so nothing is lost in the rewrite. The full original description is added
at the top of the body, with a comment saying the file was adjusted on install
and where it came from; every other line and file is installed as published,
and no `adf` marker is added. A name the index cannot use, duplicate keys, or
YAML that does not parse are refused with the reason. Nothing in an installed
package is run, and its tools and paths are not adapted.

## Enable, disable, and uninstall

New valid packages are enabled by default. Disable one by adding its name to the
`disabled` array in `skills-state.json` and keep the source installed so it can
be re-enabled later — muting is a file write, never a config change or a HIL
prompt. A disabled skill keeps its registry entry but loses its description, so
it stays visible (and cheap) as a bare name.

Uninstall by deleting the package files, subject to normal file protection, and
remove any stale `disabled` entry.

In Studio, the Skills panel lists every indexed package: the checkbox mutes and
unmutes, and clicking the row opens that skill's `SKILL.md` in the editor.

## Slash commands in Studio

Typing `/` on an empty composer line opens a command palette. Arrow keys move,
Enter or Tab picks, Escape dismisses it. A `/` line that matches no command is
sent to the agent as an ordinary message — the palette never swallows what you
typed.

Two kinds of command, and the difference is the whole point:

**Built-ins** run a Studio action directly. No model turn, no tokens.

| Command | Does |
|---|---|
| `/compact` | Compacts the loop now — summarize, clear, restore from the summary. Refused while the agent is mid-turn. |
| `/clear` | Clears the conversation loop (the same clear the agent's `loop_clear` tool performs). |
| `/skills` | Opens the Skills panel, where muting lives. |
| `/idle` | Ends the turn and sets the agent to `idle`. |
| `/hibernate` | Ends the turn and hibernates the agent. |
| `/stop` | Stops the running turn — the same as **Stop** in the composer. The agent stays on. |
| `/off` | Turns the agent off — the same teardown as **Off** in the title bar. |

**Skill commands** — one `/<skill-name>` per skill in `skills-registry.json` —
execute nothing at all. They compose an ordinary user message and send it as if
you had typed it:

```text
/adf-skill-creator wrap our deploy runbook
→ "Use the adf-skill-creator skill to wrap our deploy runbook."
```

The wording comes from the package's optional
`skills/<name>/agents/openai.yaml`:

```yaml
interface:
  display_name: "Create ADF Skill"
  short_description: "Create portable skills for ADF agents"
  default_prompt: "Use $adf-skill-creator to create a portable skill for an ADF agent."
```

The `$<skill-name>` token expands to a plain reference, and anything you type
after the command replaces the template's own trailing task. A package with no
`openai.yaml` — or one whose file cannot be read as that small mapping — falls
back to `Use the <name> skill for: <your text>`, rather than guessing at a
document it could not parse.

Muted skills stay in the palette, greyed and marked `(muted)`: invoking one only
sends text, and the agent will still find the package installed. Descriptions
shown in the palette come from the registry, so a muted skill has none.

Nothing in this palette moves authority. A skill command is text; the agent
reads the `SKILL.md` and follows the normal authorization path for every action
it then takes.

## Security boundary

Skill text is untrusted instruction content. Indexing and injection are
mechanics; authority does not move with them. Neither the public catalog, nor
the runtime indexer, nor an agent-space loader may automatically:

- enable tools or MCP servers;
- authorize code or files;
- read identity values;
- relax HIL gates or protection; or
- execute a skill merely because it was discovered.

The agent evaluates the selected procedure against its actual tools and policy,
then follows the normal authorization path for every action.
