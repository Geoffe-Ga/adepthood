# ADR 0002: Intimate-tier content routing

- **Status:** Accepted
- **Date:** 2026-07-01
- **Issue:** [#898](https://github.com/Geoffe-Ga/adepthood/issues/898) (epic [#893](https://github.com/Geoffe-Ga/adepthood/issues/893); ratified in [#927](https://github.com/Geoffe-Ga/adepthood/issues/927))

## Context

`NORTH-STAR.md` section 10, "Design guardrails," states the Privacy
bullet plainly: "Intimate-tier content is classified and routed
locally, encrypted at rest, and never sent to a cloud LLM. This is
surfaced to the user as a feature, not buried." Section 9 frames the
stakes: journal-first PKM makes "privacy becomes the pitch rather than
the plumbing" — the strongest card Adepthood can play against every
cloud-AI journaling app, but only if intimate content genuinely never
leaves the user's control.

This ADR began as decision #898, "local-routing strategy for
Intimate-tier content," scoped under epic #893. Rather than settle in
isolation, its options were folded into the broader Creek Vault MCP
boundary decision, #927, and ratified there on 2026-06-30 alongside
Creek's hosting, custody, and routing model. This ADR records that
outcome for the intimate-routing question specifically — it is not a
new decision, and none of Decisions 1-4 below are proposals; they are
what #927 already settled.

The user-facing framing #927 converged on is a single promise: "your
writing lives in your own private space that only you can open, and
your intimate writing is never handed to an outside AI." No technical
tier names are exposed to the user; the promise is the whole surface.

Four options were on the table for how intimate content avoids the
cloud:

1. **Skip-only** — never call the cloud LLM for intimate entries; no
   reflection, no marginalia, no usage-log entry for that content.
2. **On-device model** — run inference on the user's own phone/laptop.
3. **Local heuristic classifier/reflection** — a rule-based, non-LLM
   reflection pass that never leaves the device.
4. **Self-hosted inference** — run a real model in infrastructure the
   user (not the operator) controls.

Option 1 already shipped, in #895, and remains Adepthood's interim
behavior today. The long-term answer #927 ratified is a refined
version of option 4: the user's own Creek Vault, running on
confidential-compute infrastructure, tracked as epic #949.

## Decision 1 — Hosting: a persistent per-user VM

Each user's vault runs as ephemeral compute attached to a durable,
encrypted, user-owned volume, reachable over a network MCP transport.
`TierCeiling` is enforced at that transport boundary: INTIMATE content
is never reachable remotely, by construction, not by policy.

**Rejected — multi-tenant or shared hosting:** an operator-run shared
store means the operator can see intimate content in the ordinary
course of running the service — exactly the trust boundary this whole
decision exists to remove.

## Decision 2 — Key custody: user-held keys plus confidential compute

The volume's encryption key is held by the user, not escrowed by the
operator, and is released into a trusted-execution-environment (TEE)
enclave only after remote attestation of that enclave. GPU confidential
compute (H100-class or newer) is explicitly in scope, so intimate
content still gets a good-quality voice from the reflection model
without ever leaving encrypted custody outside the enclave.

**Rejected — operator/HSM escrow, social recovery, platform-keychain
sync:** each reintroduces an operator-recoverable path to the key,
which is precisely the property "only you can open it" forbids. Out of
scope for v1.

## Decision 3 — Routing: one chokepoint, enforced by Creek

Creek's `ModelRouter` (tracked in creek-vault#642) is the single place
that enforces "INTIMATE never reaches the cloud." Bring-your-own-key
(BYOK) — the user's own Anthropic, OpenAI, or Gemini key — is
supported for OPEN and PERSONAL tiers only, using the existing
`ApiKeySettings` pattern already shipped in Adepthood.

**Rejected — a second, Adepthood-side tier gate:** a second gate that
can disagree with Creek's router is a bypass surface, not a safety
net. Adepthood passes the tier through and does not re-gate it.

## Decision 4 — Recovery: Obsidian-grade, no operator path back in

Key derivation is passphrase-based, held by the user, with a one-time
recovery key shown once at setup and never stored by the operator.
There is no operator escrow and no operator-assisted recovery reset.

**Rejected — operator escrow or a recovery-reset flow:** either one
contradicts "only you can open it" — a recoverable-by-the-operator key
is not actually user-held.

## Open question — intimate transit across the seam

Whether intimate content may cross the Adepthood-to-vault seam at all
— covering ingest (#952) and reflection (#953) — is **deferred to the
machine-readable contract, #950**, per the transit/custody analysis on
epic #949. This ADR names the question; it does not resolve it. The
contract must settle at least four sub-questions:

- **Transit topology.** May intimate content cross a seam that
  physically runs through Adepthood's backend at all, and if so, what
  end-to-end protection (e.g. client-side encryption the operator
  cannot decrypt in transit) keeps the operator from seeing it
  in-flight?
- **Write-vs-read asymmetry.** Ingest-in and reflection-compute are a
  separate question from #927's read-path guarantee ("INTIMATE never
  reachable remotely") and must be decided on their own terms, not
  assumed to inherit it.
- **Reflection-output provenance.** What tier does a reflection carry
  once it is grounded in the intimate corpus, and may that reflection
  ever return to the app, or does it stay vault-side?
- **Custody end-state.** Do intimate entries eventually migrate out of
  the operator's Postgres into the vault, end up dual-homed in both,
  or stay local-only for v1?

There is a real tension here, not yet resolved: #952 and #953 describe
intimate content as never crossing the seam, while #927's own TEE
rationale (Decision 2 above) exists specifically because intimate
voice is generated *inside* the enclave — which implies something
about the entry does cross, under attestation, to get there. #950 is
where that tension gets settled, not this ADR.

**Resolution:** this fork is now settled in the draft contract,
`docs/creek-vault-mcp-contract.md`.

## Consequences

- Adepthood passes the tier through to Creek's `ModelRouter` and
  builds no second routing gate of its own.
- The interim, currently-shipped behavior is #895's skip-only mode:
  intimate entries never reach the cloud LLM and are not linked into
  the usage log (`backend/src/routers/journal.py`,
  `backend/src/domain/resonance.py`,
  `backend/src/domain/detection.py`). This holds until the vault seam
  ships.
- Epic #949 builds Adepthood's client side of the Creek Vault MCP
  handshake; #950 publishes the machine-readable contract that seam
  depends on.
- BYOK reuses the existing `ApiKeySettings` UX and is surfaced to the
  user entirely under the one promise, with no technical tiers
  exposed.
