# BYOK document-import failure

Related: #3550, Creek-Vault #1982. Investigated 2026-10-25.

## Problem statement

A document uploaded through Adepthood was stored, but the managed Vault's
classification jobs returned rules results instead of LLM results. Three
successive Vault jobs succeeded with `method: rules` and `complete: true`;
Adepthood recorded one failed classification run after three attempts and
zero recorded counts. The owner confirmed their provider key was saved on the
same browser/device. No credentials or document contents were inspected.

## Root causes and data flow

1. `frontend/src/api/index.ts`, `onboardingKeyHeaders`, deliberately returns
   no key while the cached Vault vendor list is unknown. It starts vendor
   discovery without awaiting it. Both journal creation and document import
   use this helper. Consequently, a first document import with a saved key
   can still be sent keyless. A cached empty vendor answer also survives a
   Vault upgrade until session teardown: an incompatible old Vault can leave
   the browser withholding a saved key after the server is fixed. The server
   cannot relay a key it never receives.
2. The deployed managed Vault has no local classification model. Its current
   implementation falls back to rules for a keyless LLM request. This is a
   successful model-free pass, and its durable result reports `method: rules`.
3. `backend/src/services/creek_vault_payload.py`,
   `_parse_succeeded_pipeline_job`, parses classification results with an
   expected method of LLM. `_parse_classification_pass` rejects a rules result,
   producing `CreekVaultPayloadError` with the exact static message
   `creek vault returned an unreadable response: pipeline`.
   Reconciliation forgets the terminal handle and submits another keyless
   request. After three attempts, the app records failure and never advances
   to linking despite the real rules writes.

The historical browser cache state and original request headers were not
retained. The cold/stale-cache defects are reproducible explanations for the
missing key, rather than direct evidence of that particular browser request. A rules
result alone does not diagnose an invalid key or an exhausted provider balance.

## Impact and contributing factors

- A saved BYOK key does not reliably accompany the first upload after session
  initialization. Upload success alone does not establish LLM classification.
- A valid managed fallback is misclassified as protocol failure, causing
  redundant jobs and withholding their counts and downstream processing.
- Frontend tests intentionally assert that a journal save never waits for
  vendor discovery. The document test preloads the vendor cache, leaving its
  first-upload behavior uncovered.
- Durable pipeline doubles always return `method: llm`. Creek #1982 changed
  the real managed fallback without a corresponding consumer regression test.

## Fix strategy

Keep journal saves non-blocking. For explicit document imports with a known
provider-shaped local key, refresh the Vault's vendor discovery before building
the upload headers, under its existing bounded HTTP timeout. Do this even for
an already cached empty or affirmative answer. Vendor refusal or discovery
failure still withholds the key, without trusting the earlier cache. A session change while discovery is pending must cancel the old upload rather than send its bytes with another
account's credentials. Re-read the key after discovery so removal/rotation is
honored.

Accept known rules fallback results at the classification boundary while
preserving the actual method in the internal result. Record the semantic LLM
rung as incomplete, retain real counts, and allow downstream stages to use the
labels that did land. Do not promote rules to completed LLM classification or
weaken job-id, ceiling, count, and required-field validation. No credential
persistence, contract pin change, database migration, or production retry is
needed for this fix.

## Verification

- Red: a cold-cache document import expected the saved key but received no
  key header. A valid durable rules result caused three submissions instead
  of one. The new tests failed against the original implementation.
- Green: 98 targeted backend pipeline/relay/admission tests passed. The API
  key and journey-ledger checks passed all 88 tests, including vendor refusal,
  discovery failure, key removal/rotation and sign-out during discovery.
- The real HTTP/Postgres lane passed journal, first-document, and upgraded-Vault
  cached-empty-vendor cases
  with synthetic credentials: exactly one keyed classification POST, a
  durable handle before the response, and subsequent polling with no key.
  The final three-case run used a clean install of the locked dependencies and
  passed.
- The frontend check-all gate passed all seven stages, including the
  production bundle and all 13,156 tests. The backend check-all gate also passed all seven stages
  with 97% reported coverage. Push-hook results are recorded in the PR's
  validation section.
