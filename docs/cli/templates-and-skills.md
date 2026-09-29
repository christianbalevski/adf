# Templates and skills

## Templates

New agents start from a template: instructions, config, tools and seed
files. `/templates` (palette "Agent templates") manages them, as in Studio's
Settings › Agent templates. Shipped templates come first, then yours, tagged
default, shipped, not reviewed or has run.

| Key | Action |
|---|---|
| `Enter` | Details: model, tools, compute, instructions, files |
| `n` | New template |
| `u` | Duplicate |
| `m` | Rename |
| `t` | Notes: description and warning |
| `s` | Make it the default |
| `a` | Review someone else's template (`Enter` claims it; a password is asked when the file has one) |
| `x` | Reset a shipped template (asks) |
| `d` | Delete one of yours (asks; the file moves to the daemon's `templates-trash` folder) |

In details, `e` edits the instructions and `c` the config in your external
editor (schema-checked, changed keys shown); `f` lists the seed files
(`Enter` edits one, `d` removes an extra file). Templates need the owner
identity: when it is locked or missing, `i` opens the identity dialog.
Revealing the folder and adding files from disk are Studio only.

One-shot:

```bash
adf templates                               # id, name, default, model, about
adf new agent-2 --template <id> --start
```

## Skills

Skills are packages of instructions (`skills/<name>/SKILL.md`) the agent can
read when relevant. `/skills` lists the selected agent's skills, as in
Studio's Skills panel: name, description, `~N tok` (what reading its
SKILL.md costs) and whether it is muted. The header shows what the catalog
costs in the prompt.

| Key | Action |
|---|---|
| `Enter` | Preview SKILL.md |
| `Space` | Mute / unmute (a muted skill's description leaves the prompt) |
| `e` | Edit SKILL.md in your external editor |
| `d` | Remove `skills/<name>/` (asks) |
| `a` | Add |
| `r` | Refresh |

Add from the catalog (the sources set in Studio Settings › Skills, or the
first-party registry), a URL or disk:

```text
/skills add                                  # browse the catalog; Enter previews, Enter installs
/skills add <name>                           # jump to a catalog entry
/skills add https://example.com/registry.json
/skills add https://example.com/SKILL.md
/skills add ./my-skill                       # a folder, or ./SKILL.md
/skills mute|unmute|remove <name>
/skills sources [add|remove <https-url>]     # shared with Studio
```

Skills are instructions, never authority: installing one writes files under
`skills/<name>/` and grants no tools, files or approvals.
