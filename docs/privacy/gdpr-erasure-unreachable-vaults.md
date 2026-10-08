# Erasure when the vault holding a copy is out of reach

Status: **draft plan for owner review** (adepthood #3094, follow-up to B04
#3060, retention under B08 #3063). User-facing wording quoted here is a draft.
Retention durations are placeholders. Neither is decided.

## The situation

A journal page, and any Voice Draft essay written from it, can be mirrored into
the Creek vault the writer had connected at the time. Adepthood records which
vault received each copy as an opaque fingerprint
(`journalentry.vault_destination`, `voicedraftretraction.destination`). It
trusts a withdrawal only when *that* vault confirms the copy is gone. A vault
connected later answers "unknown id, withdrawn" for an id it never saw, and
that answer is never taken as proof.

When the writer has since replaced or disconnected that vault, Adepthood holds
no credential that reaches it. Before #3094 a DELETE of such a page answered a
permanent 503. The owner's decision (B04 escalation 5) was: **reconnect first,
then a local erase with an UNCONFIRMED obligation and a plain tell.**

## What the writer sees

1. **Delete** answers 503 with a content-free detail that says where the copy
   is, relative to the vault connected now:
   - `vault_withdrawal_previous_vault`: in a vault connected before the current one;
   - `vault_withdrawal_disconnected_vault`: in the vault that was disconnected;
   - `vault_withdrawal_pending` (unchanged): the connected vault has not
     confirmed yet.

   In every one of these cases the DELETE has recorded a `pending_delete`
   obligation, so the deletion is **in progress**: the background sweep
   finishes it once the vault holding the copy confirms (#3098). Until then the
   page refuses every content write (edit, tier change, reflection, essay,
   suggestion detection, quote promotion) with 409
   `journal_entry_deletion_pending`. Before it stamps `deleted_at` the sweep
   repeats the local half of the deletion: the corpus withdrawal and the essay
   retraction marking. It requires every essay withdrawal, including any it
   just marked, to be confirmed first.

   The location is relational on purpose. Once a connection is replaced its URL
   is not kept, and a fingerprint means nothing to a person. What they do know
   is which vault they are connected to now. Naming the old vault by URL or
   label would mean storing it at bind time, which is an owner decision (see
   "Open decisions").
2. The shelf keeps the page, says it is set to be deleted and when deletion
   finishes (never that the delete failed), and offers two actions:
   - **Reconnect vault** (primary), which opens vault settings;
   - **I can't reach it — delete here only**, explained before it is offered.
3. **Delete here only** calls `POST /journal/{entry_id}/erase-locally`.

## What we erase

`POST /journal/{entry_id}/erase-locally` first attempts every owed withdrawal,
exactly as DELETE does. Reconnect-first holds inside it too: if the vault can
confirm, this is an ordinary deletion. Otherwise:

- The page is soft-deleted (`deleted_at` stamped). It is gone from every read
  path, from the list, and from both export routes, as any deleted page is.
- Its local corpus copy is withdrawn, so it is no longer retrieved as context.
- Every Voice Draft essay offered to a vault stays `pending` in
  `voicedraftretraction`, as before.
- The soft-deleted row and its derivatives follow the existing soft-delete
  lifetime: until account deletion or an operator purge
  (`domain/retention.py`, `journalentry.soft_deleted`, unratified). The purge
  no longer has to keep the row to remember the remote copy, because the
  obligation below is not a foreign key into it.

## What we cannot reach

- The copy of the page, and of any essay, in the old vault. We hold no
  credential for it and dial nothing there.
- Anything the old vault derived from those copies (indexes, embeddings,
  backups of the vault). Creek's own erasure contract covers these once it is
  asked (Creek#1854), but it can only be asked through a connection.
- A **legacy copy with no recorded vault** (ingested before destination binding
  existed). If it is erased with no vault connected, no vault can ever be
  proven to hold it. Its obligation is recorded with no destination and is
  **never** confirmed automatically.

## What we keep: the obligation

`journalwithdrawalobligation` holds one row per (account, page). It is
content-free: ids, a closed state, an opaque destination fingerprint and
timestamps. It holds no body, title, URL, credential or content hash.

| state            | meaning                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| `pending_delete` | DELETE was asked; the page stays live until its vault confirms (#3098).  |
| `unconfirmed`    | Erased here; a copy may remain in the recorded vault.                    |
| `confirmed`      | The recorded vault confirmed the copy gone.                              |

`journal_entry_id` is deliberately not a foreign key, so the row outlives a
purge of the page.

**Reconnect afterwards.** When the writer reconnects the recorded vault, the
background sweep (`resume_voice_draft_retractions`) withdraws the copy from it
and moves the row to `confirmed`. No other vault's answer clears it. The
essays' rows clear the same way.

**Telemetry.** Obligation transitions log `entry_id`, `from_state` and
`to_state` only (`OBLIGATION_LOG_EXTRAS`). The erase logs `entry_id` and the
closed location code. Tests pin both
(`test_journal_delete_completion.py`, `test_journal_unreachable_vault.py`).

## What the receipt says

The API receipt is closed and content-free:

```json
{"entry_id": 7, "remote_copy": "unconfirmed", "copy_location": "previous_vault"}
```

`remote_copy` is `confirmed_absent` only when the vault holding the copy
confirmed it gone. There is no `withdrawn` value. The shelf renders the draft
text below:

- Unconfirmed: "Deleted from Adepthood. A copy may still be in the Creek vault
  you were connected to before. We couldn't confirm it's gone, so please delete
  it there." The disconnected variant reads "the Creek vault you
  disconnected". When the connected vault itself could not confirm, or no
  location is named, it reads "your Creek vault".
- Confirmed: "Deleted. Your Creek vault confirmed its copy is gone too."

Nothing anywhere reports a copy withdrawn while its row is `unconfirmed`.

## Retention of obligation rows (B08 registry)

The table is registered in all three registries:

- `domain/retention.py`: `until_account_deletion`, `ratified=False`.
- `domain/account_deletion.py`: erased with the account, as
  `voicedraftretraction` is.
- `domain/data_export.py`: omitted from export as housekeeping.

These are placeholders consistent with B08's existing ones. They are not
decided.

## Known limits

- **Account deletion drops the record.** An `unconfirmed` row is erased with
  the account, so after account deletion nothing records that a copy may
  remain. The account-deletion receipt's vault guidance is the only tell.
- **Backup restore.** A restore from a backup taken before the erase reapplies
  the page's deletion tombstone (B08 restore suppression). It does not recreate
  the obligation row: tombstones carry no obligations.
- **Legacy unbound copies.** As above, they are never auto-confirmed. While the
  page is still live, its ordinary withdrawal still trusts the vault connected
  now (the pre-existing limit pinned by
  `test_legacy_unbound_marker_is_withdrawn_from_the_current_vault`).

## Open decisions (owner)

1. Final wording of the 503 notices, the choice, and the receipt (drafts above
   and in `frontend/src/features/Journal/deleteEntryCopy.ts` and
   `frontend/src/api/errorMessages.ts`).
2. Retention values for `confirmed` and `unconfirmed` rows, and whether an
   `unconfirmed` row should outlive account deletion.
3. Whether to store a content-free, person-recognisable vault label at bind
   time, so the tell can name the old vault rather than describe it.
4. Whether `docs/your-data.md` and the privacy policy should describe the
   "delete here only" path. Neither does yet: adding it is new user-facing
   wording.
5. GDPR Art. 17(2) posture for a managed vault, where the operator rather than
   the writer may be the party able to reach the old copy.
