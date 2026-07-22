# EPIC: Phase 6 — Gumroad-gated access and monetization

**Labels:** `epic`, `phase-6`, `priority-high`, `monetization`

## Summary

APTITUDE (the course Adepthood facilitates) is sold on Gumroad under a
gift-economy model: the price is "pay what feels right", with free as the
floor. Adepthood currently has its own email/password auth with no link to
purchases. This epic makes Gumroad the system-of-record for access and
introduces a usage-based entitlement for BotMason (so we are not
subsidizing LLM tokens indefinitely).

Two kinds of entitlement need to be modeled:

1. **Course access** — binary. Granted by a verified Gumroad license for
   an APTITUDE SKU (one-time or monthly subscription). Free-tier $0
   licenses count; what matters is that a Gumroad sale exists.
2. **BotMason tokens** — a per-user balance, debited as the user chats with
   BotMason and credited by purchasing Gumroad token-pack SKUs. Must
   coexist with the BYOK path from issue #185: users who supply their own
   LLM API key via `X-LLM-API-Key` bypass the balance check.

After this epic, signing up for Adepthood requires an existing Gumroad
purchase. A user lands on the signup screen, is directed to Gumroad to
"acquire" the course (free is fine), returns with a license key, and
redeems it. Gumroad webhooks keep entitlements in sync for refunds,
cancellations, and token-pack purchases.

## Non-goals

- Using Gumroad as an OAuth identity provider (Gumroad does not offer
  OAuth for end users — its OAuth is creator-account API access only).
  We continue to own the JWT flow; Gumroad gates who is *allowed* to
  sign up, not how they authenticate. Social login (Google / Apple
  sign-in) is real and wanted, but it is our own implementation and
  lives in the separate **social-auth epic**
  ([`social-auth-epic.md`](social-auth-epic.md)), which layers on top
  of this epic's license gate.
- Stripe or any direct payment integration. Gumroad is the payment rail.
- Migrating existing users. The app is still in demo, so we assume a
  clean slate; if needed, a one-off backfill script can be written later.

## Success criteria

- A new user cannot create an Adepthood account without a valid Gumroad
  license for an APTITUDE SKU.
- The free-tier ($0) Gumroad variant grants the same course access as
  the paid variants — price is not what gates access.
- BotMason chat requests debit from a user-scoped token balance when BYOK
  is not used; requests fail with a clear `insufficient_tokens` error
  when the balance is zero and no BYOK key is supplied.
- A refund or subscription cancellation on Gumroad revokes course access
  within one webhook delivery window.
- A Gumroad token-pack purchase credits the buyer's balance
  idempotently (replaying the same webhook does not double-credit).
- All Gumroad webhook traffic is HMAC-verified with a shared secret.
- Manual override endpoints (admin-only) exist for comped access and
  balance adjustments when Gumroad is unavailable.

## Architecture at a glance

```
Gumroad (payment + identity gate)
  │
  ├─ Sale / subscription / refund webhooks ──▶ /webhooks/gumroad
  │   (HMAC-verified, idempotent by sale_id)
  │
  └─ License verification API ◀────────────── /auth/redeem-license
                                              (called during signup)

Adepthood backend
  ├─ models/
  │    ├─ entitlement.py       # course access flag + metadata
  │    ├─ token_wallet.py      # balance + ledger entries
  │    └─ gumroad_sale.py      # raw sale record for idempotency + audit
  ├─ routers/
  │    ├─ gumroad.py           # webhook endpoint + license redemption
  │    └─ auth.py              # signup now checks entitlement
  └─ domain/
       ├─ entitlements.py      # grant/revoke logic
       └─ token_wallet.py      # debit/credit with ledger
```

## Sub-issues

0. [`phase-6-00`](phase-6-00-gumroad-business-setup.md) —
   **Human runbook (not Ralph-pickable):** create the Gumroad products,
   API application, and secrets; hand product IDs + token to the backend
   config
1. [`phase-6-01`](phase-6-01-gumroad-api-and-webhooks.md) —
   Gumroad API client, webhook scaffolding, HMAC verification
2. [`phase-6-02`](phase-6-02-course-entitlement-and-signup-gating.md) —
   Course entitlement model and signup gating via license redemption
3. [`phase-6-03`](phase-6-03-frontend-onboarding-flow.md) —
   Frontend onboarding flow: redirect to Gumroad and redeem license
4. [`phase-6-04`](phase-6-04-botmason-token-wallet.md) —
   BotMason token wallet (model, debit on chat, BYOK bypass)
5. [`phase-6-05`](phase-6-05-token-credits-and-revocation.md) —
   Token-pack SKU crediting and refund/cancellation revocation
6. [`phase-6-06`](phase-6-06-admin-override-endpoints.md) —
   Admin endpoints for manual grants, revocations, and balance adjustments

## Dependencies

- Requires `phase-1-03` (auth router) — complete.
- Touches `phase-3-07` (BotMason AI) for the token debit hook.
- Interacts with issue #185 (BYOK) — BYOK requests must bypass the
  token balance check, not debit zero.

## Resolved decisions (2026-07-22)

The open questions are settled; sub-issues should treat these as spec:

- **Product shape**: one APTITUDE *membership* product with two tiers,
  both pay-what-you-want with a **$0 floor** (gift economy / dana model
  à la Charles Eisenstein — contribution is invited, never required):
  - **Annual** — suggested **$150/year** (comparable to course apps
    like Reframe, per the $100–200/yr target)
  - **Monthly** — suggested **$15/month**
  The tier/variant product IDs go on `GUMROAD_APTITUDE_PRODUCT_IDS`.
  No one-time/lifetime SKU at launch. Product creation is manual
  (Gumroad's API cannot create products) — see
  [`phase-6-00`](phase-6-00-gumroad-business-setup.md).
- **`subscription_ended` / `cancellation`**: treated as immediate
  access revocation (the conservative default already specified in
  `phase-6-05`). "Access through the end of the paid period" can be a
  follow-up issue if it ever feels punitive — with a $0 re-subscribe
  floor, a lapsed user can always regain access for free.
- **Starter token grant**: already satisfied — since these sub-issue
  docs were written, BotMason metering shipped: `User.offering_balance`
  plus a free monthly allocation (`BOTMASON_MONTHLY_CAP`), with atomic
  spend/grant mutations and a `WalletAudit` trail in
  `backend/src/services/wallet.py`, and BYOK support in
  `backend/src/services/botmason.py`. The monthly free allocation plays
  the "try before you contribute" role, so no separate starter grant is
  needed.

## Codebase reality check (2026-07-22)

`phase-6-04` and `phase-6-05` were specced before the BotMason wallet
existed. The debit path, race-safe spend, BYOK bypass, audit log, and
admin grant reason codes are **already implemented** in
`services/wallet.py` / `models/wallet_audit.py`. Those two sub-issues
are therefore re-scoped when filed as GitHub issues:

- **04** → credit `offering_balance` from Gumroad token-pack sale
  webhooks (idempotent by `gumroad_sale_id`, buy-before-signup claim at
  signup), with a new `WalletAudit` reason code — no new ledger model.
- **05** → refund / dispute / cancellation / `subscription_ended`
  handling: course-access revocation and offering-balance claw-back.

The filed GitHub issues are the source of truth for scope; these two
docs are kept for background.
