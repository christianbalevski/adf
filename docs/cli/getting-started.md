# Getting started

From nothing to an agent you can chat with, in the terminal app. Every step
also has a one-shot command, shown after it.

## 1. Open the terminal app

```bash
adf
```

`adf` checks for a daemon on `http://127.0.0.1:7385`. When none answers it
starts one in the background (`Starting the ADF daemon…`) and opens the app.
The daemon keeps running after you quit (`Ctrl+C` twice, or `/quit`).

The first three launches open a **welcome** over the app: what ADF agents
are, and a checklist.

```text
 Get started
 › ○ Set up your identity   /identity
   ○ Connect a model        /login chatgpt · /provider add
   ○ Create an agent        /new
   ○ Connect a channel      /channels add  Telegram · Discord · Slack · Email · WhatsApp
   ○ Give it tasks          chat with it, or schedule a loop  /loop new
```

Steps tick themselves as the daemon reports them done. `Enter` runs the
selected step, `Esc` closes the welcome, `d` hides it for good, `/welcome`
brings it back.

## 2. Owner identity

Your owner identity proves the agents are yours: new agents are sealed under
it. It is a 12-word seed phrase, the **same words as in ADF Studio**: the
same phrase is the same owner, on any machine.

- **New to ADF:** `/identity create`. The app shows the 12 words once. Write
  them down, then type `saved` and `Enter`. They are never shown again, never
  put in a toast, log or the clipboard.
- **You already use Studio or another machine:** `/identity restore` and
  paste or type the 12 words (numbering, line breaks and case are ignored).
- **Studio on this machine already has it:** nothing to do. Studio and the
  daemon share it through the OS keychain; the header shows `owner z6Mk…`.

On a machine without an OS keychain (a headless Linux server) the phrase is
kept in a passphrase-protected file; you choose the passphrase when creating
or restoring. See [Identity and security](identity-and-security.md).

One-shot: `adf identity new`, `adf identity restore`, `adf identity`.

## 3. Connect a model

- **ChatGPT or Grok subscription:** `/login chatgpt` opens your browser;
  `/login grok` shows a device code to approve in any browser.
- **Claude Pro or Max plan:** install
  [Claude Code](https://code.claude.com/docs/en/setup) (2.1.248 or newer),
  then `/login claude`. Sign-in runs through Claude Code and shares its
  session.
- **Hosted API** (Anthropic, OpenAI, OpenRouter, Gemini, or an
  OpenAI-compatible URL): `/provider add`, pick the provider and paste its
  API key. It goes to the daemon's secret store, never the settings file.
- **Local server** (Ollama, LM Studio, or any OpenAI-compatible chat server):
  start the server and load a model, then use `/provider add` with its API
  base URL and model ID. Both the server and model need tool calling for
  agent tools. Vision is needed only to understand images or screenshots;
  a key is needed only if the server requires one. See
  [Local model requirements](models-and-providers.md#local-model-requirements).

One-shot: `adf auth login chatgpt`, `adf auth login grok`, `adf auth login
claude`, `adf providers`.
More in [Models and providers](models-and-providers.md).

## 4. Create an agent

`/new` (or `n` on the Fleet view) opens the new-agent wizard: a name (empty
= generated), a template, optional provider and model, and "start now". The
agent is created in your agents folder, sealed, reviewed, loaded, and opened
in Chat.

One-shot:

```bash
adf templates
adf new agent-1 --template <id> --start
```

Without `--dir` agents go to Studio's agents folder (`agentsFolder` setting,
else `~/Documents/adf-agents`), which is tracked so the agent loads again at
every daemon start.

## 5. Chat

Press `1` for Chat (or `Enter` on an agent). Type in the prompt at the bottom
and press `Enter`. Replies, thinking and tool calls stream into the
transcript.

- **Newline:** `Alt+Enter`, `Ctrl+J`, or `Shift+Enter` where the terminal
  supports it (`/terminal-setup` checks yours).
- **Approvals:** when the agent wants to run a restricted tool, a card
  appears under the transcript. Focus the transcript with `Shift+Tab`: `y`
  approves with one press when that pending approval is selected; otherwise
  press `y` twice while the confirmation hint is visible. `n` rejects, `f` rejects
  with feedback, and `a` follows the same selection/two-press rule before
  asking you to confirm always approving that tool. In the prompt, typed
  `y` is text; use `/approve` to approve from there.
- **Stop a turn:** `Esc` interrupts the running turn; the agent stays up and
  keeps accepting work.

One-shot: `adf chat agent-1 "hello"` sends a message and prints the turn id;
`adf events agent-1` follows what happens.

See [Terminal app](terminal-app.md) for everything else on screen.

## 6. Connect a channel (optional)

`/channels add telegram` (or discord, slack, email, whatsapp) walks you
through the credentials for the selected agent and switches the channel on.
See [Channels](channels.md).

## 7. Give it work on a schedule

An agent can run **inner loops** (side loops): parallel threads with their
own goal and history, next to `main`, which talks to you. The classic one is
a memory consolidator that tidies the agent's memory every night:

```text
/loop new consolidator
```

The wizard comes prefilled with a goal, tools and a daily 03:00 timer;
`Ctrl+S` reviews, `y` creates. See [Loops and timers](loops-and-timers.md).

## Next

- `?` or `/help` in the app lists every key and command; `Ctrl+K` searches
  everything.
- Already have `.adf` files? `f` on the Fleet view tracks a folder of agents
  (they load now and at every daemon start); `o` loads one file.
- [Troubleshooting](troubleshooting.md) if something does not start.
