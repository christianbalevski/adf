```
# Import report: <source> → <agent name>, <date UTC>

## Carried
- <file> → <target>  (distilled into <page> | merged into <page> | staged skill)

## Lossy
- <item>: what was lost and why (large files read in chunks, "scope unclear" facts, weekday mismatches, lines withheld)
Pages cite your files by name and line. I kept no copies, so check those lines in your original.

## Not carried
- <item>: why (credential, hook, schedule, history, config, identity, unreadable)

## Not imported
- <path> (<size>)  [<label>] [scanned in code | not scanned] [credential-like (content)]
Files not on the allowlist (other notes folders, CSVs) weren't imported. Drop any one on its own and ask, and I'll import it.

## Secrets
<n> values were hidden from the model provider in <m> files; PROVENANCE.md lists the lines, without the values.
<k> more were found in files that were scanned in code but not imported: <paths>.
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
