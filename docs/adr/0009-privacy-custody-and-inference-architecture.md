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
  `decrypt(value)` take no per-person key. Two guards hold that baseline
  structurally, over the in-scope journal columns of the scorecard's
  `journal_scope_proposal`:
  - `test_custody_codec_has_no_per_principal_key` checks that every one of
    those columns is still typed `EncryptedString` under the per-person-key-free
    codec;
  - `test_server_env_keys_alone_recover_every_in_scope_journal_column` writes
    a canary to each on a real database and recovers it with nothing but the
    env key.

  Both are built to fail when B13 phase (c) moves a journal column to
  client-held ciphertext.
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
  lists the columns that hold it. Among them are the corpus embedding and
  frequency weights, and the entry's tier, classification, tag, vault tags and
  reflection scope. Completion detection output is a separate, non-textual
  derived store (`completionsuggestion.completed_units` and `completed_on`).
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

Items 1-5 are the owner's 2026-10-07 decision. Items 6-14 are the owner's
answers to this record's follow-up questions, given the same evening.

1. **The operator cannot read people's journal entries.**
   (`owner:2026-10-07#B12-premise`) This premise governs **stored** journal
   content and every prose derivative of it, and the BYOK and device paths
   of inference. It does **not** cover credit-funded processing in a managed
   runtime while that processing runs (item 4). The derivatives are the
   in-scope `EncryptedString` columns (item 9) and the `DERIVED_FROM_PROSE`
   plaintext.
2. **Keys are user-held, with no operator escrow.**
   (`owner:2026-10-07#B12-premise`) Under the target, keys are generated on
   the person's device and the server stores ciphertext and public
   parameters only. No operator-held decrypt capability will exist in the
   protected path, and there will be no operator-assisted recovery. It
   follows directly that **an account or password reset cannot recover the
   data key**. Recovery itself is item 11.
3. **Cloud models are used only with the person's own key.**
   (`owner:2026-10-07#B12-cloud-byok`) Anthropic, OpenAI and any other cloud
   model are to be reached only when the person adds their own key in
   Settings (BYOK). Under the decision, without such a key **none of their
   data will reach a cloud model**, and the app's own cloud key will never
   carry a person's journal content. How finely BYOK consent is granted (per
   key, per feature or per call) is not decided; see open question
   BYOK-CONSENT.

   **BYOK calls go from the person's device straight to the vendor.** This
   follows directly from the premise. If the server relayed a BYOK call, it
   would see the plaintext it forwards. So, under the target, the person's
   key and the content of a BYOK call will not pass through our server.

   **Known gap until phase (a) lands:** today the client sends the person's
   key to our backend in the `X-LLM-API-Key` header
   (`frontend/src/api/index.ts`). The relay path in
   `services/botmason.py` is: the header, then `resolve_chat_api_key`
   (validates and returns the key), then `_resolve_api_key`, then the
   server-side vendor call in `_call_openai` / `_call_anthropic`. So the
   server sees both the key and the plaintext on every BYOK call.
4. **BotMason credits pay for non-cloud inference only.**
   (`owner:2026-10-07#B12-credits`, `owner:2026-10-07#followup-runtime`)
   That means the vault-local model (B05,
   [Creek-Vault#1849](https://github.com/Geoffe-Ga/Creek-Vault/issues/1849))
   or a **managed no-retention runtime** we run. Under the decision, credits
   will never pay for a call made with the app's cloud key.

   **Known gap until phase (a) lands, with #3096: the app-key fallback.**
   Today, when no BYOK key is sent, `services/botmason.py::_resolve_api_key`
   falls back to the server's `LLM_API_KEY`. A credit-funded request
   carrying journal content therefore reaches a cloud vendor on the app's
   account. Phase (a) removes that fallback for anything carrying a person's
   content, together with #3096 (refuse without credits or BYOK).

   **Honest limit, decided by the owner:** processing in that managed
   runtime is **not operator-blind while it runs**. The runtime sees the
   plaintext it processes and stores none of it. The same holds for a
   vault-local model on an ordinary-Fly managed vault. Every such use is
   **labelled clearly each time**, for example "processed on Adepthood's
   private server, not stored". The per-use label is a phase (a) requirement.
5. **The web caveat is stated per platform.** (`owner:2026-10-07#B12-web`)
   User-held keys apply on every platform. The guarantee is strongest on
   native apps. On web it rests on trusting the code we serve, mitigated by
   signed or pinned builds. Public claims are scoped per platform (see
   "Per-platform claim scoping").
6. **Web protection: CSP plus SRI now, signed builds later.**
   (`owner:2026-10-07#followup-web-anchor`) The web client moves from a
   report-only CSP to an **enforced** CSP with Subresource Integrity. Signed
   builds come later. CSP and SRI narrow injected and third-party script,
   but both are served by us. They do **not** stop the operator from serving
   a different bundle, so until signed builds ship, operator protection on
   web still rests on trusting the served code.
7. **No web enrolment until the web protection ships.**
   (`owner:2026-10-07#followup-web-enrol`) A web account may not enrol in
   user-held keys until enforced CSP plus SRI is live.
8. **Web first; native later.** (`owner:2026-10-07#followup-native`)
9. **Scope: the proposed split.** (`owner:2026-10-07#followup-scope`)
   In scope: journal entries and titles, reflections (marginalia notes and
   essays), practice reflections, prompt responses, and the corpus
   fragments, completion suggestions and promoted quotes derived from them.
   Out of scope: feedback notes and reports, and the stored vault API key.
   The scorecard's `journal_scope_proposal` holds the exact columns.
10. **Migration is opt-in for everyone, for now.**
    (`owner:2026-10-07#followup-migration`) No account is moved without
    choosing to be. The retirement date for server-held keys stays open
    (MIGRATION-RETIREMENT).
11. **Recovery: a recovery phrase plus the person's passphrase.**
    (`owner:2026-10-07#followup-recovery`) The person writes the recovery
    phrase down. Either factor unlocks the data key. **Losing both means the
    data is gone**, and the person agrees to that up front at enrolment.
    Pairing, revocation, death or incapacity, and what support may do on a
    malicious request stay open under D03.
12. **Feature loss: ship phase (a) now and tell people plainly.**
    (`owner:2026-10-07#followup-feature-loss`)
13. **The BYOK provider key on web is kept encrypted under the user-held
    key.** (`owner:2026-10-07#followup-byok-web`) Until an account enrols,
    there is no user-held key to wrap it with. That is one more reason
    phase (b) puts web protection first.
14. **Primitives are proposed, not final.**
    (`owner:2026-10-07#followup-primitives`) The proposal is libsodium
    sealed boxes and XChaCha20-Poly1305. The cryptography reviewer has to
    confirm it before phase (b) enrols anyone.
15. **Nothing is claimed yet.** This record approves an architecture. It
    unlocks no public privacy claim, and every claim still passes B24
    ([#3076](https://github.com/Geoffe-Ga/adepthood/issues/3076)).

**Consequence the owner asked to surface.** Migration is opt-in (item 10),
web may not enrol before CSP plus SRI (item 7), and native comes later
(item 8). Together these mean **nobody can enrol in user-held keys until the
CSP and SRI work ships**. Phase (b) therefore starts with that work.

## Threat actors

Each cell says whether the actor can recover **stored** journal prose under
the option once that option's gates have passed. An actor who controls the
code the person runs can capture the user-held key, so for that actor stored
history and future content stand or fall together.

| Actor | status_quo | A | B | C | D | E | BD (selected) |
|---|---|---|---|---|---|---|---|
| Database thief (no env keys) | blocked | blocked | blocked | blocked | blocked | blocked | blocked |
| Backup holder (with env keys) | reads | reads | blocked | blocked | blocked | reads | blocked |
| Privileged operator | reads | reads | blocked on native while the signed build is honest; on web, reads through a served bundle until signed builds ship | blocked\* | same as B | reads | blocked on native while the signed build is honest; **on web, reads all stored history through a served bundle until signed builds ship** (enforced CSP plus SRI does not stop this); sees managed-runtime inputs while they run (labelled on each use) |
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
- **Reopen triggers:** Not a selectable end state; the owner's premise rules it out. (`owner:2026-10-07#B12-premise`)

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
- **Reopen triggers:** Rejected by the owner on 2026-10-07: it contradicts the premise that the operator cannot read journal entries. (`owner:2026-10-07#B12-premise`)

### Option B

*User-held keys with client-side encryption.*

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
- **Reopen triggers:** Selected as half of BD; reopen if a key-non-possession prototype fails. (`owner:2026-10-07#B12-premise`)

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
- **Reopen triggers:** Rejected as a custody model; its vault-local inference survives inside BD for consented, non-retained processing. (`owner:2026-10-07#B12-premise`)

### Option BD

*Selected: user-held keys plus device-side and vault-local inference, BYOK cloud as explicit opt-in.*

- **Boundary:** Stored journal content and its prose derivatives are ciphertext the operator cannot decrypt. Plaintext exists on the person's devices, in a vault they choose for inference, and at a cloud vendor only under their own key, sent from the device and never relayed by our server. (`owner:2026-10-07#B12-premise`)
- **Key custody:** User-held keys generated on the person's device; no operator escrow; the server stores ciphertext and public parameters only. (`owner:2026-10-07#B12-premise`)
- **Recovery:** A recovery phrase the person writes down plus their passphrase; either unlocks the data key. Losing both means the data is gone, agreed up front at enrolment. Pairing, revocation and the rest of D03 stay open. (`owner:2026-10-07#followup-recovery`)
- **Metadata leakage:** Sizes, timestamps, counts, object ids, tier labels, credit receipts and network metadata stay visible to the operator; content does not. (`repo:backend/tests/test_column_classification.py::_PLAINTEXT_COLUMNS`)
- **Inference location:** Device first; then the person's vault-local model or a managed no-retention runtime we run (paid by credits, labelled on each use, not operator-blind while it runs); cloud only with the person's own key, called from the device straight to the vendor. Today BYOK is server-proxied, a known gap until phase (a). (`owner:2026-10-07#B12-cloud-byok`)
- **Supported platforms:** Web first, native later. Native apps carry the strongest guarantee; on web the guarantee rests on trusting the code we serve. Web accounts may not enrol until enforced CSP plus SRI is live; signed builds come later. (`owner:2026-10-07#B12-web`)
- **Client delivery and update trust:** Native: store-signed builds (later). Web: enforced CSP plus SRI now, signed builds later; the CSP is report-only today, and CSP plus SRI cannot stop us serving a different bundle. (`repo:frontend/nginx.conf`)
- **Primary-copy and derivative removal:** The 12 in-scope EncryptedString columns of journal_scope_proposal (of the 18; feedback and the vault credential stay out), DERIVED_FROM_PROSE plaintext, completion detection output, Creek copies, vendor copies and backups are re-encrypted client-side, withdrawn or expired before an account is labelled protected. (`repo:backend/src/services/encryption_inventory.py::encrypted_columns`)
- **Threat actors:** Defeats DB thief, backup holder, host-storage access and stored-data subpoena. Defeats the privileged operator only on native while the signed build is honest; on web the operator can capture the key through a served bundle and read all stored history until signed builds ship. A compromised device remains; managed-runtime inference is not operator-blind while it runs (labelled on each use); until phase (a) our server relays BYOK calls and sees their plaintext. (`repo:backend/src/services/botmason.py::resolve_chat_api_key`)
- **Budget (USD per active account-month):** **unknown; owner input required.**
- **Staffing:** **unknown; owner input required.**
- **Reopen triggers:** Key-non-possession prototype fails; no web anchor is buildable; D03 user testing shows unacceptable loss; B09 finds no supported non-cloud configuration. (`owner:2026-10-07#B12-premise`)
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
| Native iOS and Android (store-signed; later, after web) | Ciphertext only | Protected **only while the signed build is honest**. A malicious or compelled signed build could capture the key and decrypt stored history and future content alike | Device-first; vault or credits runtime only with consent; cloud only with BYOK, device to vendor | OS keystore, store signing, and reproducible-build evidence once it exists |
| Web (served by us) | Ciphertext only | **Rests on trusting the code we serve**, for stored history and future content alike. A malicious or compelled bundle could capture the key at the next load and decrypt everything stored. This stays true until signed builds ship: enforced CSP plus SRI narrows injected script but cannot stop us serving a different bundle. Web accounts may not enrol before CSP plus SRI is live | Same routing as native, with browser runtime limits | Enforced CSP plus SRI now; signed builds later (owner decision, items 6-7) |
| Person's own vault (self-hosted) | Theirs to protect | Theirs to protect | Vault-local model | The person's own machine |
| Managed vault on ordinary Fly | Ciphertext only for journal content, once B13 phases (b) and (c) land for the account | The same per-client caveat as the platform the person enrols from | Vault-local inference sees plaintext while it runs; this is not operator-blind, and each use is labelled (Decision item 4) | Creek's runtime plus Fly; provider-managed custody is not operator-blind for anything still stored in plaintext |

No platform may advertise "end-to-end" or "operator-blind" until B24
certifies that claim for that platform.

## Client delivery and update trust

- **Web today:** the operator serves the bundle on every page load.
  `frontend/nginx.conf` sends `Content-Security-Policy-Report-Only` at both
  locations, so the CSP reports violations but does not enforce them. Nothing
  out-of-band lets a person check the code they ran. Under BD this is the
  weakest link: a served bundle can capture the key and so read stored
  history as well as future content. That is why the web claim is scoped.
- **Decided (Decision items 6-7):** enforce the CSP, with `script-src
  'self'`, and add Subresource Integrity now. Web accounts may not enrol
  until both are live. Signed builds come later. The mechanism for that
  later step (a signed release manifest verified by a pinned service worker
  or extension, or reproducible builds with a public transparency log) is
  not chosen yet. CSP and SRI are served by us, so they do not protect
  against us; only the signed-build step addresses the operator.
- **Native:** store-signed builds from `frontend/eas.json` profiles are not
  shipped today. The owner decided web first and native later (Decision
  item 8). Shipping native needs store and signing accounts, which means
  spend.
- **The BYOK key on web:** `secureStringStore.ts` falls back to localStorage,
  so script compromise can read a person's provider key today. Decided
  (Decision item 13): once an account enrols, the provider key is kept
  encrypted under the user-held key.

## Primary-copy and derivative removal

Every server-readable store that must reach "ciphertext under a user-held
key, withdrawn, or expired" before an account may be labelled protected:

1. **The 18 `EncryptedString` columns.** These are held by B02's inventory
   (`encrypted_columns()`) and pinned by
   `test_every_encrypted_column_stores_ciphertext`. The default proposal,
   per the owner's scope split (Decision item 9):
   - **Journal content, in scope:** `journalentry.*`, `marginalia.*`,
     `promotedquote.anchor_text`, `corpusfragment.content`,
     `completionsuggestion.*`, `promptresponse.response`,
     `practicesession.insight` and `practicesession.reflection`.
   - **Out of scope:** `feedbacknote.body` and `feedbackreport.*`,
     which are written *to* the operator to be read, and
     `uservaultconfig.api_key`, a credential the server must present on the
     person's behalf.
2. **`DERIVED_FROM_PROSE` plaintext** (`_PLAINTEXT_COLUMNS` in
   `backend/tests/test_column_classification.py`). The members are
   `corpusfragment.embedding`, `corpusfragment.frequency_weights`,
   `corpusfragment.tier`, `journalentry.classification`,
   `journalentry.reflection_scope_key`, `journalentry.tag` and
   `journalentry.vault_tags`. For a protected account these are recomputed on
   the device or in the vault, dropped, or kept only where the owner decides
   they may stay readable (B02 owner decision: disclose, do not encrypt,
   embeddings, frequency weights and vault tags).
3. **Completion detection output.** `completionsuggestion.completed_units` and
   `completionsuggestion.completed_on` are non-textual values derived from
   prose by detection. They follow the same rule as item 2.
4. **Backups and snapshots.** B08 ([#3063](https://github.com/Geoffe-Ga/adepthood/issues/3063))
   owns the store inventory and retention values. Its store inventory has
   not landed on this branch, so the list of non-database stores is still to
   be consumed from B08 when it merges. Backup expiry deadlines are part of
   open question MIGRATION-RETIREMENT.
5. **Creek copies.** These are withdrawn through B04's destination-bound
   machinery (`services/creek_vault_withdraw.py`, voice-draft retraction),
   which has landed. Creek-side deletion has to be idempotent and purge
   derived copies ([Creek-Vault#1854](https://github.com/Geoffe-Ga/Creek-Vault/issues/1854)).
6. **Vendor copies.** These are whatever already reached a model vendor,
   listed per recipient in `backend/src/privacy/recipients.py` (B11,
   [#3065](https://github.com/Geoffe-Ga/adepthood/issues/3065)). They cannot
   be recalled. They expire under each vendor's retention terms, which stay
   `UNVERIFIED` until the owner supplies receipts.
7. **Logs and telemetry.** These hold no content by design. B10
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
  two is part of open question MIGRATION-RETIREMENT.
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
  person's vault-local model (B05) or a managed no-retention runtime we run. A
  BYOK call pays its own vendor and debits no credits. With neither credits
  routed to a non-cloud runtime nor BYOK, the request is **refused**, with no
  fallback to the app's cloud key. This composes with
  [#3096](https://github.com/Geoffe-Ga/adepthood/issues/3096) (B07: refuse
  without credits or BYOK) and with B07's inference provenance, so every
  receipt names who paid and where the call ran.
- **Honest limit (owner decision, Decision item 4).** The managed runtime
  sees plaintext while it runs and stores none of it. The same holds for a
  vault-local model on an ordinary-Fly vault. Neither is operator-blind
  during processing. Each use is labelled clearly, for example "processed on
  Adepthood's private server, not stored". The label is a phase (a)
  requirement.
- **Feature loss, said plainly (Decision item 12).** Until the managed
  runtime or B05's local model is live, a person without BYOK has no
  credit-funded inference. Phase (a) ships anyway, and people are told so in
  plain words.

## Recovery, reset and pairing (D03): decided parts and open owner questions

**Decided** (`owner:2026-10-07#followup-recovery`, Decision item 11):

- **Recovery factors.** A recovery phrase that the person writes down, plus
  their passphrase. Either one unlocks the data key.
- **Double loss.** Losing both means the data is gone. The person agrees to
  that up front, at enrolment.
- **Reset.** Account and password reset cannot recover the data key. This
  follows from no escrow.
- **Lost device.** The recovery phrase or the passphrase restores access on
  a new device.

Format, wording and how often the phrase is shown are implementation detail
for B13. They need the cryptography review and user testing.

**Still open (D03):**

1. **Pairing.** How a new device joins (out-of-band code, QR code, a
   recovery factor), and how a wrong-account sync is refused.
2. **Revocation.** What a revoked device loses, and whether key rotation
   re-wraps everything.
3. **Death or incapacity.** Whether there is any delegated access, and if
   so, with which user-held mechanism.
4. **Malicious support requests.** What support may and must not do when
   someone claims to be the account holder.
5. **Shared devices and offline export.** Local key lifetime, and how a
   person exports a decrypted copy.

## Confidential compute (D05)

D05 is not pursued. C is rejected for now (see below). It reopens only if
the owner wants the managed runtime's processing to become operator-blind,
which Decision item 4 currently says it is not. In that case D05's conditions apply in full: real hardware,
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
  under Decision item 4: labelled on each use, and not operator-blind while
  it runs.

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

Route credit-funded requests only to the vault-local model or a managed
no-retention runtime we run. Refuse otherwise, with no fallback. Every use of
the managed runtime is **labelled on each use** in the product, for example
"processed on Adepthood's private server, not stored". Label every receipt
with payer and location (B07). This composes with #3096.

- **Shippable on its own:** yes, without crypto. It only narrows where
  content may go. Ship it now (Decision item 12). Until the managed runtime
  or B05's local model is live, it removes cloud AI for people without BYOK,
  and people are told that plainly.
- **Exit tests:** a provider-factory and socket spy records zero cloud calls
  without BYOK on every route (chat, marginalia, essays, detection,
  classification, transcription). A credit debit is present only beside a
  non-cloud receipt. A BYOK request recorded at the Adepthood server carries
  no synthetic canary and no `X-LLM-API-Key` header, because the BYOK call
  went from the device to the vendor. Every managed-runtime response reaches
  the person with its per-use label.
- **Owed before release:** the privacy and vendor-terms review, and B01's
  copy.

### Phase (b): client key generation and the encrypted-sync envelope

**First slice: enforce the CSP and add SRI** on the web client. Change
`frontend/nginx.conf` from `Content-Security-Policy-Report-Only` to an
enforced `Content-Security-Policy`, and add Subresource Integrity to the
served bundles. This comes first because of the consequence in the Decision
section: enrolment is opt-in, web may not enrol before CSP plus SRI, and
native comes later, so **nobody can enrol until this slice ships**.
`test_custody_adr_names_enforcement_that_exists` pins the report-only header;
rewrite it in the same change.

Then: Generate keys on the device. Use an AEAD envelope bound to owner,
object type, object id and version, with rollback defence. The proposed
primitives are libsodium sealed boxes and XChaCha20-Poly1305, pending the
reviewer. Wrap the data key under the passphrase and under the recovery
phrase (Decision item 11). Add a ciphertext column and version to each
in-scope table. Enrolled accounts write ciphertext only, autosave included,
and keep their BYOK provider key encrypted under the user-held key
(Decision item 13). Unenrolled accounts are unchanged.

- **Shippable on its own:** yes. The CSP and SRI slice ships alone. After
  it, enrolment opens as an opt-in cohort: synthetic accounts first, then a
  reviewed cohort. Web enrolment carries the web caveat until signed builds
  ship.
- **Gates:** the cryptography reviewer confirms the proposed primitives and
  envelope (D02-PRIMITIVES) before any real account enrols. Pairing and
  revocation (open under D03) must be answered before multi-device sync
  ships.
- **Exit tests:** B13's hostile-server canary test (DB dump, env keys and
  logs recover zero canaries). A swapped-row or cross-account ciphertext fails
  to open. A replayed old version is refused. A request spy shows autosave
  sends no plaintext.

### Phase (c): migration and plaintext retirement

Enrol existing accounts on their devices and re-encrypt their history. Delete
the server-key ciphertext and the derived plaintext. Withdraw Creek copies
(B04) and let backups expire (B08). Then retire `JOURNAL_ENCRYPTION_KEYS`
for journal content. Invert `test_custody_codec_has_no_per_principal_key`
and `test_server_env_keys_alone_recover_every_in_scope_journal_column`.

- **Shippable on its own:** yes, per account. Each enrolled account is done
  when its legacy copies are gone. The server key path is retired only after
  the last in-scope account migrates, or on the owner's retirement date (open
  question MIGRATION-RETIREMENT). Enrolment is opt-in for everyone for now
  (Decision item 10), so no account is migrated without choosing to be.
- **Gates:** the application-security hostile-admin review and B08's
  retention values.
- **Exit tests:** for a migrated account, no server-key ciphertext and no
  `DERIVED_FROM_PROSE` row or completion detection value remains (except
  values the owner kept readable), and Creek reports a confirmed withdrawal.
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
- Creek-Vault ADR 0014 is **superseded for journal content as a decided
  target**. The decision is that journal content in a managed vault will be
  ciphertext under the person's key once B13 phases (b) and (c) complete for
  that account. Until then, Creek-Vault ADR 0014 and ADR 0007 Decision 4 keep
  describing and governing that account's journal content, which stays
  operator-readable. Provider-managed custody stays for operational state
  (credentials, job state, configuration). Inference that sees plaintext falls
  under Decision item 4: labelled on each use, and not operator-blind while
  it runs.

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
- A journal column leaves the server-key codec, or the codec gains a
  per-person key, so `test_custody_codec_has_no_per_principal_key` or
  `test_server_env_keys_alone_recover_every_in_scope_journal_column` fails.
  That is expected: it is the signal to update this record's Context and
  invert the tests.
- Confidential compute becomes affordable enough that it could make the
  runtime-we-control path operator-blind, if D05 is proven (C).
- The owner's budget for any phase is exceeded.

## Open owner questions

Mirrored in the scorecard's `open_owner_questions`. On 2026-10-07 the owner
answered RUNTIME, WEB-ANCHOR, WEB-ENROL, SCOPE, MIGRATION (opt-in), the D03
recovery factors, FEATURE-LOSS, NATIVE and BYOK-WEB, and proposed the
primitives. Those answers are Decision items 4 and 6-14. What is still open:

- **D03:** pairing, revocation, death or incapacity, malicious support
  requests, shared devices and offline export (detailed above).
- **MIGRATION-RETIREMENT:** the retirement date for server-held keys,
  dormant accounts, backup expiry values, and whether the protected label
  waits for backup expiry.
- **D02-PRIMITIVES:** reviewer confirmation of the proposed libsodium sealed
  boxes and XChaCha20-Poly1305, and the envelope format.
- **BYOK-CONSENT:** a proposal only. Is BYOK consent granted once per key,
  per feature, or per call?
- **INTIMATE-DEVICE:** may device-side inference, which is never remote,
  ever process INTIMATE? ADR 0002 Decision 1 and the skip-only interim stay
  unchanged until the owner decides.
- **BUDGET:** budget per active account-month and staffing per phase.
- **REVIEWERS:** who the four owed reviewers are.

## What this record does not unlock

No public claim. B24 ([#3076](https://github.com/Geoffe-Ga/adepthood/issues/3076))
must certify each claim, per platform, before any copy says "end-to-end",
"operator-blind" or "only you can read it". User-facing copy belongs to B01
([#3057](https://github.com/Geoffe-Ga/adepthood/issues/3057)). Until those
gates pass, the truthful description of today's system stands: the operator
holds the keys and can technically read stored journal text.
