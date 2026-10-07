# ADR 0009: Privacy custody and inference architecture

- **Status:** Accepted
- **Decider:** Geoff
- **Decided on:** 2026-10-07
- **Issue:** [#3066](https://github.com/Geoffe-Ga/adepthood/issues/3066)
  (decision D02, with D03 and D05 recorded as owner questions below)
- **Implementation epic:** [#3067](https://github.com/Geoffe-Ga/adepthood/issues/3067)
  (B13); the alternative [#3068](https://github.com/Geoffe-Ga/adepthood/issues/3068)
  (B14) is not selected
- **Release gate:** [#3076](https://github.com/Geoffe-Ga/adepthood/issues/3076)
  (B24). This record unlocks no public claim.
- **Amends:** [ADR 0002](0002-intimate-content-local-routing.md) Decisions 2-4
  and [ADR 0007](0007-demand-provisioned-confidential-vaults.md) Decisions 4
  and 6, plus Creek-Vault ADR 0005, Creek-Vault ADR 0006 and Creek-Vault ADR
  0007. **Supersedes** Creek-Vault ADR 0014 for journal content only.
- **Machine-readable twin:** [`0009-architecture-scorecard.json`](0009-architecture-scorecard.json),
  validated by `backend/tests/test_custody_decision_record.py`.
- **Who decided what.** Geoff made this decision on 2026-10-07. An agent cannot
  ratify a privacy posture, and none did: an agent wrote down the owner's
  decision, scored the options and drafted the plan. Wherever this record and
  the owner's decision text disagree, the owner's text governs. Budgets,
  staffing, reviewers and the D03 recovery semantics are still open. They are
  listed as open questions and are not answered here.

## Context

Measured on branch `w34/B12` (main plus wave 34d), 2026-10-07:

- **The server holds every key.** `backend/src/services/journal_encryption.py`
  reads its MultiFernet keys from the env var `JOURNAL_ENCRYPTION_KEYS`
  (`KEYS_ENV_VAR`). `EncryptedString` encrypts on write and decrypts on
  every ORM read in the server process. `encrypt(plaintext)` and
  `decrypt(value)` take no per-person key. The guard
  `test_custody_codec_has_no_per_principal_key` holds that baseline, and it
  is built to fail when B13 lands user-held keys.
- **That covers 18 columns across 10 tables.** The count comes from
  `services/encryption_inventory.py::encrypted_columns()`. The comment in
  `models/_prose_repr.py`, "13 across 8 tables", is stale. B02's raw canary
  `test_every_encrypted_column_stores_ciphertext` proves that the env keys
  alone recover every one of them. `test_the_pinned_inventory_is_exactly_what_the_schema_encrypts`
  and `test_every_encrypted_table_has_a_row_factory` keep that parametrization
  from shrinking. The columns are:
  `completionsuggestion.anchor_text`, `completionsuggestion.label`,
  `corpusfragment.content`, `feedbacknote.body`, `feedbackreport.actual`,
  `feedbackreport.expected`, `feedbackreport.intent`,
  `feedbackreport.summary`, `journalentry.message`, `journalentry.title`,
  `marginalia.anchor_text`, `marginalia.essay`, `marginalia.note`,
  `practicesession.insight`, `practicesession.reflection`,
  `promotedquote.anchor_text`, `promptresponse.response`,
  `uservaultconfig.api_key`.
- **Content-derived plaintext sits beside them.** The `DERIVED_FROM_PROSE`
  group of `_PLAINTEXT_COLUMNS` in `backend/tests/test_column_classification.py`
  lists the columns that hold it: embeddings, frequency weights and detected
  facts.
- **Server AI reads plaintext.** `services/botmason.py::resolve_chat_api_key`
  uses the person's own key (BYOK) when one is sent, and otherwise **the
  server's own `LLM_API_KEY`**. BotMason credits therefore pay for cloud calls
  made with the app's key. The following all run server-side on decrypted
  prose: corpus ingest and classification, frequency classification,
  marginalia and essays, completion detection, transcription, and
  `services/creek_vault_reflect.py`.
- **The web build is the only client that ships** (see the `APP_BASE_URL` row
  in `DEPLOYMENT.md`). The operator's nginx serves it, and
  `frontend/nginx.conf` sends `Content-Security-Policy-Report-Only`, which
  reports and does not enforce. Native targets are configured in
  `frontend/app.json` and `frontend/eas.json` but are not shipped. On web,
  `frontend/src/storage/secureStringStore.ts` keeps secrets in localStorage.
- **Ordinary-Fly vaults are operator-readable by ratified decision.**
  Creek-Vault ADR 0014 and [ADR 0007](0007-demand-provisioned-confidential-vaults.md)
  Decision 4 both say so, and in the words this record keeps wherever the
  status quo is described, provider-managed custody is not operator-blind.

The issue's draft recommendation was "A for the beta, with B+D as a
feasibility track". **The owner rejected it** on 2026-10-07 and asked for the
hard line to start now rather than as a deferral after the beta.

## Decision

**Selected: Option BD**: user-held keys (B) plus device-side and
vault-local inference (D), with BYOK cloud as an explicit opt-in.

1. **The operator cannot read people's journal entries.** This premise
   governs. It covers stored journal content and every prose derivative of
   it. The derivatives are the journal-derived `EncryptedString` columns
   above and the `DERIVED_FROM_PROSE` plaintext. Which non-journal columns
   fall inside the premise is open question SCOPE.
2. **Keys are user-held, with no operator escrow.** Keys are generated on the
   person's device. The server stores ciphertext and public parameters only.
   No operator-held decrypt capability exists in the protected path, and
   there is no operator-assisted recovery. It follows directly that **an
   account or password reset cannot recover the data key**. Every other
   recovery, pairing and revocation semantic belongs to D03, which is still
   open.
3. **Cloud models are used only with the person's own key.** Anthropic,
   OpenAI and any other cloud model are reached only when the person adds
   their own key in Settings (BYOK). Without such a key, **none of their
   data reaches a cloud model**. How finely BYOK consent is granted (per key,
   per feature or per call) is not decided; see open question BYOK-CONSENT. The app's own cloud key never carries a person's journal
   content.

   **BYOK calls go from the person's device straight to the vendor.** This
   follows directly from the premise. If the server relayed a BYOK call, it
   would see the plaintext it forwards. So the person's key and the content
   of a BYOK call never pass through our server.

   **Known gap until phase (a) lands:** today the client sends the person's
   key to our backend in the `X-LLM-API-Key` header
   (`frontend/src/api/index.ts`). The server then calls the vendor itself
   (`services/botmason.py::resolve_chat_api_key`), so it sees both the key
   and the plaintext on every BYOK call.
4. **BotMason credits pay for non-cloud inference only.** That means the
   vault-local model (B05, [Creek-Vault#1849](https://github.com/Geoffe-Ga/Creek-Vault/issues/1849))
   or a no-retention runtime we control. Credits never pay for a call made
   with the app's cloud key. See "BotMason credits" below.
5. **The web caveat is stated per platform.** User-held keys apply on every
   platform. The guarantee is strongest on native apps. On web it rests on
   trusting the code we serve, mitigated by signed or pinned builds. Public
   claims are scoped per platform (see "Per-platform claim scoping").
6. **Nothing is claimed yet.** This record approves an architecture. It
   unlocks no public privacy claim, and every claim still passes B24
   ([#3076](https://github.com/Geoffe-Ga/adepthood/issues/3076)).

## Threat actors

Each cell says whether the actor can recover **stored** journal prose under
the option once that option's gates have passed. An actor who controls the
code the person runs can capture the user-held key, so for that actor stored
history and future content stand or fall together.

| Actor | status_quo | A | B | C | D | E | BD (selected) |
|---|---|---|---|---|---|---|---|
| Database thief (no env keys) | blocked | blocked | blocked | blocked | blocked | blocked | blocked |
| Backup holder (with env keys) | reads | reads | blocked | blocked | blocked | reads | blocked |
| Privileged operator | reads | reads | blocked on native while the signed build is honest; on web, reads through a served bundle until WEB-ANCHOR ships | blocked\* | same as B | reads | blocked on native while the signed build is honest; **on web, reads all stored history through a served bundle until WEB-ANCHOR ships**; sees runtime-we-control inputs while they run |
| Hosting provider (Fly, DB host) | reads | reads | blocked | blocked\* | blocked | reads | blocked for storage; same runtime caveat |
| Malicious or compelled client update | reads | reads | reads all stored history (captured key); harder on signed native | reads on web | reads all stored history (captured key); harder on signed native | reads | reads all stored history once the key is captured: on web until signed or pinned builds ship, on native through a malicious signed build |
| XSS in the web client | reads | reads | reads open sessions | reads open sessions | reads open sessions | reads | reads open sessions; CSP enforcement narrows it |
| Compromised device | reads | reads | reads | reads | reads | reads | reads |
| Our server relaying a BYOK call | reads (relays today) | reads | blocked once BYOK is client-direct | blocked once BYOK is client-direct | blocked once BYOK is client-direct | reads | **reads today** (server-proxied BYOK, a known gap); blocked once phase (a) makes BYOK client-direct |
| Subpoena to the operator (stored data) | reads | reads | ciphertext only | ciphertext only | nothing | reads | ciphertext and metadata only |
| Malicious support request | reads | reads | cannot help | cannot help | cannot help | reads | cannot help (no escrow); D03 governs what support may do |

\* only under C's hardware threat model, once D05 has been proven.

## Options

### Option status_quo

*HEAD today.*

- **Boundary:** The Adepthood server process, its database and backups, Creek on ordinary Fly, and every configured model vendor all see plaintext; provider-managed custody is not operator-blind. (`repo:backend/src/services/journal_encryption.py::KEYS_ENV_VAR`)
- **Key custody:** Server env var JOURNAL_ENCRYPTION_KEYS holds every key; EncryptedString decrypts on every ORM read. No per-person key exists. (`repo:backend/tests/test_custody_decision_record.py::test_custody_codec_has_no_per_principal_key`)
- **Recovery:** Operator restores from backup with the env keys; password reset restores full access. (`repo:backend/src/services/journal_encryption.py::KEYS_ENV_VAR`)
- **Metadata leakage:** Everything: content, sizes, timestamps, counts, tiers, ids, network metadata. (`repo:backend/tests/test_column_classification.py::_PLAINTEXT_COLUMNS`)
- **Inference location:** Server-side cloud calls paid by the app's own LLM_API_KEY unless the person supplies a key; Creek reflection when a vault is bound. (`repo:backend/src/services/botmason.py::resolve_chat_api_key`)
- **Supported platforms:** Web only ships; native is configured but unshipped. (`repo:DEPLOYMENT.md`)
- **Client delivery and update trust:** Operator-served web bundle with a report-only CSP; a modified bundle is undetectable to the person. (`repo:frontend/nginx.conf`)
- **Primary-copy and derivative removal:** Nothing removed: 18 EncryptedString columns across 10 tables, DERIVED_FROM_PROSE plaintext, backups, Creek copies and vendor copies all persist under operator control. (`repo:backend/src/services/encryption_inventory.py::encrypted_columns`)
- **Threat actors:** Defends a database or backup thief only while the env keys stay separate; nothing against operator, host, compelled update, subpoena or support pressure. (`repo:backend/tests/test_journal_text_at_rest.py::test_every_encrypted_column_stores_ciphertext`)
- **Budget (USD per active account-month):** **unknown; owner input required.**
- **Staffing:** **unknown; owner input required.**
- **Reopen triggers:** Not a selectable end state; the owner's premise rules it out. (`owner:2026-10-07`)

### Option A

*Operator-trusted encrypted service, truthfully disclosed.*

- **Boundary:** Same as HEAD, with copy that says the operator can read; provider-managed custody is not operator-blind. (`repo:docs/adr/0007-demand-provisioned-confidential-vaults.md`)
- **Key custody:** Server-held env keys, least privilege and audit; operator trust remains. (`repo:backend/src/services/journal_encryption.py::KEYS_ENV_VAR`)
- **Recovery:** Operator-assisted restore and ordinary password reset. (`repo:backend/src/services/journal_encryption.py::KEYS_ENV_VAR`)
- **Metadata leakage:** Content and all metadata are visible to the operator. (`repo:backend/tests/test_column_classification.py::_PLAINTEXT_COLUMNS`)
- **Inference location:** Server-side, under an explicit destination policy. (`repo:backend/src/services/botmason.py::resolve_chat_api_key`)
- **Supported platforms:** Web and any future native client equally. (`repo:DEPLOYMENT.md`)
- **Client delivery and update trust:** Not a decision input: the operator can already read stored data. (`repo:frontend/nginx.conf`)
- **Primary-copy and derivative removal:** None required; cleanup and honest copy only. (`repo:backend/src/services/encryption_inventory.py::encrypted_columns`)
- **Threat actors:** DB thief and backup holder only; privileged operator, host and subpoena all succeed. (`repo:backend/tests/test_journal_text_at_rest.py::test_every_encrypted_column_stores_ciphertext`)
- **Budget (USD per active account-month):** **unknown; owner input required.**
- **Staffing:** **unknown; owner input required.**
- **Reopen triggers:** Rejected by the owner on 2026-10-07: it contradicts the premise that the operator cannot read journal entries. (`owner:2026-10-07`)

### Option B

*User-held end-to-end encrypted journal.*

- **Boundary:** Stored prose is ciphertext the server cannot decrypt; the person's devices hold plaintext. (`issue:#3067`)
- **Key custody:** Keys generated on the person's device; no operator escrow; AEAD bound to owner, object and version. (`issue:#3067`)
- **Recovery:** **unknown; owner input required.** See D03 below.
- **Metadata leakage:** Sizes, timestamps, counts, object ids, tier labels and network metadata remain visible. (`repo:backend/tests/test_column_classification.py::_PLAINTEXT_COLUMNS`)
- **Inference location:** None on the server; any AI needs a separate location (D, a vault, or BYOK). (`repo:backend/src/services/botmason.py::resolve_chat_api_key`)
- **Supported platforms:** Native and web; web depends on trusting the served bundle. (`repo:DEPLOYMENT.md`)
- **Client delivery and update trust:** Native: store-signed builds. Web: operator-served code can exfiltrate keys unless signed or pinned delivery is built. (`repo:frontend/nginx.conf`)
- **Primary-copy and derivative removal:** Every server-readable copy must be re-encrypted client-side or deleted, including derived plaintext and backups. (`repo:backend/src/services/encryption_inventory.py::encrypted_columns`)
- **Threat actors:** Defeats DB thief, backup holder, host and stored-data subpoena. A malicious or compelled update (on web, any served bundle) captures the key and reads all stored history; a compromised device also succeeds. (`repo:backend/tests/test_journal_text_at_rest.py::test_every_encrypted_column_stores_ciphertext`)
- **Budget (USD per active account-month):** **unknown; owner input required.**
- **Staffing:** **unknown; owner input required.**
- **Reopen triggers:** Selected as half of BD; reopen if a key-non-possession prototype fails. (`owner:2026-10-07`)

### Option C

*Attested confidential storage and inference.*

- **Boundary:** Hardware-isolated runtime; the operator is excluded only if attestation and key release are proven on real hardware. (`creek-vault:creek-tools/docs/architecture/ADR/0006-enclave-attestation-trust-model.md`)
- **Key custody:** User-authorized key release into a measured enclave; no operator-reusable unlock material. (`creek-vault:creek-tools/docs/architecture/ADR/0005-confidential-volume-key-no-escrow.md`)
- **Recovery:** **unknown; owner input required.** See D03 below.
- **Metadata leakage:** Runtime metadata, sizes and timing remain visible to the host. (`creek-vault:creek-tools/docs/architecture/ADR/0014-provider-managed-custody-for-ordinary-fly.md`)
- **Inference location:** Remote, inside the attested enclave. (`creek-vault:creek-tools/docs/architecture/ADR/0006-enclave-attestation-trust-model.md`)
- **Supported platforms:** Any client that can verify attestation. (`issue:#3068`)
- **Client delivery and update trust:** Measured image plus verifier governance; client trust problem from B persists. (`creek-vault:creek-tools/docs/architecture/ADR/0006-enclave-attestation-trust-model.md`)
- **Primary-copy and derivative removal:** Same removal burden as B, plus the attestation chain. (`repo:backend/src/services/encryption_inventory.py::encrypted_columns`)
- **Threat actors:** Defeats host and operator under the hardware threat model; vendor flaws and compelled updates remain. (`creek-vault:creek-tools/docs/architecture/ADR/0006-enclave-attestation-trust-model.md`)
- **Budget (USD per active account-month):** **unknown; owner input required.**
- **Staffing:** **unknown; owner input required.**
- **Reopen triggers:** Reopen if confidential compute becomes a cheap way to give the runtime we control an operator-blind property. (`issue:#3068`)

### Option D

*Device-local storage and inference.*

- **Boundary:** Content never leaves the device when sync is off; with B it syncs as ciphertext. (`issue:#3067`)
- **Key custody:** OS keystore and a local encrypted database. (`repo:frontend/src/storage/secureStringStore.ts`)
- **Recovery:** **unknown; owner input required.** See D03 below.
- **Metadata leakage:** None to the server when unsynced; B's metadata when synced. (`issue:#3067`)
- **Inference location:** On the device, on capability-verified hardware only. (`issue:#1850`)
- **Supported platforms:** Capable native devices; web limited by browser runtime and storage. (`repo:frontend/eas.json`)
- **Client delivery and update trust:** Signed native builds; web has the same served-code problem as B. (`repo:frontend/nginx.conf`)
- **Primary-copy and derivative removal:** Does not by itself remove existing server copies; needs B's migration. (`repo:backend/src/services/encryption_inventory.py::encrypted_columns`)
- **Threat actors:** Defeats every remote passive actor for unsent content; a compromised device, and a malicious update that captures the key (and with it any synced history), still succeed. (`issue:#3067`)
- **Budget (USD per active account-month):** **unknown; owner input required.**
- **Staffing:** **unknown; owner input required.**
- **Reopen triggers:** Selected as half of BD; reopen if B09 finds no supported-device configuration. (`issue:#1850`)

### Option E

*Per-account managed vault with local inference, no operator blindness.*

- **Boundary:** Per-account Fly vault and the Adepthood server both see plaintext; provider-managed custody is not operator-blind. (`creek-vault:creek-tools/docs/architecture/ADR/0014-provider-managed-custody-for-ordinary-fly.md`)
- **Key custody:** Provider-managed keys; Fly supplies the unlock capability. (`creek-vault:creek-tools/docs/architecture/ADR/0014-provider-managed-custody-for-ordinary-fly.md`)
- **Recovery:** Provider backup and restore; no user-held guarantee. (`creek-vault:creek-tools/docs/architecture/ADR/0014-provider-managed-custody-for-ordinary-fly.md`)
- **Metadata leakage:** Content and metadata are visible to host and operator. (`creek-vault:creek-tools/docs/architecture/ADR/0014-provider-managed-custody-for-ordinary-fly.md`)
- **Inference location:** Vault-local model on ordinary Fly. (`issue:#1849`)
- **Supported platforms:** Any client. (`repo:docs/adr/0007-demand-provisioned-confidential-vaults.md`)
- **Client delivery and update trust:** Not a decision input: the operator can already read stored data. (`creek-vault:creek-tools/docs/architecture/ADR/0014-provider-managed-custody-for-ordinary-fly.md`)
- **Primary-copy and derivative removal:** Adds a copy; the Adepthood primary copy remains. (`repo:backend/src/services/creek_vault_withdraw.py`)
- **Threat actors:** Defeats external AI vendors only; operator, host and subpoena succeed. (`creek-vault:creek-tools/docs/architecture/ADR/0014-provider-managed-custody-for-ordinary-fly.md`)
- **Budget (USD per active account-month):** **unknown; owner input required.**
- **Staffing:** **unknown; owner input required.**
- **Reopen triggers:** Rejected as a custody model; its vault-local inference survives inside BD for consented, non-retained processing. (`owner:2026-10-07`)

### Option BD

*Selected: user-held keys plus device-side and vault-local inference, BYOK cloud as explicit opt-in.*

- **Boundary:** Stored journal content and its prose derivatives are ciphertext the operator cannot decrypt. Plaintext exists on the person's devices, in a vault they choose for inference, and at a cloud vendor only under their own key, sent from the device and never relayed by our server. (`owner:2026-10-07`)
- **Key custody:** User-held keys generated on the person's device; no operator escrow; the server stores ciphertext and public parameters only. (`owner:2026-10-07`)
- **Recovery:** **unknown; owner input required.** See D03 below.
- **Metadata leakage:** Sizes, timestamps, counts, object ids, tier labels, credit receipts and network metadata stay visible to the operator; content does not. (`repo:backend/tests/test_column_classification.py::_PLAINTEXT_COLUMNS`)
- **Inference location:** Device first; then the person's vault-local model or a no-retention runtime we control (paid by credits); cloud only with the person's own key, called from the device straight to the vendor. Today BYOK is server-proxied, a known gap until phase (a). (`owner:2026-10-07`)
- **Supported platforms:** Native apps carry the strongest guarantee; on web the guarantee rests on trusting the code we serve, mitigated by signed or pinned builds. (`owner:2026-10-07`)
- **Client delivery and update trust:** Native: store-signed builds. Web: an enforced CSP plus signed or pinned builds; the CSP is report-only today. (`repo:frontend/nginx.conf`)
- **Primary-copy and derivative removal:** All 18 EncryptedString columns that carry journal prose, DERIVED_FROM_PROSE plaintext, Creek copies, vendor copies and backups are re-encrypted client-side, withdrawn or expired before an account is labelled protected. (`repo:backend/src/services/encryption_inventory.py::encrypted_columns`)
- **Threat actors:** Defeats DB thief, backup holder, host-storage access and stored-data subpoena. Defeats the privileged operator only on native while the signed build is honest; on web the operator can capture the key through a served bundle and read all stored history until WEB-ANCHOR ships. A compromised device remains; runtime-we-control inference is not operator-blind while it runs; until phase (a) our server relays BYOK calls and sees their plaintext. (`repo:backend/src/services/botmason.py::resolve_chat_api_key`)
- **Budget (USD per active account-month):** **unknown; owner input required.**
- **Staffing:** **unknown; owner input required.**
- **Reopen triggers:** Key-non-possession prototype fails; no web anchor is buildable; D03 user testing shows unacceptable loss; B09 finds no supported non-cloud configuration. (`owner:2026-10-07`)
## Per-platform claim scoping

What may be said, after B13's gates **and** B24's certification. Nothing in
this table is claimable today.

There is no stored-versus-future split for the operator or the update
channel. Under BD one user-held key opens every stored envelope. A build that
captures that key can therefore decrypt the person's **whole stored history**
as well as anything written afterwards. The split that does hold is between
**passive** attackers (who only ever hold stored bytes) and **active**
attackers (who control the code the person runs).

| Platform | Passive: DB, backup or host-storage thief | Active: operator or update channel (stored history and future content alike) | Inference | What the claim rests on |
|---|---|---|---|---|
| Native iOS and Android (store-signed) | Ciphertext only | Protected **only while the signed build is honest**. A malicious or compelled signed build could capture the key and decrypt stored history and future content alike | Device-first; vault or credits runtime only with consent; cloud only with BYOK, device to vendor | OS keystore, store signing, and reproducible-build evidence once it exists |
| Web (served by us) | Ciphertext only | **Rests on trusting the code we serve**, for stored history and future content alike. A malicious or compelled bundle could capture the key at the next load and decrypt everything stored. This stays true until WEB-ANCHOR ships | Same routing as native, with browser runtime limits | Enforced CSP and signed or pinned builds (open question WEB-ANCHOR) |
| Person's own vault (self-hosted) | Theirs to protect | Theirs to protect | Vault-local model | The person's own machine |
| Managed vault on ordinary Fly | Ciphertext only for journal content, once B13 phases (b) and (c) land for the account | The same per-client caveat as the platform the person enrols from | Vault-local inference sees plaintext while it runs; this is not operator-blind (open question RUNTIME) | Creek's runtime plus Fly; provider-managed custody is not operator-blind for anything still stored in plaintext |

No platform may advertise "end-to-end" or "operator-blind" until B24
certifies that claim for that platform.

## Client delivery and update trust

- **Web today:** the operator serves the bundle on every page load.
  `frontend/nginx.conf` sends `Content-Security-Policy-Report-Only` at both
  locations, so the CSP reports violations but does not enforce them. Nothing
  out-of-band lets a person check the code they ran. Under BD this is the
  weakest link: a served bundle can capture the key and so read stored
  history as well as future content. That is why the web claim is scoped.
- **Mitigations to choose from (open question WEB-ANCHOR):** an enforced CSP
  with `script-src 'self'` and Subresource Integrity; a signed release
  manifest, verified by a pinned service worker or browser extension;
  reproducible builds with a public transparency log; or limiting protected
  enrolment to native. These options can be combined.
- **Native:** store-signed builds from `frontend/eas.json` profiles are not
  shipped today (open question NATIVE). Shipping them needs store and signing
  accounts, which means spend, and the owner decides that.
- **The BYOK key on web:** `secureStringStore.ts` falls back to localStorage,
  so script compromise can read a person's provider key (open question
  BYOK-WEB).

## Primary-copy and derivative removal

Every server-readable store that must reach "ciphertext under a user-held
key, withdrawn, or expired" before an account may be labelled protected:

1. **The 18 `EncryptedString` columns.** These are held by B02's inventory
   (`encrypted_columns()`) and pinned by
   `test_every_encrypted_column_stores_ciphertext`. The default proposal,
   pending open question SCOPE:
   - **Journal content, in scope:** `journalentry.*`, `marginalia.*`,
     `promotedquote.anchor_text`, `corpusfragment.content`,
     `completionsuggestion.*`, `promptresponse.response`,
     `practicesession.insight` and `practicesession.reflection`.
   - **Proposed out of scope:** `feedbacknote.body` and `feedbackreport.*`,
     which are written *to* the operator to be read, and
     `uservaultconfig.api_key`, a credential the server must present on the
     person's behalf.
2. **`DERIVED_FROM_PROSE` plaintext** (`_PLAINTEXT_COLUMNS`): embeddings,
   frequency weights and detected facts. These are never written by the
   server for a protected account. They are recomputed on the device or in
   the vault, or dropped.
3. **Backups and snapshots.** B08 ([#3063](https://github.com/Geoffe-Ga/adepthood/issues/3063))
   owns the store inventory and retention values. Its store inventory has
   not landed on this branch, so the list of non-database stores is still to
   be consumed from B08 when it merges. Backup expiry deadlines are open
   question MIGRATION.
4. **Creek copies.** These are withdrawn through B04's destination-bound
   machinery (`services/creek_vault_withdraw.py`, voice-draft retraction),
   which has landed. Creek-side deletion has to be idempotent and purge
   derived copies ([Creek-Vault#1854](https://github.com/Geoffe-Ga/Creek-Vault/issues/1854)).
5. **Vendor copies.** These are whatever already reached a model vendor,
   listed per recipient in `backend/src/privacy/recipients.py` (B11,
   [#3065](https://github.com/Geoffe-Ga/adepthood/issues/3065)). They cannot
   be recalled. They expire under each vendor's retention terms, which stay
   `UNVERIFIED` until the owner supplies receipts.
6. **Logs and telemetry.** These hold no content by design. B10
   ([#3064](https://github.com/Geoffe-Ga/adepthood/issues/3064)) owns the
   proof.

## Migration of existing server-readable data

The source inventories are B02 for encrypted columns and B08 for other
stores. This record consumes them and does not rebuild them.

- **Plaintext history.** Every existing row is ciphertext under
  `JOURNAL_ENCRYPTION_KEYS`, and that is server-readable. Enrolment runs on
  an authenticated device, which does the following:
  1. Downloads the rows, decrypted by the server one final time.
  2. Re-encrypts them under the person's key.
  3. Uploads the envelopes.
  4. Proves a round trip, using counts and AEAD verification and never
     content.

  The server then deletes the server-key ciphertext. The person can abort
  before the deletion. After it, the only path back is their own key.
- **Derived copies.** Corpus fragments, embeddings, weights, completion
  suggestions, marginalia and promoted quotes follow the same pass, or are
  dropped and recomputed client-side in phase (d).
- **Creek copies.** Each is withdrawn with a destination-bound receipt (B04).
  The account shows "withdrawal unconfirmed" until the receipt arrives
  (owner decision on B04 esc6, [#3095](https://github.com/Geoffe-Ga/adepthood/issues/3095)).
- **Backups.** Legacy backups expire on B08's schedule. The protected label
  either waits for that expiry or names the date it completes. Which of the
  two is open question MIGRATION.
- **No plaintext dual-write after enrolment.** From the moment an account
  enrols, every write for it is ciphertext, including autosave.
- **The irreversible part.** Key destruction and legacy deletion cannot be
  undone. Content the old system once saw cannot be "unseen", and no
  retroactive claim is made about it.

## BotMason credits

- **Today:** `resolve_chat_api_key` falls back to the server's
  `LLM_API_KEY`, so a credit-funded message reaches a cloud vendor on the
  app's account.
- **Decided:** credits fund **non-cloud** inference only. That means the
  person's vault-local model (B05) or a no-retention runtime we control. A
  BYOK call pays its own vendor and debits no credits. With neither credits
  routed to a non-cloud runtime nor BYOK, the request is **refused**, with no
  fallback to the app's cloud key. This composes with
  [#3096](https://github.com/Geoffe-Ga/adepthood/issues/3096) (B07: refuse
  without credits or BYOK) and with B07's inference provenance, so every
  receipt names who paid and where the call ran.
- **Honest limit.** A no-retention runtime we control still sees plaintext
  while it runs. The same holds for a vault-local model on an ordinary-Fly
  vault. Neither stores anything, but neither is operator-blind during
  processing. Open question RUNTIME asks whether that runtime must be
  attested, device-only, or labelled per use.
- **Until B05 ships a working local model**, a person without BYOK has no
  credit-funded inference. That is a feature loss, and it is disclosed rather
  than papered over.

## Recovery, reset and pairing (D03): open owner questions

The owner decided **no operator escrow**. One consequence follows and is
recorded as decided: account and password reset cannot recover a lost data
key. Nothing else here is decided. ADR 0002 Decision 4 and Creek-Vault ADR
0005 (a passphrase plus a one-time recovery key) are prior art, not a choice.

1. **Recovery factors.** Passphrase plus recovery key, device keys only, or
   another scheme. Who generates them, how often they are shown, and their
   format.
2. **Lost device.** Recovery from another paired device, from the recovery
   factor, or not at all.
3. **Pairing.** How a new device joins (out-of-band code, QR code, recovery
   factor), and how a wrong-account sync is refused.
4. **Revocation.** What a revoked device loses, and whether key rotation
   re-wraps everything.
5. **Double loss.** Whether permanent loss is accepted, and the exact
   consent shown at enrolment. User testing comes before adoption.
6. **Death or incapacity.** Whether there is any delegated access, and if
   so, with which user-held mechanism.
7. **Malicious support requests.** What support may and must not do when
   someone claims to be the account holder.
8. **Shared devices and offline export.** Local key lifetime, and how a
   person exports a decrypted copy.

## Confidential compute (D05)

D05 is not pursued. C is rejected for now (see below). It reopens only if
the RUNTIME question needs a runtime-we-control inference path that is
operator-blind. In that case D05's conditions apply in full: real hardware,
a vendor attestation chain, nonce freshness, user-authorized key release,
and a hostile-host lab. Creek-Vault ADR 0006's operator-provisioned trust
root is not evidence.

## Budget and staffing

**Unknown; owner input required.** No figure is recorded for any option or
phase. The scorecard's money cells are `{"status": "unknown",
"owner_input_required": true}`, and the guard refuses any value that does not
come from the owner. Fly list prices from the issue are planning inputs,
not a budget.

## Reviewers

None has been consulted yet. Four reviews are owed, each before a named phase
(scorecard `reviewers`):

- an independent cryptography and client-protocol reviewer, before phase
  (b) enrols any real account;
- an independent application-security reviewer for the hostile-admin test,
  before phase (c) retires the server-held keys;
- a privacy and vendor-terms reviewer, with B01 and B11, before phase (a)
  changes any user-facing promise;
- a Creek maintainer, before phase (d) moves a feature into the vault.

## Rejected alternatives

- **The status quo:** the operator reads every entry, which contradicts the
  premise.
- **A (operator-trusted, truthfully disclosed):** honest but operator-
  readable. The dossier's "A for beta" was rejected by the owner.
- **C (attested confidential compute):** it needs vendor hardware, spend and
  a real attestation spike, and the stored-data guarantee does not need it.
  It is kept only as a reopen trigger.
- **E (managed vault, no operator blindness):** provider-managed custody is
  not operator-blind. Only its vault-local inference survives, inside BD and
  under the RUNTIME question.

B and D are not rejected. Together they are the selection.

## Implementation plan

Four phases. Each can ship by itself and leaves the product more private than
it found it. Each lists its own exit tests. None starts crypto before its
review gate.

### Phase (a): BYOK-only cloud plus non-cloud credits

Remove the server `LLM_API_KEY` path for anything carrying a person's
content. **Move BYOK inference client-side:** the device calls the vendor
directly with the person's key. Retire the `X-LLM-API-Key` header and the
server-side BYOK call in `resolve_chat_api_key`, so neither the key nor the
content of a BYOK call reaches our server. Whether a browser can call each
vendor directly is checked in this phase. Where it cannot, that feature is
unavailable on web; it does not fall back to a server relay.

Route credit-funded requests only to the vault-local model or a no-retention
runtime we control. Refuse otherwise, with no fallback. Label every receipt
with payer and location (B07). This composes with #3096.

- **Shippable on its own:** yes, without crypto. It only narrows where
  content may go. It removes cloud AI for people without BYOK until B05 ships.
- **Exit tests:** a provider-factory and socket spy records zero cloud calls
  without BYOK on every route (chat, marginalia, essays, detection,
  classification, transcription). A credit debit is present only beside a
  non-cloud receipt. A BYOK request recorded at the Adepthood server carries
  no synthetic canary and no `X-LLM-API-Key` header, because the BYOK call
  went from the device to the vendor.
- **Owed before release:** the privacy and vendor-terms review, and B01's
  copy.

### Phase (b): client key generation and the encrypted-sync envelope

Generate keys on the device. Use an AEAD envelope bound to owner, object type,
object id and version, with rollback defence. Add a ciphertext column and
version to each in-scope table. Enrolled accounts write ciphertext only,
autosave included. Unenrolled accounts are unchanged.

- **Shippable on its own:** yes, as an opt-in cohort. Synthetic accounts come
  first, then a reviewed cohort. Web enrolment carries the web caveat.
- **Gates:** D02 primitives and envelope (open question D02-PRIMITIVES), the
  D03 answers, and the cryptography review.
- **Exit tests:** B13's hostile-server canary test (DB dump, env keys and
  logs recover zero canaries). A swapped-row or cross-account ciphertext fails
  to open. A replayed old version is refused. A request spy shows autosave
  sends no plaintext.

### Phase (c): migration and plaintext retirement

Enrol existing accounts on their devices and re-encrypt their history. Delete
the server-key ciphertext and the derived plaintext. Withdraw Creek copies
(B04) and let backups expire (B08). Then retire `JOURNAL_ENCRYPTION_KEYS`
for journal content and invert `test_custody_codec_has_no_per_principal_key`.

- **Shippable on its own:** yes, per account. Each enrolled account is done
  when its legacy copies are gone. The server key path is retired only after
  the last in-scope account migrates, or on the owner's retirement date (open
  question MIGRATION).
- **Gates:** the application-security hostile-admin review and B08's
  retention values.
- **Exit tests:** for a migrated account, no server-key ciphertext and no
  `DERIVED_FROM_PROSE` row remain, and Creek reports a confirmed withdrawal.
  The downgrade path refuses to restore operator-held keys.

### Phase (d): server features that need plaintext move to the device or vault

These features move one at a time: owner search (a local index), resonance
and marginalia, essays, completion detection, corpus and frequency
classification, and transcription. Until a feature moves, it refuses
protected content before any provider or client is constructed.

- **Shippable on its own:** yes, per feature. Each move restores one feature
  for enrolled accounts.
- **Gates:** B09 capability measurements for the declared devices, B05's
  vault-local model, and the Creek maintainer's review for vault-side
  features.
- **Exit tests:** with egress denied, a moved feature runs and dials nothing
  external. Unsupported devices get an honest "not available", never a cloud
  fallback.

The B13 epic body that carries this plan is drafted at
[`0009-b13-epic-draft.md`](0009-b13-epic-draft.md) for the owner to post.

## Amended records

- [ADR 0002](0002-intimate-content-local-routing.md): Decisions 2-4 are
  amended by an appended section.
- [ADR 0007](0007-demand-provisioned-confidential-vaults.md): Decisions 4
  and 6 are amended by an appended section.
- Creek-Vault ADR 0005, Creek-Vault ADR 0006 and Creek-Vault ADR 0007 are
  amended by appended sections in Creek-Vault (branch `w34/B12-creek`).
- Creek-Vault ADR 0014 is **superseded for journal content**. Journal content
  in a managed vault is ciphertext under the person's key. Provider-managed
  custody remains only for operational state (credentials, job state,
  configuration) and, for inference that sees plaintext, under the RUNTIME
  question.

## Reopen triggers

- A key-non-possession prototype recovers protected canaries with server,
  DB, env and logs.
- No signed or pinned web delivery mechanism proves buildable, and per-platform
  scoping cannot be kept honest.
- D03 user testing shows the no-escrow loss rate is unacceptable. In that
  case revisit the recovery UX before revisiting escrow, and re-litigate
  escrow explicitly, never silently.
- B09 finds no supported device or vault configuration for non-cloud
  inference.
- A regulatory requirement forces a recovery path.
- A per-person key parameter appears on the codec, so
  `test_custody_codec_has_no_per_principal_key` fails. That is expected: it
  is the signal to update this record's Context and invert the test.
- Confidential compute becomes affordable enough to make the
  runtime-we-control path operator-blind (C and D05).
- The owner's budget for any phase is exceeded.

## Open owner questions

Mirrored in the scorecard's `open_owner_questions`. None is decided here.

- **D03:** recovery, account reset, device pairing, revocation, double loss,
  death or incapacity, malicious support requests (detailed above).
- **RUNTIME:** is credit-funded inference on a no-retention runtime we
  control, or on an ordinary-Fly vault, compatible with the premise, and how
  is it labelled?
- **WEB-ANCHOR:** which signed or pinned web delivery mechanism, and may web
  accounts enrol before it ships?
- **SCOPE:** which encrypted columns are journal content?
- **MIGRATION:** opt-in or required enrolment, the retirement date for
  server-held keys, dormant accounts, and backup expiry values.
- **FEATURE-LOSS:** what enrolled accounts are told before phase (d).
- **D02-PRIMITIVES:** which reviewed primitives, envelope format and library.
- **NATIVE:** whether and when to ship native apps.
- **BYOK-WEB:** whether web may keep a person's provider key in localStorage.
- **BYOK-CONSENT:** a proposal only. Is BYOK consent granted once per key,
  per feature, or per call?
- **BUDGET:** budget per active account-month and staffing per phase.
- **REVIEWERS:** who the four owed reviewers are.

## What this record does not unlock

No public claim. B24 ([#3076](https://github.com/Geoffe-Ga/adepthood/issues/3076))
must certify each claim, per platform, before any copy says "end-to-end",
"operator-blind" or "only you can read it". User-facing copy belongs to B01
([#3057](https://github.com/Geoffe-Ga/adepthood/issues/3057)). Until those
gates pass, the truthful description of today's system stands: the operator
holds the keys and can technically read stored journal text.
