# Ratified retention periods (B08)

Status: **ratified by the owner on 2026-10-13** (adepthood #3063, AC15;
[decision](https://github.com/Geoffe-Ga/adepthood/pull/3155#issuecomment-6151018235),
PR #3155 comment 6151018235). Every period proposed here was ratified as
written, with its conditions, including the rows that were marked "to confirm".
This is the owner's decision record, not a published retention schedule.
Publishing one is a separate decision (#3063 AC16, B01).

**One nightly sweep applies every database period.** Ratifying a period decides
it; the nightly retention sweep (`backend/scripts/retention_sweep.py`, run by a
Railway cron service, #3266) deletes what has passed it. Where an operator sweep
already existed, its default window is now the ratified one (energy plans, the
journal purge), and the off-host dump's manual weekly prune now prunes at 30
days. The nightly sweep calls those same operator sweeps and applies every other
database period too. Nothing is deleted until the owner creates its cron service
(DEPLOYMENT.md, "Nightly retention sweep"). A store outside the database waits
for its prune or a vendor setting.

## What this is

The B08 retention registry (`backend/src/domain/retention.py`) and the store
inventory (`backend/src/domain/retention_stores.py`) list every place
Adepthood keeps data and how long it stays there. Some of those periods were
undecided: the registry marked them `ratified=False`, and the inventory gave an
`Unknown` deadline or a backup leg awaiting a decision. Each carried a proposal
for the owner to review. The tables below record what was ratified, how it
compares with the period before, and what happens today.

The values followed these rules:

- **The shortest period that still does the job.** No ratified period is longer
  than the one before. Two could not be compared (application logs, Fly
  snapshots), because today's vendor setting is not known.
- **The 97-day backup bound.** A backup copy can be up to retention plus one
  interval old: 90 + 7 days for the weekly off-host dump. Two kinds of record
  are restore tombstones, so they have to outlive that bound: a soft-deleted
  page and an erasure receipt. Without them, a restore would bring deleted data
  back with nothing to delete it again.
- **The shorter backup retention does not shorten the bound yet.** The off-host
  dump is now kept 30 days, but dumps kept under the 90-day retention still
  exist until they are pruned. The bound, the journal purge floor and the
  soft-deleted page's period therefore stay at 97 days while those copies are
  held. The code enforces this through `HELD_OFFHOST_DUMP_RETENTION_DAYS`: the
  floor is the larger of today's legs and the copies still held. Lowering it to
  37 days is a **second, later change**, made only once every 90-day-era dump
  has been pruned.
- **Some periods are conditional.** Open obligations (`pending_delete`,
  `unconfirmed`, `mirror_intent`, `pending`), unconfirmed teardowns and
  unfinished restores are never eligible. These exemptions are stored as data
  on the rule (`exempt_states`). The sale blanks two columns rather than
  deleting the receipt (`redact_columns`). The tests reject a sweeping rule
  that drops a condition its table requires.
- **How ratification was carried out.** For each row: the value was written
  into the rule or store, the proposal's conditions were copied onto the rule,
  `ratified` was set, the proposal was deleted, and this table was updated. The
  proposal machinery stays for the next undecided lifetime: the tests still
  reject an unratified rule without a proposal, a ratified rule that keeps one,
  and any code outside the two registries that reads a proposal.
  `PYTHONPATH=src python -m scripts.retention_report` prints the registry.

## Database tables

| Store | Data kind | Ratified period | Compared with before | Rationale | In force today |
| --- | --- | --- | --- | --- | --- |
| `journalentry (soft-deleted)` | Encrypted page, plus encrypted margin notes, promoted passages, suggestions and corpus fragments | 97 days after the soft delete (the backup bound) | shorter | It is kept only as the restore tombstone, so purge it once no live backup copy can still hold the page undeleted. That is the purge's own floor, and it falls only after copies kept under an older, longer retention have aged out. | The purge defaults to 97 days. Applied nightly by the retention sweep (`scripts.retention_sweep`, #3266) once its Railway cron service is created (DEPLOYMENT.md). A page whose essay withdrawal is unsettled is held and counted as blocked. |
| `journalwithdrawalobligation` | Content-free: ids, a closed state, an opaque vault fingerprint, timestamps | 30 days after the vault confirms. Confirmed rows only: `pending_delete` and `unconfirmed` rows are never eligible | shorter | An open row must outlive the vault copy it tracks. A confirmed row is only a receipt. | Applied nightly by the retention sweep (`scripts.retention_sweep`, #3266) once its Railway cron service is created (DEPLOYMENT.md). Open rows are held and counted as blocked. |
| `voicedraftretraction` | Content-free: ids, a closed state, a fingerprint | 30 days after the vault confirms. Confirmed rows only: `mirror_intent` and `pending` rows are never eligible | shorter | Same reasoning as journal pages. An unsettled row also blocks the purge. | Applied nightly by the retention sweep (`scripts.retention_sweep`, #3266) once its Railway cron service is created (DEPLOYMENT.md). Unsettled rows are held and counted as blocked. |
| `accountdeletionaudit` | Content-free: surrogate id, instant, row counts | 365 days after the receipt is created (at account deletion) | shorter | It names nobody. As the restore tombstone it must outlive the 97-day bound, and a year still answers a support or regulator question about whether an erasure ran. | Applied nightly by the retention sweep (`scripts.retention_sweep`, #3266) once its Railway cron service is created (DEPLOYMENT.md). |
| `gumroadsale` | Buyer email, Gumroad's raw payload, sale fields | 180 days after `anonymised_at`. At account deletion, `email` and `raw_payload` are blanked on every linked sale and the receipt is kept | shorter | See the note after this table. | Account deletion now blanks `email` and `raw_payload` on linked sales and stamps `anonymised_at`. Applied nightly by the retention sweep (`scripts.retention_sweep`, #3266) once its Railway cron service is created (DEPLOYMENT.md). A sale still named by a course grant or a licence binding is held and counted as blocked. A sale never linked to an account keeps its email and is never removed. |
| `loginattempt` | Typed email address, IP, success flag | 30 days after the attempt | shorter | The address and IP are personal data. Lockout reads only the last 15 minutes, and 30 days is common security-log practice for investigating credential stuffing. The same applies to addresses that never had an account. | Applied nightly by the retention sweep (`scripts.retention_sweep`, #3266) once its Railway cron service is created (DEPLOYMENT.md). Attempts against addresses with no account go too. |
| `llmusagelog` | Content-free: tokens, cost, model, entry link | 90 days after the metered call | shorter | This covers the 30-day cost-alert window plus reconciliation against two monthly provider invoices. Accepted side effect: the all-time admin totals become 90-day totals. | Applied nightly by the retention sweep (`scripts.retention_sweep`, #3266) once its Railway cron service is created (DEPLOYMENT.md). |
| `revokedtoken` | Opaque JWT id and its expiry | 1 day after the token's own expiry | shorter | Once a token has expired, decoding already rejects it on its expiry (`exp`) check, so the row protects nothing. One day absorbs clock skew. | Applied nightly by the retention sweep (`scripts.retention_sweep`, #3266) once its Railway cron service is created (DEPLOYMENT.md). |
| `practicesharelink` | Capability token and practice id, anonymised after its creator is deleted | 30 days after the link stops working (expired, revoked or used up) | shorter | A dead link serves no recipient. A live link with no expiry keeps working, because recipients may hold it, so it is kept. | Applied nightly by the retention sweep (`scripts.retention_sweep`, #3266) once its Railway cron service is created (DEPLOYMENT.md). A link used up but never expired or revoked has no recorded end, so it is held and counted as blocked until it expires or is revoked. |
| `energyplan` | A generated plan derived from the account's habits | 7 days after the plan is created | shorter | It is re-read to answer a retried request, and it is included in the owner's export. A week covers any retry. Older plans also leave the export; a plan is cheap to regenerate. | The operator sweep defaults to 7 days. Applied nightly by the retention sweep (`scripts.retention_sweep`, #3266) once its Railway cron service is created (DEPLOYMENT.md). |
| `vaultteardownreceipt` | Content-free: opaque Creek job id, teardown state | 90 days after teardown is confirmed. `deleting` and `failed` receipts are never eligible | shorter | It names no account. Once confirmed, it only needs reconciling against the vendor's invoices, which three billing cycles should cover. | Applied nightly by the retention sweep (`scripts.retention_sweep`, #3266) once its Railway cron service is created (DEPLOYMENT.md). Deleting and failed receipts are held and counted as blocked. |
| `restoremarker` | Content-free: operator restore id, state, counts | 365 days after the reapply completes. An `in_progress` marker is never eligible, and nor is one `RESTORE_ID` still names | shorter | It names no person. It refuses a second reapply after cutover, and that risk does not fade with time. | Applied nightly by the retention sweep (`scripts.retention_sweep`, #3266) once its Railway cron service is created (DEPLOYMENT.md). The marker `RESTORE_ID` names, and any `in_progress` one, are held and counted as blocked. |

**Payment records (`gumroadsale`).** The clock needed a timestamp the row did
not have. When an account is deleted, its licence link (the `LicenseBinding`
row) is erased with it, and nothing recorded when that happened. The ratified
period therefore came with a schema change, now built: an `anonymised_at`
column, stamped by account deletion on every sale linked to the account (its
licence binding or its token-pack credit), at the same moment `email` and
`raw_payload` are blanked.

**The trade-off.** After redaction, a returning buyer can no longer be matched
by address to the licence or pack they paid for. The licence key still
reclaims a licence, and a credited token pack stays credited.

The owner ratified this with three questions still to confirm:

- that 180 days covers typical refund and card-dispute windows (some dispute
  codes run longer);
- whether Gumroad's own record is enough for disputes;
- how long the amounts must be kept for bookkeeping (a legal question).

A sale never linked to an account keeps its email, because that is its only
claim path. It is never stamped, so its clock never starts.

## Stores outside the database

| Store | Data kind | Ratified period | Compared with before | Rationale | In force today |
| --- | --- | --- | --- | --- | --- |
| `railway_platform_backup` | Whole-database snapshot | 6 days (keep) | same | Daily, kept 6 days, is already Railway's shortest schedule, and it is the leg that recovers from everyday mistakes. | 6 days, if enabled. Enabling it is unverified (#3058). |
| `offhost_pg_dump` | Encrypted whole-database dump | 30 days | shorter | Four weekly copies still cover a month of late-found damage or platform loss. Transition: the purge floor stays at 97 days until every dump kept under the 90-day retention has aged out and been pruned. Only a later change lowers it, to 37. | The runbook's manual weekly prune now deletes dumps older than 30 days (DEPLOYMENT.md; where the off-host copies live is still undecided). Dumps kept under the 90-day retention may still exist until that prune has run at the off-host destination too. |
| `application_logs` | Content-free logs that name account ids | 30 days or the vendor's current setting, whichever is shorter | unknown | 30 days is common security-log practice. Today's vendor retention is unverified, so it cannot yet be called shorter. It may be 7 days on some plans, and then that shorter setting is kept. | Vendor defaults, unverified (#3064). The ratified period takes effect once the vendor setting is checked and applied. |
| `fly_volume_snapshots` | Snapshots of the managed vault volume | 1 day | unknown | The vault mirrors the journal, so a snapshot only needs to bridge a day. Set the vendor's minimum and destroy snapshots at teardown, subject to the AC19 vendor check. | The pilot keeps 7 days. Per-user volumes use the vendor default. Survival after the volume is destroyed is unverified (AC19). |
| `creek_vault_volume` | Mirrored entries and essays | no fixed period | same | Each copy is tied to an event, not a clock: it lives until its verified withdrawal, or the vault's teardown at account deletion. | As ratified. |
| `creek_embeddings_cache` | Vectors derived from entries | no fixed period | same | Event-bound: the vectors go when their entry's withdrawal is verified. | As ratified. |
| `creek_ledger` | Ingest ledger rows | no fixed period | same | Event-bound: the rows go when their entry's withdrawal is verified. | As ratified. |
| `client_device_cache` | On-device caches | no fixed period | same | Not ours to set. The device holds it, and it is wiped when another account signs in. | As ratified. |
| `manual_vaults` | A vault the user runs | no fixed period | same | Not ours to set. The user operates the vault and decides. | As ratified. |
| `model_vendor_copies` | Prompts and completions held by the provider | no fixed period | same | This is the vendor's period, not ours. Vendor fields are deferred to B11 (#3065). | Vendor retention, unestablished. |

## Not ratified: keeping an obligation after account deletion

An `unconfirmed` withdrawal record (`journalwithdrawalobligation`, and
`voicedraftretraction` while unsettled) must outlive the vault copy it tracks.
Today account deletion erases it, so afterwards nothing records that a copy may
remain. One option is to keep a detached, content-free form of the row after
erasure, until the vault confirms the copy is gone.

**That would keep data longer than today.** The registry would flag any such
proposal as `longer`. It was not a proposal, so the 2026-10-13 decision did not
ratify it, and it is not wired into the registry. It stays open for the owner
(#3063 AC21-22, #3094). See
[gdpr-erasure-unreachable-vaults.md](gdpr-erasure-unreachable-vaults.md).

## Still open

- **Creating the cron service (AC18, #3266).** The owner chose a nightly
  Railway cron service that runs the retention sweep. The sweep is built; the
  service is an owner step in `DEPLOYMENT.md` ("Nightly retention sweep").
- **Tombstone custody (AC17).** Where custody lives is undecided, so the
  restore runbook step in `DEPLOYMENT.md` stays a draft. The tombstone file's
  own retention follows from that decision.
- **Lowering the 97-day bound to 37 days.** A separate, later change, once
  every dump kept under the 90-day retention has been pruned.
- **A published retention schedule (AC16, B01).** The public copy still
  describes the backup schedule as it stood before; restating it is the
  owner's decision.
