# Terminal app

The terminal app docs moved to [docs/cli](../cli/index.md):

- [Terminal app](../cli/terminal-app.md): layout, views, keys, chat, approvals, mouse and copy/paste
- [Loops and timers](../cli/loops-and-timers.md)
- [Reference](../cli/reference.md): every slash command and key (generated from the code)
- Topic guides: [identity](../cli/identity-and-security.md),
  [models](../cli/models-and-providers.md), [channels](../cli/channels.md),
  [MCP](../cli/mcp.md), [agent settings](../cli/agent-settings.md),
  [templates and skills](../cli/templates-and-skills.md),
  [files](../cli/files.md), [context](../cli/context.md)

## Mock mode

For development from a source checkout: `npm run tui:mock` runs the app
against an in-memory mock daemon (no daemon or model provider needed), with
two agents (`agent-1` with the loops `main`, `consolidator` and
`researcher`, and `agent-2`), a pending approval, files, timers, triggers and
scripted replies. The mock lives in `tests/tui/fixtures/`.

- `ADF_MOCK_IDENTITY=none|locked|restore-needed` (default ready) and
  `ADF_MOCK_FLEET=empty` try the first run; `ADF_MOCK_STORAGE=file` uses a
  passphrase file (passphrase `correct horse`).
- `agent-2` runs on a ChatGPT subscription that is not signed in; `/login`
  finishes by itself and never opens a browser.
- `ADF_TUI_PREFS=off` forgets the welcome count and other choices.
- `ADF_MOCK_EVENTS=5000` and `ADF_MOCK_EVENT_RATE=50` flood the event tail.
