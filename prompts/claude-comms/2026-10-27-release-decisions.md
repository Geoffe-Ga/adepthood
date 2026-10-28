# Release decisions — owner record (2026-10-27)

**Decider:** Geoff Gallinger, repository owner
**Status:** Decided by the owner on 2026-10-27. This file copies the decisions
into the repository so the records and code that carry them out can link to
something that ships with the code.

An agent wrote this record down; it decided nothing. Where this file and the
owner's own words disagree, the owner's words win. Rationale is given only
where the owner gave one. Decision ids are the owner's, grouped as given.

---

## R5 — Review and privacy copy

| Id | Decision | Owner's rationale |
|---|---|---|
| R5-1 | Drop the independent-reviewer requirement from ADR 0009's phase gates. Recorded as "Amendment 2026-10-27: reviewer gates waived by owner" in `docs/adr/0009-privacy-custody-and-inference-architecture.md`. | The owner trusts the architecture built together. Budget and scope don't justify outside review now; it may be revisited once there are real users. |
| R5-2 | #3059 D01: exclude Intimate text from folded quotes. | — |

R5-1 waives a phase gate only. It certifies nothing: no public copy may say an
independent, external or outside party has checked the design, the "Adepthood
cannot read your journal" claim stays uncertified under B24 (#3076), and no
"end-to-end" or "operator-blind" claim is made.

## R4 — Privatemode (attested inference vendor)

| Id | Decision | Owner's rationale |
|---|---|---|
| R4-1 | The Privatemode pilot key is capped at €10/month. | — |
| R4-2 | Poll vendor usage and alert at the threshold. | — |
| R4-3 | The key expires after 1 year. | The owner does the key steps and cleanup, and will rotate at real launch. |
| R4-4 | Build Creek #1989, then run a bounded eval of 2–3 Privatemode catalog models, then approve. Wire Privatemode's embedding model (`qwen3-embedding-4b`) for users who do **not** bring their own key. | — |

Privatemode catalog as of 2026-10-27, per
<https://docs.privatemode.ai/models/overview/>:

| Use | Models |
|---|---|
| Chat | `glm-5.3`, `glm-5.3-flash`, `gpt-oss-120b` |
| Embeddings | `qwen3-embedding-4b` |
| OCR (preview) | `deepseek-ocr-2` |
| Speech-to-text | `voxtral-mini-3b`, `whisper-large-v3` |

## R2 — Managed-vault operations

| Id | Decision | Owner's rationale |
|---|---|---|
| R2-1 | A general, batch, operator-run converge tool for vault upgrades (Creek #1869). | — |
| R2-2 | Future Fly tokens are 90-day. | A 7-day token was rotated on 2026-10-27 to bridge. |
| R2-3 | Release cap: 15 managed vaults, with an alert at USD 60/month. | — |
| R2-4 | When the alert channel fails: keep routing, retry alerts, refuse new activations. | — |
| R2-5 | Creek supports the pinned contract version and the one before. Adepthood moves its pin only after every vault reports the new version. | — |

## R1 — Keys, classification and import

| Id | Decision | Owner's rationale |
|---|---|---|
| R1-1 | Option 2 of #3550: keep the writer's key encrypted beyond the request, so background classification can use it. | — |
| R1-2 | #3516: classification is absorbed as overhead and does not count against the user's allowance, unless cost later warrants charging. | — |
| R1-3 | Keep the 1.5 s save-time key wait and the 5-minute refresh. | — |
| R1-4 | Revive PR #3056. | — |
| R1-5 | Folder import includes attachments in this release. Pacing and resume on 429 are essential. Every ingestable document type Creek-Vault supports must be submittable as a folder or individually. | — |

R1-1 needs ADR changes on both sides (adepthood and Creek-Vault). This record
captures the decision only; it amends no ADR.

## R3 — Vault agents (OAuth)

| Id | Decision | Owner's rationale |
|---|---|---|
| R3-1 | Require a per-vault token audience before release. | — |
| R3-2 | The vault checks revocation on every call. | — |
| R3-3 | Keep the platform variable for the OAuth signing key; add a rotation runbook and rotate every 90 days. The runbook is in `DEPLOYMENT.md`. | — |
| R3-4 | Live runs of OpenClaw, Claude Code and ChatGPT before acceptance. | — |
| R3-5 | Keep advertising the `vault:pipeline` and `vault:journal` scopes, and make them grantable rather than removing them. | — |
| R3-6 | Accept that cached voice passages never enter prompts (Creek #1996, merged). | — |

## OPS — Ownership

Geoff Gallinger is the managed-vault ops owner, the alert contact, the
privacy/deletion contact and the Privatemode key owner.

## Done on 2026-10-27

- The Fly token was rotated (the 7-day bridge token of R2-2).
- Production `OAUTH_ISSUER_URL` and `OAUTH_SIGNING_KEYS` were set; they had
  been missing. `/.well-known/oauth-authorization-server` and
  `/.well-known/jwks.json` return 200 in production.
- The Privatemode account and key were created.
