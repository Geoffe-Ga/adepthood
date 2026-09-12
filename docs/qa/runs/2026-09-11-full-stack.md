# Full-stack QA execution record — 2026-09-11

This record applies the [full-stack QA runbook](../full-stack-qa-runbook.md) to
Adepthood, its Journal feature, and the real Creek-Vault pipeline. It records
what was actually exercised, what failed, and what could not be executed in the
local environment. It is not a substitute for the runbook.

## Decision

**Release result: FAIL.**

The build is not releasable while a privacy withdrawal or Journal deletion can
leave the entry's plaintext active in Creek-Vault. The run also found false
classification success, a classification scheduling race, and a native
Dynamic Type blocker. All findings were filed with reproduction steps,
acceptance criteria, priority, component, and workflow labels.

## Exact environment

| Component                 | Revision or endpoint                         | Notes                                                                                                              |
| ------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Adepthood (primary run)   | `48e9d9f953a52c1cf88d3bf4ddd49f036ef07d83`   | Primary API, browser, native, and real-boundary execution                                                          |
| Adepthood (later probes)  | `ea0c080060c88d00abf263ac51f73f007ecd835d`   | Post-runbook-merge follow-up and verification probes                                                               |
| Creek-Vault               | `99b15dd507d97a4315b9bebdc36d5553ba83d3f4`   | Clean canonical `main` worktree                                                                                    |
| Frontend                  | `http://127.0.0.1:3000`                      | Expo web development server                                                                                        |
| Adepthood API             | `http://127.0.0.1:8000`                      | Full local backend used by the frontend                                                                            |
| Owner-bound Adepthood API | `http://127.0.0.1:8001`                      | Same code with the disposable Creek owner binding enabled                                                          |
| Creek Journal/Vault API   | `http://127.0.0.1:8825`                      | Contract `0.15.0`; all eight advertised capabilities enabled                                                       |
| Database                  | PostgreSQL 16                                | Disposable, run-specific database and synthetic users                                                              |
| Local model               | Ollama / `qwen3:8b`                          | Used by the real Creek pipeline                                                                                    |
| Browser matrix            | 320×568, 390×844, 720×450, 844×390, 1440×900 | In-app browser name/version and DPR were not recorded; light theme; portrait, landscape, and history/reload probes |
| Native matrix             | iPhone 16 Plus / iOS 18.6                    | Standard and maximum Dynamic Type; Expo Go 57.0.9                                                                  |

No production account, production document, production vault, production API
key, or real personal data was used. Test payloads were synthetic. Secrets and
tokens were not copied into this record.

## Status legend

- **PASS** — the exercised acceptance behaviour matched the runbook.
- **FAIL** — a reproducible product defect was observed and filed.
- **PARTIAL** — meaningful coverage completed, but one or more matrix entries
  could not be exercised locally.
- **BLOCKED** — the environment or an external human action prevented a useful
  execution.

## Checklist result

### 1. Stack, contract, and isolation — PASS

- [x] Started a clean Adepthood frontend and backend against a disposable
      PostgreSQL database.
- [x] Started the canonical Creek-Vault Journal service from a clean worktree,
      a disposable vault, and a real local model.
- [x] Verified the Adepthood-to-Creek capability handshake: eight of eight
      capabilities recognized with zero schema failures.
- [x] Exercised journal upsert, upload, voice upsert/delete, pipeline stages,
      and wheel calls over the real HTTP boundary.
- [x] Verified cross-tenant reads and mutations do not expose another user's
      data.
- [x] Kept all pre-existing dirty user worktrees out of the run.

### 2. Global shell, navigation, and signed-out visual quality — PARTIAL

- [x] Inspected Get Started, Login, Signup, Forgot Password, Reset Password,
      and Cancel Reset at phone, landscape, and desktop browser sizes.
- [x] Exercised direct navigation, reload, back, forward, signed-out deep
      links, missing tokens, and invalid tokens.
- [x] Verified the supported fixed-light native welcome surface at standard
      Dynamic Type.
- [x] Checked native maximum Dynamic Type and reproduced an inaccessible
      overflow failure.
- [x] Reviewed browser and Metro consoles and separated framework/development
      warnings from product defects.
- [ ] Authenticated browser and native visual journeys were not executed: the
      browser required entering a credential, and explicit action-time approval
      to type the disposable credential was not received during the run.
- [ ] Android was unavailable on the host.
- [ ] A physical device, VoiceOver/TalkBack traversal, reduced-motion hardware
      behaviour, and real camera/photo-library permissions were unavailable.

Findings: [#2829](https://github.com/Geoffe-Ga/adepthood/issues/2829),
[#2830](https://github.com/Geoffe-Ga/adepthood/issues/2830).

### 3. Authentication, recovery, and session lifecycle — FAIL

- [x] Verified empty Signup remains client-side and displays validation.
- [x] Verified missing and fake recovery tokens fail safely.
- [x] Verified invalid authentication returns 401 without sensitive echo.
- [x] Verified refresh rotates the token and invalidates the previous token.
- [x] Verified account deletion invalidates active tokens.
- [x] Verified known and unknown password-reset requests use the same success
      response before the shared rate limit.
- [x] Verified untrusted origins receive no permissive CORS response.
- [ ] Blank Login and Forgot Password submit to the API and misdiagnose the
      result as a connectivity failure.

Findings: [#2821](https://github.com/Geoffe-Ga/adepthood/issues/2821),
[#2822](https://github.com/Geoffe-Ga/adepthood/issues/2822),
[#2823](https://github.com/Geoffe-Ga/adepthood/issues/2823).

### 4. Journal create, edit, privacy, resonance, and delete — FAIL

- [x] Exercised create, read, edit, soft delete, pagination inputs,
      suggestions, prompt dismissal/restore, promoted quotes, resonance, JSON
      export, and Markdown export.
- [x] Verified calm and distress **Intimate** entries remain local, return no
      marginalia, spend no credit, and make no Creek request.
- [x] Verified distress care copy still appears for Intimate entries and for a
      deliberately failed non-Intimate model call.
- [x] Verified a successful non-Intimate resonance returns marginalia and
      charges exactly once.
- [x] Verified journal bodies and titles are encrypted at rest and exports
      contain plaintext rather than ciphertext or forbidden secret fields.
- [ ] A body that sanitizes to empty can persist as an entry.
- [ ] Changing a mirrored entry to Intimate clears Adepthood's local mirror
      reference but leaves the plaintext document and derived Journal fragment
      active in Creek.
- [ ] Deleting a mirrored entry soft-deletes Adepthood's row but leaves the
      plaintext document and fragment active in Creek.

Findings: [#2827](https://github.com/Geoffe-Ga/adepthood/issues/2827),
[#2828](https://github.com/Geoffe-Ga/adepthood/issues/2828), and the required
Creek contract dependency
[#1799](https://github.com/Geoffe-Ga/Creek-Vault/issues/1799).

### 5. Creek ingestion, classification, and True Self pipeline — FAIL

- [x] Verified a Journal-created Personal entry reaches the owner-bound vault
      as a Journal document with open privacy.
- [x] Verified a bulk Markdown import reaches the same owner-bound vault as a
      Markdown/personal document.
- [x] Verified the full pipeline wire sequence against real Creek, including
      segment, embed, classify, synthesize, and wheel.
- [x] Verified the Adepthood live-integration issue remains open and attached
      exact local evidence to it.
- [ ] Creek reported `complete: true` and `classified: 2` after every local
      model attempt timed out or returned unchanged metadata.
- [ ] A document arriving after the classifier's snapshot but before later
      stages is visible to later stages, misses classification, and receives no
      prompt follow-up because of the fifteen-minute debounce.
- [ ] Reflection timed out in Adepthood at ten seconds; a direct warmed-vault
      Creek request returned 503 after approximately thirty seconds.

Findings: [Adepthood #2824](https://github.com/Geoffe-Ga/adepthood/issues/2824),
[Creek #1798](https://github.com/Geoffe-Ga/Creek-Vault/issues/1798), and updated
latency evidence on
[Creek #1034](https://github.com/Geoffe-Ga/Creek-Vault/issues/1034). The broader
live boundary remains tracked by
[Adepthood #2043](https://github.com/Geoffe-Ga/adepthood/issues/2043).

### 6. Corpus consent, invitations, import, export, and deletion — FAIL

- [x] Verified invitation “not now”, final opt-out, and dismissal high-water
      behaviour are monotonic.
- [x] Verified consent grant attempts backfill, readiness reports an honest
      zero-document gathering state when classification degrades, and revoke
      completes without inflating removal counts.
- [x] Verified exported JSON and Markdown omit deleted markers, ciphertext, and
      forbidden secret fields.
- [x] Verified wrong account-deletion confirmation fails, case-insensitive
      correct confirmation succeeds, and repeated access with old tokens fails.
- [ ] Account-deletion receipt copy can claim cleanup of an owner-bound vault
      belonging to a different account.
- [ ] Creek has no Journal retract/delete operation, so the privacy deletion
      contract cannot satisfy the runbook.

Findings: [#2825](https://github.com/Geoffe-Ga/adepthood/issues/2825),
[#2828](https://github.com/Geoffe-Ga/adepthood/issues/2828), and
[Creek #1799](https://github.com/Geoffe-Ga/Creek-Vault/issues/1799).

### 7. Habits and goals — FAIL

- [x] Exercised habit and goal create, update, complete, reveal, reorder,
      statistics, clear, and delete endpoints.
- [x] Exercised goal groups and tags, including foreign-owner access checks.
- [x] Verified duplicate, unknown, and repeated reveal requests fail or remain
      idempotent as specified.
- [ ] Whitespace-only habit names persist.

Finding: [#2826](https://github.com/Geoffe-Ga/adepthood/issues/2826).

### 8. Practice, sharing, tags, and recipes — PASS

- [x] Exercised practice selection, session lifecycle, and statistics.
- [x] Exercised create, filter, update, reorder, apply, and delete for recipes.
- [x] Exercised the share journey end to end, including single-use and revoke.
- [x] Verified an invalid share token returns a non-enumerating 404.
- [x] Verified cross-tenant protections for owned practice data.

Mode-specific audiovisual fidelity, background audio, notification delivery,
camera/photo library, and a physical-device endurance run remain part of the
release runbook and require a native hardware session.

### 9. Course, Map, and Return lifecycle — PARTIAL

- [x] Exercised course and stage API surfaces.
- [x] Exercised the complete eligible Return lifecycle: start, duplicate
      guard, release, unknown/duplicate selections, pause, resume, recommit, leave,
      repeated calls, and monotonic offer dismissal.
- [x] Restored the synthetic user's original stage high-water mark after the
      lifecycle run.
- [ ] Authenticated pixel and interaction review of Course passages, Map,
      calendar, and cross-feature CTAs was blocked by the credential-entry gate.

### 10. Settings, vault, wallet, legal, and care — PARTIAL

- [x] Exercised preferences, feature flags, time zone, consent, vault
      activation/status/disconnect, and API-key validation endpoints.
- [x] Verified invalid vault URLs and unsafe header names fail safely without
      echoing secrets.
- [x] Verified repeat disconnect is idempotent.
- [x] Verified an ineligible Return is rejected without changing stage state.
- [x] Verified non-admin administrative routes return 403.
- [x] Verified care resources include immediate and professional options under
      both local-only and model-failure paths.
- [ ] Real OAuth providers, transactional email delivery, Gumroad fulfilment,
      payment/refill settlement, production private-vault provisioning, and legal
      link destinations require external test accounts or human production access.

### 11. Security, privacy, and Murphy's-law probes — FAIL

- [x] Used long text, whitespace-only values, invalid base64, unknown IDs,
      repeated destructive requests, wrong HTTP methods, invalid bounds, expired
      tokens, and cross-tenant identifiers.
- [x] Verified validation errors do not echo supplied secret-like values.
- [x] Verified local encrypted fields remain encrypted in PostgreSQL while
      exports intentionally decrypt only user-owned content.
- [x] Verified Intimate content causes zero Creek requests.
- [ ] Previously mirrored plaintext cannot yet be withdrawn from Creek after a
      privacy transition or deletion.

### 12. Performance, concurrency, and recovery — PARTIAL

- [x] Exercised concurrent pipeline arrival during an in-flight classification
      snapshot and reproduced the late-arrival gap.
- [x] Exercised repeated state transitions and idempotency boundaries across
      deletion, Return, sharing, vault disconnect, consent, and prompt dismissal.
- [x] Measured the real reflection failure across both Adepthood's deadline and
      Creek's longer upstream deadline.
- [ ] Multi-hour soak, network shaping, large-library browser rendering,
      physical-device memory pressure, and production-scale model load were not
      available in this local pass.

## Defect inventory from this run

| Priority | Repository  | Issue                                                                                                                    | Result |
| -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| P0       | Adepthood   | [#2828 — privacy transition/delete leaves mirrored plaintext active](https://github.com/Geoffe-Ga/adepthood/issues/2828) | Open   |
| P0       | Creek-Vault | [#1799 — Journal contract has no retract/delete operation](https://github.com/Geoffe-Ga/Creek-Vault/issues/1799)         | Open   |
| P1       | Adepthood   | [#2824 — late-arriving document misses classification](https://github.com/Geoffe-Ga/adepthood/issues/2824)               | Open   |
| P1       | Adepthood   | [#2830 — auth shell clips maximum Dynamic Type](https://github.com/Geoffe-Ga/adepthood/issues/2830)                      | Open   |
| P1       | Creek-Vault | [#1798 — classifier reports false success](https://github.com/Geoffe-Ga/Creek-Vault/issues/1798)                         | Open   |
| P2       | Adepthood   | [#2821 — blank login misdiagnosed as connectivity](https://github.com/Geoffe-Ga/adepthood/issues/2821)                   | Open   |
| P2       | Adepthood   | [#2822 — blank forgot-password misdiagnosed as connectivity](https://github.com/Geoffe-Ga/adepthood/issues/2822)         | Open   |
| P2       | Adepthood   | [#2825 — deletion receipt can claim another owner's vault](https://github.com/Geoffe-Ga/adepthood/issues/2825)           | Open   |
| P2       | Adepthood   | [#2826 — whitespace-only habit names persist](https://github.com/Geoffe-Ga/adepthood/issues/2826)                        | Open   |
| P2       | Adepthood   | [#2827 — sanitized-empty journal entries persist](https://github.com/Geoffe-Ga/adepthood/issues/2827)                    | Open   |
| P3       | Adepthood   | [#2823 — auth recovery copy uses an ASCII double hyphen](https://github.com/Geoffe-Ga/adepthood/issues/2823)             | Open   |
| P3       | Adepthood   | [#2829 — decorative accessibility props reach React DOM](https://github.com/Geoffe-Ga/adepthood/issues/2829)             | Open   |

The existing Creek reflection-latency issue
[#1034](https://github.com/Geoffe-Ga/Creek-Vault/issues/1034) received new
exact-stack evidence rather than a duplicate issue.

## Gate evidence

- The runbook itself merged through PR
  [#2820](https://github.com/Geoffe-Ga/adepthood/pull/2820) after acceptance,
  formatting/pre-commit, nine fresh exact-head GitHub checks, and an independent
  exact-head `LGTM` review.
- Adepthood `main` at the later-probes revision above completed all eight
  product checks green after the runbook merge.
- This execution record is documentation only. Its own formatting,
  pre-commit, CI, and independent review evidence belongs on its pull request.

## Required follow-up

1. Implement Creek-Vault's Journal retraction contract and then Adepthood's
   privacy-transition/delete calls before any release.
2. Correct false-positive classification completion and the late-arrival
   scheduling gap before treating True Self readiness as trustworthy.
3. Re-run reflection against the real two-service stack after its latency path
   is fixed; keep Adepthood #2043 open until the real boundary passes.
4. Repair the auth shell's Dynamic Type overflow and repeat native checks on
   all auth screens.
5. Re-run the blocked authenticated browser/native visual matrix after an
   operator explicitly authorizes entry of a disposable credential.
6. Complete the hardware/external-service matrix before a production release.
