# Files

Every agent carries its own files inside its `.adf`: the **document**, its
**mind** (memory), and any other files it or you write. The Files view (`2`,
or `/files`) browses and edits them.

## Browse

| Key | Action |
|---|---|
| `↑`, `↓` | Move; the viewer previews the highlighted entry |
| `Enter` | Open the file in the viewer · open or close a folder |
| `Backspace` | Close the folder · then go to the parent folder (never deletes) |
| `←`, `→` | Tabs: Files · Inbox · Outbox · Meta |
| `/` | Filter by path (fuzzy); `Backspace` edits the filter while you type |

The viewer colours code, searches (`/`, then `n` / `N`) and shows binaries as
hex. `Backspace` or `Esc` goes back to the tree, with the file still
selected. A badge names the loop that last wrote a file.

## Edit

| Key | Action |
|---|---|
| `e` | Edit in your external editor, then confirm the write (a diff is shown; a change made meanwhile by the agent is detected) |
| `n` | New file |
| `m` | Rename or move (a folder moves with its files) |
| `d`, `Delete` | Delete (asks) |
| `p` | Protection: none → read_only → no_delete |
| `a` | Toggle authorized |
| `r` | Reload |

From the prompt, from any view:

```text
/doc                      # show the document
/mind                     # show the mind
/open notes/api.md        # fuzzy path; document and mind work too
/edit mind
/new-file notes/todo.md
/rm notes/old.md
/mv notes/a.md archive/a.md
```

In Chat, `@` in the prompt completes a file path (`Tab` or `Enter`), to
point the agent at a file.

The external editor is `ADF_EDITOR`, then `VISUAL`, then `EDITOR`
(default `notepad` on Windows, else `nano`, then `vi`). Binary files can be
viewed but not edited. A folder cannot be deleted in one go: delete its files.

## Inbox, Outbox, Meta

Read-only tabs: messages the agent received and sent (`Enter` reads one,
`Backspace` or `Esc` goes back, `f` filters by status) and its meta entries.

One-shot:

```bash
adf files agent-1                 # path, size, type, protection
adf file agent-1 notes/api.md     # print one file (binary: base64)
adf inbox agent-1
adf outbox agent-1
```
