# Revision 3 changes (from Revision 2)

The package owner authorized these corrections through the reviewing agent. Revision 2 input was not modified. These files are a corrected copy.

## F2. Protection overrides are Studio-only

Revision 2 forwarded every `requires_authorization` task. That included `approval_meta.reason = "protection"` overrides, such as an override that would relax this gateway's own ledger guard, and it used a 3-field preview that hid what was being overridden.

Revision 3 adds `remoteEligible(t)`: `approval_meta` must parse and its `reason` must be exactly `'restricted'`. Every other task is Studio-only: protection overrides, missing metadata, unparseable metadata and unknown reasons. The check runs in:

- `onTaskCreate`: no ledger row, no DM; returns `{skipped:'studio_only_approval'}`;
- `onReply`: no `task_resolve`, even if a ledger row exists;
- `onTimeout`: never swept by the gateway.

## F3. The entry guard verifies more than one config value

`guard()` runs first in all three entry points and throws (fail closed) unless all of these hold:

1. `OWNER_ID` is a positive decimal user ID (unchanged).
2. `security.table_protections.local_telegram_hil_requests === 'authorized'` (unchanged).
3. `locked_fields` contains `security.table_protections`, `security`, or `security.table_protections.local_telegram_hil_requests`. Under the runtime's prefix-lock semantics, each of these blocks ordinary edits of the guard.
4. In both `main` and `temp` `sqlite_master`, the objects tied to the ledger are exactly:
   - the table, whose stored SQL equals the published DDL after whitespace normalization;
   - its three `sqlite_autoindex_*` indexes.

   Any trigger or view whose SQL mentions the ledger, any extra index, and any temp object (shadowing) all fail.

## Unchanged

Identity, correlation and expiry defenses are unchanged:

- principal sender and private-chat binding;
- ledger-bound outbox ID;
- preview hash and task hash;
- TTL from task creation;
- the atomic primary-key claim;
- exact verdict words.

The preview text and the ledger DDL are also unchanged.

## Revision 3.1 (documentation only)

`scripts/telegram-hil.js` is byte-identical to Revision 3 (sha256 `e17097e5…6bc`). `SKILL.md` changes:

- The atomicity deployment gate lists every owner decision surface: card, approvals menu, "Always approve", "Approve all" and the protection auto-deny timer. It also names the sweep direction and the same-tick deny race (a false `Approval recorded` after a Studio denial).
- New protection-conversion deployment gate. An async restricted call that is approved and then blocked by a lock is re-parked as a protection override. Runtimes that keep `approval_meta.reason = 'restricted'` on that row let a correlated Telegram "yes" approve the override, and let the sweep resolve it. The gateway cannot detect this; the runtime must relabel the row.
- The timeout section states the sweep's actual scope: ordinary restricted tasks only.

