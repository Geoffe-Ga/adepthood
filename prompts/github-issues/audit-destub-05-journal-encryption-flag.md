# audit-destub-05: Remove the hollow journal encryption flag

**Labels:** `audit-destub`, `backend`, `security`, `priority-high`
**Epic:** De-Stub: Make Aspirational Features Real
**Estimated LoC:** ~120  (hard cap 700)

## Problem
`backend/src/models/journal_entry.py:12-18` defines `ENCRYPTION_AT_REST_ENABLED` (read from
`JOURNAL_ENCRYPT_AT_REST`) and a docstring claiming "`message` is encrypted before DB write and
decrypted on read using Fernet symmetric encryption." No encrypt/decrypt hooks exist anywhere —
the flag is read but used nowhere, and `message` is stored as plaintext regardless. This is a
**hollow security contract**: an operator who sets the env var believes journal entries are
encrypted at rest when they are not.
**Current state:** §5.1 class **fake** (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md` §6, row 5; §2 item).
The flag is dangerous precisely *because* it reads as a real, shippable guarantee but delivers
none.

## Chosen path (single, zero-question)
**Remove the hollow flag now.** Real Fernet column-encryption is a larger, key-management-heavy
piece of work (key rotation via KMS, migration of existing rows, decrypt-on-read everywhere); doing
it half-way is what created this defect. This issue **deletes** the misleading flag and docstring so
the codebase stops advertising a guarantee it does not keep, and **files a separate issue**
(`audit-destub-05b`, "Implement real journal encryption at rest") to do encryption properly behind
GitHub issue #219. Do **not** implement Fernet in this issue.

## Scope
**Covers:** deleting `ENCRYPTION_AT_REST_ENABLED` and the encryption claims in the
`JournalEntry`-module docstring, confirming nothing references the constant, and filing the
follow-up. **Does NOT cover:** implementing any encryption, schema changes, or migrations.

## Tasks
1. **Confirm zero references** — grep the backend for `ENCRYPTION_AT_REST_ENABLED` and
   `JOURNAL_ENCRYPT_AT_REST`; confirm the constant is read nowhere except its own definition. TDD:
   a test (or the grep evidence in the PR) asserting no production code path branches on the flag.
2. **Remove the flag + claim** — delete lines `12-18` (the comment block + the
   `ENCRYPTION_AT_REST_ENABLED` assignment) in `models/journal_entry.py`, and strip any docstring
   sentence that claims `message` is encrypted/decrypted. Leave a one-line pointer to the real
   follow-up issue instead of the false claim.
3. **File the follow-up** — create `audit-destub-05b` (real Fernet at-rest encryption, key
   rotation, row migration) so the capability is tracked, not lost.

## Acceptance Criteria
- [ ] `ENCRYPTION_AT_REST_ENABLED` and the "encrypted before DB write / decrypted on read"
      docstring claim are gone from `models/journal_entry.py`.
- [ ] No production code references the removed constant (grep-clean).
- [ ] A follow-up issue for real at-rest encryption exists and is linked from the module.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on --all-files.

## Files to Create/Modify
| File | Action |
|------|--------|
| `backend/src/models/journal_entry.py` | Modify (remove flag + misleading docstring) |
| `prompts/github-issues/audit-destub-05b-journal-encryption-real.md` | Create (follow-up issue) |
