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
review, and the table below gives one for each, with its reason and what
happens today.

The proposals follow these rules:

- **The shortest period that still does the job.** No proposal is longer than
  what happens today. If one ever needs to be, it must carry `exceeds_today` and
  say so here. None does at the moment.
- **The 97-day backup bound.** A backup copy can be up to retention plus one
  interval old: 90 + 7 days for the weekly off-host dump. Two kinds of record
  are restore tombstones, so they have to outlive that bound: a soft-deleted
  page and an erasure receipt. Without them, a restore would bring deleted data
  back with nothing to delete it again. The page proposal is set to the bound
  itself, so it moves when the bound moves. If the off-host proposal below is
  ratified, the bound drops from 97 to 37 days and the soft-deleted-page
  proposal drops with it.
- **Nothing acts on a proposal.** A proposal is stored next to its placeholder
  (`RetentionRule.proposal`, `Store.proposal`) and is shown by
  `PYTHONPATH=src python -m scripts.retention_report`. No sweep, purge or route
  reads it, and `backend/tests/domain/test_retention_proposals.py` pins three
  things:
  - no module outside the two registries refers to a proposal;
  - the energy-plan sweep keeps its 30-day default;
  - the journal purge keeps no default, and its floor is still derived from
    today's 90-day off-host retention.
- **To ratify a row,** write its value into the rule itself (for example
  `fixed_days(...)`, or set `days` on a sweep), set `ratified=True`, delete the
  proposal, and update this table. The tests reject a ratified rule that still
  carries a proposal, and an unratified rule without one.

## Database tables

| Store | Data kind | Proposed period | Rationale | Today's effective behaviour |
| --- | --- | --- | --- | --- |
| `journalentry (soft-deleted)` | Encrypted page, plus encrypted margin notes, promoted passages, suggestions and corpus fragments | 97 days after the soft delete (the backup bound) | It is kept only as the restore tombstone, so purge it once no live backup copy can still hold the page undeleted. That is the purge's own floor. | Kept until account deletion. An operator purge exists, but it has no default and nothing schedules it. |
| `journalwithdrawalobligation` | Content-free: ids, a closed state, an opaque vault fingerprint, timestamps | 30 days after the vault confirms (confirmed rows only). Open rows are kept until confirmed | An open row must outlive the vault copy it tracks. A confirmed row is only a receipt. | All states are kept until account deletion. |
| `voicedraftretraction` | Content-free: ids, a closed state, a fingerprint | 30 days after the vault confirms (confirmed rows only). Unsettled rows are kept until confirmed | Same reasoning as journal pages. An unsettled row also blocks the purge. | Kept until account deletion, or until the entry is hard-deleted. |
| `accountdeletionaudit` | Content-free: surrogate id, instant, row counts | 365 days after account deletion | It names nobody. As the restore tombstone it must outlive the 97-day bound, and a year still answers a support or regulator question about whether an erasure ran. | Kept indefinitely. |
| `gumroadsale` | Buyer email, Gumroad's raw payload, sale fields | 180 days after deletion of the account the sale credited: redact the email and raw payload. An unclaimed sale keeps its email until claimed | The email outlives the account only to match a refund, a dispute or a returning buyer, and 180 days covers card dispute windows. Gumroad keeps the authoritative sale record. **How long the amounts must be kept for bookkeeping is a legal question.** | Kept indefinitely, email included, after the account is deleted. |
| `loginattempt` | Typed email address, IP, success flag | 30 days after the attempt | The address and IP are personal data. Lockout reads only the last 15 minutes, and 30 days is common security-log practice for investigating credential stuffing. The same applies to addresses that never had an account. | Kept until the matching account is deleted. Attempts against addresses with no account are never removed. |
| `llmusagelog` | Content-free: tokens, cost, model, entry link | 90 days after the metered call | This covers the 30-day cost-alert window plus reconciliation against two monthly provider invoices. Side effect: the all-time admin totals become 90-day totals. | Kept until account deletion. |
| `revokedtoken` | Opaque JWT id and its expiry | 1 day after the token's own expiry | An expired token is already rejected by its signature check, so the row protects nothing after that. One day absorbs clock skew. | Kept indefinitely; nothing sweeps it. |
| `practicesharelink` | Capability token and practice id, anonymised after its creator is deleted | 30 days after the link stops working (expired, revoked or used up) | A dead link serves no recipient. A live link with no expiry keeps working as it does today, because recipients may hold it. | Kept indefinitely, dead links included. |
| `energyplan` | A generated plan derived from the account's habits | 7 days after the plan is created | It is only re-read to answer a retried request, and it is cheap to regenerate. | Kept until account deletion, or until an operator runs the sweep (30-day default). Nothing schedules the sweep. |
| `vaultteardownreceipt` | Content-free: opaque Creek job id, teardown state | 90 days after teardown is confirmed. Unconfirmed receipts are kept until confirmed | It names no account. Once confirmed, it only needs reconciling against the vendor's invoices, which three billing cycles cover. | Kept indefinitely. |
| `restoremarker` | Content-free: operator restore id, state, counts | 365 days after the reapply completes, and never while `RESTORE_ID` still names it | It names no person. It refuses a second reapply after cutover, and that risk does not fade with time. The startup gate must stop naming it before the row goes. | Kept indefinitely. |

## Stores outside the database

| Store | Data kind | Proposed period | Rationale | Today's effective behaviour |
| --- | --- | --- | --- | --- |
| `railway_platform_backup` | Whole-database snapshot | 6 days (keep) | Daily, kept 6 days, is already Railway's shortest schedule, and it is the leg that recovers from everyday mistakes. | 6 days, if enabled. Enabling it is unverified (#3058). |
| `offhost_pg_dump` | Encrypted whole-database dump | 30 days | Four weekly copies still cover a month of late-found damage or platform loss. It cuts the backup bound from 97 to 37 days, and every proposal keyed to the bound drops with it. | 90 days, pruned by hand on each weekly run (DRAFT step). |
| `application_logs` | Content-free logs that name account ids | 30 days | 30 days is common security-log practice for incident investigation. Where 30 is not available, use the vendor's shortest setting. | Vendor defaults, unverified (#3064). |
| `fly_volume_snapshots` | Snapshots of the managed vault volume | 1 day | The vault mirrors the journal, so a snapshot only needs to bridge a day. Set the vendor's minimum and destroy snapshots at teardown, subject to the AC19 vendor check. | The pilot keeps 7 days. Per-user volumes use the vendor default. Survival after the volume is destroyed is unverified. |
| `creek_vault_volume` | Mirrored entries and essays | no fixed period | Each copy is tied to an event, not a clock: it lives until its verified withdrawal, or the vault's teardown at account deletion. | Same as proposed. |
| `creek_embeddings_cache` | Vectors derived from entries | no fixed period | Event-bound: the vectors go when their entry's withdrawal is verified. | Same as proposed. |
| `creek_ledger` | Ingest ledger rows | no fixed period | Event-bound: the rows go when their entry's withdrawal is verified. | Same as proposed. |
| `client_device_cache` | On-device caches | no fixed period | Not ours to set. The device holds it, and it is wiped when another account signs in. | Same as proposed. |
| `manual_vaults` | A vault the user runs | no fixed period | Not ours to set. The user operates the vault and decides. | Same as proposed. |
| `model_vendor_copies` | Prompts and completions held by the provider | no fixed period | This is the vendor's period, not ours. You deferred vendor fields to B11 (#3065). | Vendor retention, unestablished. |

## A separate question: keeping an obligation after account deletion

An `unconfirmed` withdrawal record (`journalwithdrawalobligation`, and
`voicedraftretraction` while unsettled) must outlive the vault copy it tracks.
Today account deletion erases it, so afterwards nothing records that a copy may
remain. One option is to keep a detached, content-free form of the row after
erasure, until the vault confirms the copy is gone.

**That would keep data longer than today.** It is therefore not part of any
proposal above and is not wired into the registry. It is listed here for your
decision only (#3063 AC21-22, #3094). See
[gdpr-erasure-unreachable-vaults.md](gdpr-erasure-unreachable-vaults.md).

## Still open

- **Tombstone custody (AC17).** You have not decided where custody lives, so
  the restore runbook step in `DEPLOYMENT.md` stays a draft. The tombstone
  file's own retention follows from that decision.
- **Scheduling (AC18).** Even a ratified period changes nothing until a
  scheduled sweep or prune applies it. Scheduling is a separate infrastructure
  decision.
