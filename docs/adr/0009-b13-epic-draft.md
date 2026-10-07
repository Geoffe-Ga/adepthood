# Draft epic body for #3067 (B13), to be posted by the owner

> This is a draft. An agent wrote it from ADR 0009 for Geoff to post on
> [#3067](https://github.com/Geoffe-Ga/adepthood/issues/3067). It does not
> edit the issue, and nothing in it is a public claim.

---

# B13: Implement user-held journal keys, device- and vault-side inference, and BYOK-only cloud

**Priority:** P1 · **Size:** XL · **Status:** unblocked by the owner's
2026-10-07 decision. Each phase still has its own gates.

## Decision this implements

[ADR 0009](https://github.com/Geoffe-Ga/adepthood/blob/main/docs/adr/0009-privacy-custody-and-inference-architecture.md)
(`docs/adr/0009-privacy-custody-and-inference-architecture.md`), Accepted
2026-10-07, decider Geoff. It selects **Option BD**:

- The operator cannot read people's journal entries.
- Keys are user-held, with no operator escrow.
- Inference runs on the device first, then in the person's vault-local model
  (B05, Creek-Vault#1849) or a no-retention runtime we control.
- Cloud models are reached only with the person's own key (BYOK).
- BotMason credits pay for non-cloud inference only.
- Claims are scoped per platform. The guarantee is strongest on native apps.
  On web it rests on trusting the code we serve, mitigated by signed or
  pinned builds.

The alternative epic, #3068 (B14, attested confidential compute), is **not
selected**. Close it as not-planned, or keep it parked behind ADR 0009's
reopen triggers.

## Baseline this epic must invert

Two tests in `backend/tests/test_custody_decision_record.py` pin today's
custody structurally, over the in-scope journal columns in
`docs/adr/0009-architecture-scorecard.json` (`journal_scope_proposal`):

- `test_custody_codec_has_no_per_principal_key` checks that every in-scope
  column is still typed `EncryptedString` under a codec with no per-person
  key;
- `test_server_env_keys_alone_recover_every_in_scope_journal_column` shows,
  on a real database, that the env key alone recovers a canary from each
  column.

In detail: `encrypt(plaintext)` and `decrypt(value)` take no
per-person key, and `JOURNAL_ENCRYPTION_KEYS` on the server decrypts all 18
`EncryptedString` columns (B02's `test_every_encrypted_column_stores_ciphertext`).
Both tests **fail by design** when phase (c) moves a journal column to
client-held ciphertext. Invert them in the same PR, and update ADR 0009's
Context section there too.

## Phases (each shippable on its own)

### (a) BYOK-only cloud plus non-cloud credits. Composes with #3096.

- Remove the server `LLM_API_KEY` fallback in
  `services/botmason.py::resolve_chat_api_key` for any request carrying a
  person's content.
- **Move BYOK client-side.** The device calls the vendor directly with the
  person's key. Retire the `X-LLM-API-Key` header and the server-side BYOK
  call. Today BYOK is server-proxied, so the server sees the key and the
  plaintext on every BYOK call; that is a known gap this phase closes. Where
  a browser cannot reach a vendor directly, the feature is unavailable on web
  rather than relayed.
- Credits route only to the vault-local model or a no-retention runtime we
  control. Without credits or BYOK, refuse, with no fallback.
- Every receipt names payer and location (B07 provenance).
- **Exit tests:** a provider-factory and socket spy records zero cloud calls
  without BYOK across chat, marginalia, essays, completion detection,
  classification and transcription. A credit debit appears only beside a
  non-cloud receipt. A BYOK request recorded at our server carries no
  synthetic canary and no `X-LLM-API-Key` header.
- **Owed:** the privacy and vendor-terms review, and B01 copy, before the
  promise changes.

### (b) Client key generation and encrypted-sync envelope

- Device-generated keys.
- An AEAD envelope bound to owner, object type, object id and version, with
  rollback defence.
- A ciphertext column and version on each in-scope table.
- Enrolled accounts write ciphertext only, autosave included.
- **Gates:** D02 primitives and envelope, D03 recovery, reset and pairing
  (open owner questions), and an independent cryptography review **before
  any real account enrols**.
- **Exit tests:**
  - With a DB dump, env keys and logs, a hostile server recovers zero
    synthetic canaries.
  - A swapped-row or cross-account ciphertext fails to open.
  - A replayed old version is refused.
  - Autosave request bodies carry no canary.
  - Tampered ciphertext, an AAD mismatch, a truncated nonce and a downgraded
    version all fail closed.

### (c) Migration and plaintext retirement

- Enrolment re-encrypts history on the device. Then the server-key
  ciphertext and the `DERIVED_FROM_PROSE` plaintext are deleted.
- Creek copies are withdrawn with destination-bound receipts (B04, #3095).
  Backups expire on B08's schedule (#3063).
- There is no plaintext dual-write after enrolment.
- After the last in-scope account migrates, or on the owner's retirement
  date, retire `JOURNAL_ENCRYPTION_KEYS` for journal content.
- **Gates:** the independent appsec hostile-admin review, and B08 retention
  values.
- **Exit tests:**
  - No legacy copy remains for a migrated account.
  - The downgrade path refuses to restore operator-held keys.
  - Server export of protected rows yields ciphertext only.

### (d) Server features that need plaintext move to the device or vault

- Move each feature on its own: owner search (local index), resonance and
  marginalia, essays, completion detection, corpus and frequency
  classification, and transcription.
- Until a feature moves, it refuses protected content before any provider or
  client is constructed.
- **Gates:** B09 device and vault capability measurements, B05's local model,
  and Creek maintainer review.
- **Exit tests:**
  - With egress denied, a moved feature runs and dials nothing external.
  - Unsupported devices get an honest "not available", never a cloud
    fallback.

## Open owner questions (from ADR 0009; not decided here)

- **D03:** recovery factors, lost device, pairing, revocation, double loss,
  death or incapacity, malicious support requests, shared devices and offline
  export.
- **RUNTIME:** is credit-funded inference on a runtime we control, or on an
  ordinary-Fly vault, compatible with the premise? How is it labelled?
- **WEB-ANCHOR:** which signed or pinned web delivery mechanism, and whether
  web may enrol before it ships.
- **SCOPE:** which encrypted columns are journal content (practice
  reflections, prompt responses, feedback, the vault credential).
- **MIGRATION:** opt-in or required, the retirement date, dormant accounts,
  and backup expiry.
- **FEATURE-LOSS:** what enrolled accounts are told before phase (d).
- **D02-PRIMITIVES:** primitives, envelope format and library.
- **NATIVE:** whether and when to ship native apps (store and signing
  accounts).
- **BYOK-WEB:** whether a provider key may sit in localStorage on web.
- **BYOK-CONSENT:** a proposal only. Is BYOK consent granted per key, per
  feature, or per call?
- **INTIMATE-DEVICE:** whether device-side inference may ever process
  INTIMATE. ADR 0002 Decision 1 is unchanged; INTIMATE stays skip-only for
  remote inference.
- **BUDGET:** USD per active account-month and staffing per phase. Unknown.
- **REVIEWERS:** who the four owed reviewers are.

## Dependencies

- B03 (lineage and taint), B04 (Creek withdrawal), B08 (backups and
  retention).
- B09 then B05 (local model).
- B10 (content-free observability), B15 (regression-suite home).
- B01 (copy).
- B24 (#3076) is the release gate. **No public claim is unlocked by any
  phase until B24 certifies it, per platform.**

## Non-goals

- Server key escrow.
- Transparent recovery by support.
- Unqualified future-capture immunity in a mutable web client.
- Attested confidential compute (B14).
