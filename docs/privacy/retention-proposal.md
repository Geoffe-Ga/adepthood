# Proposed retention periods (B08)

Status: **DRAFT proposal for owner review** (adepthood #3063, AC15). These
values are **not ratified** and none is in force. This is not a published
retention schedule. Publishing one is a separate decision (#3063 AC16, B01).

## What this is

The B08 retention registry (`backend/src/domain/retention.py`) and the store
inventory (`backend/src/domain/retention_stores.py`) list every place
Adepthood keeps data and how long it stays there. Some of those periods are
undecided. In the registry they are marked `ratified=False`; in the inventory
they are an `Unknown` deadline or a backup leg. You asked for proposed values to
review, and the tables below give one for each, with its reason, how it
compares with today, and what happens today.

The proposals follow these rules:

- **The shortest period that still does the job.** Every proposal declares how
  it compares with today: `shorter`, `same`, `longer` or `unknown`. The code
  checks that declaration against the rule:
  - a known window is compared number to number;
  - a clock that starts at account deletion, on rows that today are erased with
    the account, counts as `longer`;
  - a period against a deadline nobody has verified (a vendor default) counts as
    `unknown`.

  No proposal below is `longer`. Two are `unknown` (application logs, Fly
  snapshots): they can only be compared once today's vendor setting is known.
- **The 97-day backup bound.** A backup copy can be up to retention plus one
  interval old: 90 + 7 days for the weekly off-host dump. Two kinds of record
  are restore tombstones, so they have to outlive that bound: a soft-deleted
  page and an erasure receipt. Without them, a restore would bring deleted data
  back with nothing to delete it again.
- **A shorter backup retention does not shorten the bound at once.** If you
  ratify the 30-day off-host proposal, dumps already kept under the 90-day
  retention still exist until they age out and are pruned. The bound, the
  journal purge floor and the soft-deleted-page proposal therefore stay at 97
  days while those copies are held. The code enforces this through
  `HELD_OFFHOST_DUMP_RETENTION_DAYS`: the floor is the larger of today's legs
  and the copies still held. Lowering it to 37 days is a **second, later
  change**, made only once every 90-day-era dump has been pruned.
- **Some proposals are conditional.** Open obligations (`pending_delete`,
  `unconfirmed`, `mirror_intent`, `pending`), unconfirmed teardowns and
  unfinished restores are never eligible, and these exemptions are stored as
  data on the proposal. The sale proposal blanks two columns rather than
  deleting the receipt. The conditions are also required, per table, of any
  rule that sweeps, so they survive ratification. A conditional proposal
  therefore cannot be ratified as a plain `fixed_days` rule.
- **Clocks are compared only like with like.** A proposal counted from account
  deletion, on rows erased with the account today, is `longer` whatever window
  applies today. A window counted from row creation is compared only with a
  proposal on the same clock; any other clock is `unknown`.
- **Nothing acts on a proposal.** A proposal is stored next to its placeholder
  (`RetentionRule.proposal`, `Store.proposal`) and is shown by
  `PYTHONPATH=src python -m scripts.retention_report`. No sweep, purge or route
  reads it, and `backend/tests/domain/test_retention_proposals.py` pins three
  things:
  - no module outside the two registries refers to a proposal;
  - the energy-plan sweep keeps its 30-day default;
  - the journal purge keeps no default.
- **To ratify a row,** write its value into the rule itself and copy the
  proposal's conditions onto the rule (`exempt_states`, `redact_columns`).
  Then set `ratified=True`, delete the proposal, and update this table. The
  tests reject:
  - a ratified rule that still carries a proposal;
  - an unratified rule without one;
  - a sweeping rule that drops a required condition. For example, the
    withdrawal obligations ratified as a plain `fixed_days` rule without their
    open-state exemption, or the sale receipt deleted rather than redacted.

Claims about law, vendors and payment disputes below are assumptions **to
confirm**, not settled facts.

## Database tables

| Store | Data kind | Proposed period | Compared with today | Rationale | Today's effective behaviour |
| --- | --- | --- | --- | --- | --- |
| `journalentry (soft-deleted)` | Encrypted page, plus encrypted margin notes, promoted passages, suggestions and corpus fragments | 97 days after the soft delete (the backup bound) | shorter | It is kept only as the restore tombstone, so purge it once no live backup copy can still hold the page undeleted. That is the purge's own floor, and it falls only after copies kept under an older, longer retention have aged out. | Kept until account deletion. An operator purge exists, but it has no default and nothing schedules it. |
| `journalwithdrawalobligation` | Content-free: ids, a closed state, an opaque vault fingerprint, timestamps | 30 days after the vault confirms. Confirmed rows only: `pending_delete` and `unconfirmed` rows are never eligible | shorter | An open row must outlive the vault copy it tracks. A confirmed row is only a receipt. | All states are kept until account deletion. |
| `voicedraftretraction` | Content-free: ids, a closed state, a fingerprint | 30 days after the vault confirms. Confirmed rows only: `mirror_intent` and `pending` rows are never eligible | shorter | Same reasoning as journal pages. An unsettled row also blocks the purge. | Kept until account deletion, or until the entry is hard-deleted. |
| `accountdeletionaudit` | Content-free: surrogate id, instant, row counts | 365 days after the receipt is created (at account deletion) | shorter | It names nobody. As the restore tombstone it must outlive the 97-day bound, and a year still answers a support or regulator question about whether an erasure ran. | Kept indefinitely. |
| `gumroadsale` | Buyer email, Gumroad's raw payload, sale fields | 180 days after the sale is anonymised at account deletion: blank `email` and `raw_payload` and keep the receipt. **Needs a new `anonymised_at` column (proposed, not built)** | shorter | See the note after this table. | Kept indefinitely, email included, after the account is deleted. |
| `loginattempt` | Typed email address, IP, success flag | 30 days after the attempt | shorter | The address and IP are personal data. Lockout reads only the last 15 minutes, and 30 days is common security-log practice for investigating credential stuffing (to confirm). The same applies to addresses that never had an account. | Kept until the matching account is deleted. Attempts against addresses with no account are never removed. |
| `llmusagelog` | Content-free: tokens, cost, model, entry link | 90 days after the metered call | shorter | This covers the 30-day cost-alert window plus reconciliation against two monthly provider invoices. Side effect: the all-time admin totals become 90-day totals. | Kept until account deletion. |
| `revokedtoken` | Opaque JWT id and its expiry | 1 day after the token's own expiry | shorter | Once a token has expired, decoding already rejects it on its expiry (`exp`) check, so the row protects nothing. One day absorbs clock skew. | Kept indefinitely; nothing sweeps it. |
| `practicesharelink` | Capability token and practice id, anonymised after its creator is deleted | 30 days after the link stops working (expired, revoked or used up) | shorter | A dead link serves no recipient. A live link with no expiry keeps working as it does today, because recipients may hold it. | Kept indefinitely, dead links included. |
| `energyplan` | A generated plan derived from the account's habits | 7 days after the plan is created | shorter | It is re-read to answer a retried request, and it is included in the owner's export. A week covers any retry. Older plans would also leave the export; a plan is cheap to regenerate. | Kept until account deletion, or until an operator runs the sweep (30-day default). Nothing schedules the sweep. |
| `vaultteardownreceipt` | Content-free: opaque Creek job id, teardown state | 90 days after teardown is confirmed. `deleting` and `failed` receipts are never eligible | shorter | It names no account. Once confirmed, it only needs reconciling against the vendor's invoices, which three billing cycles should cover (to confirm). | Kept indefinitely. |
| `restoremarker` | Content-free: operator restore id, state, counts | 365 days after the reapply completes. An `in_progress` marker is never eligible, and nor is one `RESTORE_ID` still names | shorter | It names no person. It refuses a second reapply after cutover, and that risk does not fade with time. | Kept indefinitely. |

**Payment records (`gumroadsale`).** The trigger needs a timestamp the row
does not have today. When an account is deleted, its licence link (the
`LicenseBinding` row) is erased with it. The sale is left looking the same as
one that was never claimed, and nothing records when that happened. The
proposal therefore includes a schema change: an `anonymised_at` stamp, set by
account deletion on every sale linked to the account. It is not built.

**The trade-off.** After redaction, a returning buyer can no longer be matched
to the licence or pack they paid for. That is the reason the deletion policy
keeps the email today.

Some things here are assumptions to confirm:

- that 180 days covers typical refund and card-dispute windows (some dispute
  codes run longer);
- whether Gumroad's own record is enough for disputes;
- how long the amounts must be kept for bookkeeping (a legal question).

A sale never linked to an account keeps its email, because that is its only
claim path.

## Stores outside the database

| Store | Data kind | Proposed period | Compared with today | Rationale | Today's effective behaviour |
| --- | --- | --- | --- | --- | --- |
| `railway_platform_backup` | Whole-database snapshot | 6 days (keep) | same | Daily, kept 6 days, is already Railway's shortest schedule, and it is the leg that recovers from everyday mistakes. | 6 days, if enabled. Enabling it is unverified (#3058). |
| `offhost_pg_dump` | Encrypted whole-database dump | 30 days | shorter | Four weekly copies still cover a month of late-found damage or platform loss. Transition: the purge floor stays at 97 days until every dump kept under the 90-day retention has aged out and been pruned. Only a later change lowers it, to 37. | 90 days, pruned by hand on each weekly run (DRAFT step). |
| `application_logs` | Content-free logs that name account ids | 30 days or the vendor's current setting, whichever is shorter | unknown | 30 days is common security-log practice (to confirm). Today's vendor retention is unverified, so this cannot yet be called shorter. It may be 7 days on some plans, and then the proposal keeps that. | Vendor defaults, unverified (#3064). |
| `fly_volume_snapshots` | Snapshots of the managed vault volume | 1 day | unknown | The vault mirrors the journal, so a snapshot only needs to bridge a day. Set the vendor's minimum and destroy snapshots at teardown, subject to the AC19 vendor check. | The pilot keeps 7 days. Per-user volumes use the vendor default. Survival after the volume is destroyed is unverified. |
| `creek_vault_volume` | Mirrored entries and essays | no fixed period | same | Each copy is tied to an event, not a clock: it lives until its verified withdrawal, or the vault's teardown at account deletion. | Same as proposed. |
| `creek_embeddings_cache` | Vectors derived from entries | no fixed period | same | Event-bound: the vectors go when their entry's withdrawal is verified. | Same as proposed. |
| `creek_ledger` | Ingest ledger rows | no fixed period | same | Event-bound: the rows go when their entry's withdrawal is verified. | Same as proposed. |
| `client_device_cache` | On-device caches | no fixed period | same | Not ours to set. The device holds it, and it is wiped when another account signs in. | Same as proposed. |
| `manual_vaults` | A vault the user runs | no fixed period | same | Not ours to set. The user operates the vault and decides. | Same as proposed. |
| `model_vendor_copies` | Prompts and completions held by the provider | no fixed period | same | This is the vendor's period, not ours. You deferred vendor fields to B11 (#3065). | Vendor retention, unestablished. |

## A separate question: keeping an obligation after account deletion

An `unconfirmed` withdrawal record (`journalwithdrawalobligation`, and
`voicedraftretraction` while unsettled) must outlive the vault copy it tracks.
Today account deletion erases it, so afterwards nothing records that a copy may
remain. One option is to keep a detached, content-free form of the row after
erasure, until the vault confirms the copy is gone.

**That would keep data longer than today.** The registry would flag any such
proposal as `longer`. It is therefore not part of any proposal above and is not
wired into the registry. It is listed here for your decision only (#3063
AC21-22, #3094). See
[gdpr-erasure-unreachable-vaults.md](gdpr-erasure-unreachable-vaults.md).

## Still open

- **Tombstone custody (AC17).** You have not decided where custody lives, so
  the restore runbook step in `DEPLOYMENT.md` stays a draft. The tombstone
  file's own retention follows from that decision.
- **Scheduling (AC18).** Even a ratified period changes nothing until a
  scheduled sweep or prune applies it. Scheduling is a separate infrastructure
  decision.
