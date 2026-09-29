# Context

Every loop sends its context to the model on each call: the system prompt,
injected files, tool definitions, MCP tools, dynamic instructions and the
conversation. When it reaches the loop's auto-compact threshold, the history
is summarized.

`/context [loop]` (palette "Context usage") shows what fills the selected
loop's context, like Studio's context breakdown:

- the total against the auto-compact threshold, and where that threshold
  comes from (the loop, the agent, the model, or the default);
- the categories, biggest first: system prompt, injected files, built-in
  tools, each MCP server, dynamic instructions, conversation.

| Key | Action |
|---|---|
| `Enter` | The category's biggest items |
| `c` | Compact now (asks) |
| `r` | Measure again |
| `←`, `→` | Other loops |
| `Esc` | Close |

A loop that is not running has nothing to measure.

The Chat footer shows `ctx 42%`: the latest call's input against the
threshold, amber from 70%, red from 90%. It appears after a call completes
while the app is open and clears on compact or clear.

To free context: `/compact` (summarize now), `/clear` (drop the loop's
history, asks), mute skills you do not need (`/skills`), turn off tools
(`/tools`), or change the threshold (`/compaction`, see
[Agent settings](agent-settings.md#compaction)).
