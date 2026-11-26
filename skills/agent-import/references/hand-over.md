## 14. Hand over (importer) or remove the drop (in place)

### Importer: hand over

After every page and the report are written:
1. In one `sys_code` call, `fs_list` `import-review/<source>/` and return the paths to send: `REPORT.md`, `PROVENANCE.md`, `manifest.md`, drafts, generated staged `skills/<name>/SKILL.md`, and generated `mind/` pages. Never send source resources, `assets/`, any other files under staged skill folders, `notes/` (working files), `held.json`, `risk.json`, or anything under the drop folder. Check that no path is under the drop.
2. `msg_send` to the home agent with its bare handle as `recipient` (no address; the runtime resolves a local handle), those paths as `attachments`, and a short message: the source, the counts, "Pages only. The notes stayed in <importer name>.", and the attached paths, one per line in attachment order. The home agent needs that list: attachments arrive flattened by file name. If the send fails, say so to the owner and stop. Don't retry with the drop.
3. Tell the owner: "I sent the handover to <home agent>. Keep me until <home agent> confirms every expected page arrived and was placed. A successful send can still skip an attachment. My file still holds your agent's files; <home agent> will tell you when it is ready for you to delete me. Keep your originals, since the pages cite them by name and line."

Don't delete the drop here. The whole importer goes only after the home agent confirms complete receipt and placement. The report's Clean up says: "The importer, <name>, holds a copy of your agent's files. Keep it until <home agent> confirms every expected page arrived and was placed. Then delete <name> from the list on the left in Studio, and press Delete when it asks. That removes its file (usually in the same folder as <home agent>'s) from this computer. A copy of the importer you exported, shared, or backed up still holds them." Leave out Waiting on you item 10.

### In place: remove the drop (code)

The last step, after every page and the report are written. In one `sys_code` call:
1. If the owner said no in step 7, delete nothing. If `fs_delete` is missing, delete nothing.
2. Read the config with `adf.sys_get_config({})`. If `context.audit.files` or the legacy `audit.files` is true, delete nothing: with file auditing on, deleting a file archives its whole content into the agent's history. If the config can't be read, delete nothing.
3. Otherwise `fs_list` each drop folder, `fs_delete` every file in it (SKIP and credential-like ones too; for a single-file drop, that file only), then `fs_list` again. Return only the counts deleted and left, and the paths left.

Fill in the report's Clean up and Waiting on you item 10 with one plain sentence:
- Deleted, none left: Clean up says "I removed the files you dropped from this agent's file list. Traces of them can stay inside the agent file, so don't share this agent with anyone you wouldn't show those files to." Drop item 10.
- No `fs_delete`, or the owner said no: "Delete the folder <drop folder> in Studio's Files panel." (For a single-file drop: "Delete the file <path> in Studio's Files panel.")
- Auditing on: "I didn't delete the files you dropped, because file auditing is on in this agent's settings and deleting them would copy your agent's files into its history."
- Config unreadable: "I didn't delete the files you dropped, because I couldn't check whether file auditing is on, and if it is, deleting them would copy your agent's files into this agent's history."
- Some left: "These dropped files are still here; delete them in Studio's Files panel: <paths>."

Never call the notes deleted for good, gone, or unrecoverable. Then send the owner a short message: counts, decisions waiting, credential warnings, and that sentence.
