# Draft epic body for #3067 (B13), to be posted by the owner

> This is a draft. An agent wrote it from ADR 0009 for Geoff to post on
> [#3067](https://github.com/Geoffe-Ga/adepthood/issues/3067). It does not
> edit the issue, and nothing in it is a public claim.

---

# B13: Implement user-held journal keys, device- and vault-side inference, and BYOK-only cloud

**Priority:** P1 · **Size:** XL · **Status:** unblocked by the owner's
2026-10-07 decision and follow-up answers. Each phase still has its own gates.

## Decision this implements

[ADR 0009](https://github.com/Geoffe-Ga/adepthood/blob/main/docs/adr/0009-privacy-custody-and-inference-architecture.md)
(`docs/adr/0009-privacy-custody-and-inference-architecture.md`), Accepted
2026-10-07, decider Geoff. It selects **Option BD**:

- **Target: the operator will not be able to decrypt stored journal
  content.** The target covers stored content and the BYOK and device
  inference paths, once this epic's phases land. Today the server holds the
  keys.
  - A passive thief of the database, backups or host storage is to get
    ciphertext only.
  - Against the operator or the update channel, for stored history and
    future content alike: on web, protection rests on trusting the code we
    serve until signed builds ship. On native, it holds only while the signed
    build is honest.
  - Until phase (a), BYOK is relayed through our server, and without BYOK
    the app's own key pays.
- **Keys are user-held, with no operator escrow.**
  - Recovery is a written-down recovery phrase plus the person's passphrase.
  - Losing both means the data is gone, and the person agrees to that up
    front.
- **Cloud models are reached only with the person's own key (BYOK)**, called
  from the device straight to the vendor.
- **BotMason credits pay only for the vault-local model (B05,
  Creek-Vault#1849) or a managed no-retention runtime.**
  - Every managed-runtime use is labelled ("processed on Adepthood's private
    server, not stored").
  - Processing there is **not operator-blind while it runs**.
- **Web first; native later.**
  - Web protection is an enforced CSP plus SRI now, with signed builds later.
  - Web accounts may not enrol until CSP plus SRI is live.
- **Enrolment is opt-in for everyone, for now.**
- **Scope:**
  - In: journal entries and titles, reflections, practice reflections,
    prompt responses, and their corpus, suggestion and quote derivatives.
  - Out: feedback and the stored vault API key.
  - The exact columns are `journal_scope_proposal` in
    `docs/adr/0009-architecture-scorecard.json`.
- **The BYOK provider key is kept encrypted under the user-held key** once an
  account enrols.
- **Proposed primitives, not final:** libsodium sealed boxes and
  XChaCha20-Poly1305. The cryptography reviewer confirms them.

**Consequence:** with opt-in enrolment, no web enrolment before CSP plus SRI,
and native later, **nobody can enrol until the CSP and SRI work ships**.
Phase (b) therefore starts with it.

The alternative epic, #3068 (B14, attested confidential compute), is **not
selected**. Close it as not-planned, or keep it parked behind ADR 0009's
reopen triggers.

## Baseline this epic must invert

Two tests in `backend/tests/test_custody_decision_record.py` pin today's
custody structurally, over the in-scope columns of `journal_scope_proposal`:

- `test_custody_codec_has_no_per_principal_key` checks that every in-scope
  column is still typed `EncryptedString` under a codec with no per-person
  key;
- `test_server_env_keys_alone_recover_every_in_scope_journal_column` shows,
  on a real database, that `JOURNAL_ENCRYPTION_KEYS` alone recovers a canary
  from each column.

Both **fail by design** when phase (c) moves a journal column to client-held
ciphertext. Invert them in the same PR, and update ADR 0009's Context section
there too.

## Phases (each shippable on its own)

### (a) BYOK-only cloud plus non-cloud credits. Ship now; composes with #3096.

- Remove the server `LLM_API_KEY` fallback in
  `services/botmason.py::resolve_chat_api_key` for any request carrying a
  person's content.
- **Move BYOK client-side.** The device calls the vendor directly with the
  person's key. Retire the `X-LLM-API-Key` header and the server-side BYOK
  call.
  - Today BYOK is server-proxied, so the server sees the key and the
    plaintext on every BYOK call. That is a known gap this phase closes.
  - Where a browser cannot reach a vendor directly, the feature is
    unavailable on web rather than relayed.
- Credits route only to the vault-local model or the managed no-retention
  runtime. **Each managed-runtime use carries its label.** Without credits or
  BYOK, refuse, with no fallback.
- Every receipt names payer and location (B07 provenance).
- Tell people plainly about the cloud AI they lose without BYOK.
- **Exit tests:**
  - A provider-factory and socket spy records zero cloud calls without BYOK
    across chat, marginalia, essays, completion detection, classification
    and transcription.
  - A credit debit appears only beside a non-cloud receipt.
  - A BYOK request recorded at our server carries no synthetic canary and no
    `X-LLM-API-Key` header.
  - Every managed-runtime response reaches the person with its label.
- **Owed:** the privacy and vendor-terms review, and B01 copy, before the
  promise changes.

### (b) Web protection first, then client keys and the encrypted-sync envelope

- **First slice: enforce the CSP and add SRI.**
  - Move `frontend/nginx.conf` from `Content-Security-Policy-Report-Only` to
    an enforced CSP, and add SRI to the served bundles.
  - Rewrite `test_custody_adr_names_enforcement_that_exists` in the same
    change.
  - Nothing can enrol before this ships.
- **Then:**
  - Device-generated keys.
  - An AEAD envelope bound to owner, object type, object id and version,
    with rollback defence, using the proposed primitives.
  - The data key wrapped under both the passphrase and the recovery phrase.
  - A ciphertext column and version on each in-scope table.
  - Enrolled accounts write ciphertext only, autosave included, and keep
    their BYOK key encrypted under the user-held key.
- **Gates:**
  - The cryptography reviewer confirms primitives and envelope before any
    real account enrols.
  - Pairing and revocation (open under D03) must be answered before
    multi-device sync ships.
- **Exit tests:**
  - With a DB dump, env keys and logs, a hostile server recovers zero
    synthetic canaries.
  - A swapped-row or cross-account ciphertext fails to open.
  - A replayed old version is refused.
  - Autosave request bodies carry no canary.
  - Tampered ciphertext, an AAD mismatch, a truncated nonce and a downgraded
    version all fail closed.

### (c) Migration and plaintext retirement (opt-in)

- Enrolment re-encrypts history on the device. Then the server-key
  ciphertext, the `DERIVED_FROM_PROSE` plaintext and the completion detection
  output (`completed_units`, `completed_on`) are deleted, except values the
  owner keeps readable.
- Creek copies are withdrawn with destination-bound receipts (B04, #3095).
  Backups expire on B08's schedule (#3063).
- There is no plaintext dual-write after enrolment.
- The retirement date for `JOURNAL_ENCRYPTION_KEYS` on journal content is
  still open.
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

- **D03:** pairing, revocation, death or incapacity, malicious support
  requests, shared devices and offline export.
- **MIGRATION-RETIREMENT:** the retirement date for server-held keys, dormant
  accounts, backup expiry values, and the protected label's timing.
- **D02-PRIMITIVES:** reviewer confirmation of the proposed primitives, and
  the envelope format.
- **BYOK-CONSENT:** a proposal only. Is consent granted per key, per feature,
  or per call?
- **INTIMATE-DEVICE:** may device-side inference ever process INTIMATE? ADR
  0002 Decision 1 is unchanged.
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
- Immunity from the operator or update channel, for stored or future
  content, in a mutable web client.
- Attested confidential compute (B14).
