---
name: save-system-prompt
description: Save the runtime-provided part of your system prompt (the host's base prompt and tool-guidance sections) into your own files while you still run on that host, and optionally switch to that saved copy. Use before the agent file moves to another computer or runtime, or when the owner wants the agent's prompt pinned to the version it has now.
adf: ">=0.2"
requires:
  tools: [sys_lambda, db_query, fs_read, fs_write, sys_get_config, sys_update_config]---

# Save System Prompt

Part of your system prompt is not in your file. The base prompt and the
tool-guidance sections (skills, database, serving, and so on) come from the
runtime you are running on. If your file moves to another runtime, you get that
runtime's version of them.

The runtime records the full system prompt you received in `adf_loop`, as a
`[Context: system_prompt]` entry, each time it changes. This skill copies the
runtime-provided part of that record into `prompts/runtime.md`. Run it on the
host whose prompt you want to keep. It cannot recover a prompt after the file
has left that host.

`scripts/save-system-prompt.js` does the work. Copying the text by hand is
NOT RECOMMENDED: the prompt is long, and a model transcription is not exact.

## Save

```js
sys_lambda({ source: 'skills/save-system-prompt/scripts/save-system-prompt.js:save' })
```

Optional args: `path` (default `prompts/runtime.md`), `loop` (default `main`).

The lambda reads the newest `system_prompt` entry and keeps the text before
your own instructions. It also turns every file the runtime pasted in back into
its placeholder, for example the contents of `mind.md` back into `{{mind.md}}`,
so the saved copy keeps loading the current file. It changes no configuration.

```jsonc
{ "ok": true, "path": "prompts/runtime.md", "from_seq": 812, "recorded_at": 1763700000000,
  "chars": 14210, "placeholders": ["soul.md", "mind.md", "skills-registry.json"] }
```

| `reason` | Meaning |
|----------|---------|
| `no_recorded_prompt` | No entry for that loop yet. The runtime records one on the turn after the prompt changes. Try again on a later turn. |
| `no_runtime_part` | `include_base_prompt` is off or `bare_prompt` is on. Nothing to save. |

Saving alone changes nothing about how you run. Tell your principal where the
copy is.

## Apply (optional)

Apply makes the saved copy your prompt on every runtime. Do it only when your
principal asks for it.

```js
sys_lambda({ source: 'skills/save-system-prompt/scripts/save-system-prompt.js:apply' })
```

It sets `instructions` to the saved text, a `---` separator, and your current
instructions. The change goes through `sys_update_config`, so it needs whatever
approval your configuration requires.

Apply does NOT change the prompt mode. The mode is your principal's setting,
and you MUST NOT change it yourself. When the result has an `owner_action`,
tell your principal exactly what to switch:

- **Mode "Full"** (the default): ask them to set the Instructions mode to
  **"No base prompt"** (`include_base_prompt: false` in the config). Until they
  do, the runtime prompt is in your prompt twice: once from the runtime and
  once from the saved copy.
- **Mode "Agent Instructions only"** (`bare_prompt: true`): ask them to change
  it to **"No base prompt"**. That mode also drops your name, model and loop
  blocks, which the saved copy does not contain.
- **Mode "No base prompt"** already: `owner_action` is `null`. Nothing to ask.

In Studio the mode is the select at the top of the agent's Instructions
section. Other clients set `include_base_prompt` and `bare_prompt` directly.

The text goes into `instructions` itself, not behind a
`{{prompts/runtime.md}}` placeholder, for two reasons. Text pulled in from a
file is wrapped as file data, not instructions. And text from a file is not
scanned again for placeholders, so `{{mind.md}}` inside it would never load.

After apply:

- The tool-guidance sections stay as they were saved. If a tool is enabled or
  disabled later, its section is not added or removed. Revert, save, and apply
  again after changing tools.
- Your name, model, loops and other runtime blocks after your instructions are
  still generated from your configuration. `include_base_prompt` does not
  control them.
- The saved text appears under the `## Agent-Specific Instructions` heading.

## Revert

```js
sys_lambda({ source: 'skills/save-system-prompt/scripts/save-system-prompt.js:revert' })
```

Revert removes the saved text from the start of `instructions`. It refuses
when `instructions` does not start with the saved text, for example after
`prompts/runtime.md` was edited; remove the text by hand in that case. Then
relay its `owner_action`: ask your principal to set the mode back to **"Full"**,
or you run with neither copy of the runtime prompt.
