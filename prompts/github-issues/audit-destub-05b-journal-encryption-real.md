# audit-destub-05b: Implement real journal encryption at rest

**Labels:** `audit-destub`, `backend`, `security`, `priority-medium`
**Epic:** De-Stub: Make Aspirational Features Real
**Depends on:** audit-destub-05 (removed the hollow flag)
**Estimated LoC:** ~500 (hard cap 700)

## Role

You are a backend engineer implementing column-level encryption at rest for journal content, properly — with key management, not a half-wired flag.

## Goal

`JournalEntry.message` (and any other sensitive free-text columns) are encrypted before the DB write and decrypted on read, with a real, rotatable key. Setting the feature on must deliver the guarantee it advertises — the failure mode that motivated audit-destub-05, where a flag read as a shippable guarantee but stored plaintext, must not recur.

## Context

audit-destub-05 deleted the misleading `ENCRYPTION_AT_REST_ENABLED` flag and its docstring claim because no encrypt/decrypt hooks existed and `message` was stored as plaintext regardless. This issue does the capability for real. It is the actionable form of the long-standing umbrella issue #219.

## Scope

**Covers:**
- A Fernet (or envelope-encryption) encrypt-on-write / decrypt-on-read layer for `JournalEntry.message`, applied transparently at the model/repository boundary so call sites don't each remember to encrypt.
- Key provisioning from a secret (env/KMS), with **key rotation** support (multi-key decrypt, single-key encrypt) so a compromised key can be retired without downtime.
- A reversible migration to encrypt existing plaintext rows (and a documented rollback).
- Tests: round-trip encrypt/decrypt, rotation (old-key rows still readable), and that ciphertext (not plaintext) is what lands in the column.

**Does NOT cover:** encrypting non-journal tables, full-disk encryption (an ops concern), or search-over-ciphertext.

## Acceptance Criteria

- [ ] `message` is stored as ciphertext; a raw DB read never returns plaintext.
- [ ] Decryption is transparent on read; existing API responses are unchanged.
- [ ] Key rotation is supported (decrypt with any active key, encrypt with the current one).
- [ ] A migration encrypts pre-existing rows and is reversible.
- [ ] Enabling/disabling is honest: if a key is missing the app fails fast rather than silently storing plaintext.
- [ ] Coverage ≥ 90%; all pre-commit hooks pass.

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/services/journal_encryption.py` | Create (Fernet/envelope encrypt-decrypt + key registry) |
| `backend/src/models/journal_entry.py` | Modify (encrypt-on-write / decrypt-on-read boundary) |
| `backend/alembic/versions/<rev>_encrypt_journal_messages.py` | Create (reversible row migration) |
| `backend/tests/services/test_journal_encryption.py` | Create (round-trip + rotation + ciphertext-at-rest) |
