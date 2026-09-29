# ADF Docs Style Guide

ADF documents state what is stored and what a runtime does, in the fewest exact words. Requirements use RFC 2119 keywords in capitals; everything else is a plain declarative sentence in present tense, and lower-case must/should/may never carry a requirement. Prefer a number, a field name, or a file:line over an adjective. Name each concept once, using the terminology list, and link to the one place it is defined instead of re-listing it. The agent is a program: describe what the runtime does, not what the agent wants or is. No metaphors, slogans, coined phrases, rhetorical triads, 'not X but Y' contrasts, or intensifiers ('genuinely', 'fully', 'simply', 'never' where MUST NOT is meant). At most one em-dash per paragraph. Reasons go in a paragraph marked 'Rationale:'; plans go in design docs, not the spec. Bold is for defined terms only.

## User guides

Guides under `docs/guides/`, `docs/cli/` and `docs/daemon/` may be friendlier: second person, task-oriented, one task per section. They follow the same rules on slogans, triads and one name per concept, and they do not restate the spec's definitions or requirements. They link to them.

## Terminology

Use these names. Do not introduce synonyms.

| Term | Meaning |
|------|---------|
| **localized agent** | An agent whose identity, state and behaviour are stored in a single `.adf` file, and which a conforming runtime can run from that file alone. |
| **body** | The `.adf` file of a localized agent. |
| **loop** | A conversation stream inside one agent: the **main loop** or an **inner loop**. User docs may write "inner loops (side loops)" on first use. |
| **turn** | One run of a loop, from the message, trigger or timer that starts it until the loop stops. |
| **transcript** | A loop's stored conversation history: its rows in `adf_loop`. |
| **owner** | The human whose owner identity (12-word seed) controls the agent's keys. |
| **runtime** | The program that opens `.adf` files and runs them: ADF Studio or the ADF daemon. |
| **lambda reference** | A `path:function` string naming a function in the agent's files, for example `lib/router.ts:onInbox`. |
| **model path / code path** | Work done by a model turn / work done by a lambda or sandbox code with no model call. |
| **channels** | Adapters that connect an agent to Telegram, Discord, Slack, WhatsApp or email. |
| **ADF CLI** | The `adf` command. |
| **terminal app** | `adf` run with no command. |

## Linking to the file's contents

The spec's [§1.3 One File, One Agent](../ADF_SPEC_v0.2.md#13-one-file-one-agent) holds the one authoritative table of what an `.adf` file contains. Do not re-list the components elsewhere. Write one sentence and link to it:

```markdown
An `.adf` file is one localized agent ([what's inside](../ADF_SPEC_v0.2.md#13-one-file-one-agent)).
```

Adjust the relative path to the linking file: `ADF_SPEC_v0.2.md#…` from the repository root, `../ADF_SPEC_v0.2.md#…` from `docs/`, `../../ADF_SPEC_v0.2.md#…` from `docs/guides/`. Link the access rules to [§1.1 Access Boundary](../ADF_SPEC_v0.2.md#11-access-boundary) the same way.
