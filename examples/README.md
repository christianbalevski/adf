# Example ADF Contents

This directory shows the raw contents of a valid `.adf` file. An `.adf` file is a ZIP archive containing these files:

| File | Purpose |
|------|---------|
| `agent.json` | Agent configuration — model, tools, triggers, instructions |
| `document.md` | The user-facing working document |
| `mind.md` | The agent's private working memory (starts empty) |
| `chat.json` | Conversation history (starts empty) |

See [ADF_SPEC_v0.4.md](../ADF_SPEC_v0.4.md) for the full specification.

## Creating an .adf from these files

```bash
cd examples
zip meeting-notes.adf agent.json document.md mind.md chat.json
```

Then open `meeting-notes.adf` in the ADF application.
