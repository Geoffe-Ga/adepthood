# phase-6-05: Token-pack purchase crediting and refund/cancellation revocation

**Labels:** `phase-6`, `backend`, `monetization`, `priority-high`
**Epic:** Phase 6 — Gumroad-gated access and monetization
**Depends on:** phase-6-02, phase-6-04
**Estimated LoC:** ~300–400 (including tests)

## Problem

phase-6-01 stores raw Gumroad webhook events. phase-6-02 handles the
`sale` event for the APTITUDE course. phase-6-04 adds the BotMason
token wallet with a manual crediting helper.

What's still missing:

1. **Automated token-pack crediting.** When a user buys a BotMason
   token pack on Gumroad, a webhook arrives and their balance should
   go up by the pack's size — no manual admin action required.
2. **Refund and cancellation handling.** When Gumroad sends a `refund`,
   `dispute`, `cancellation`, or `subscription_ended` event, we need
   to revoke course access and/or debit tokens (depending on what was
   refunded).

This issue closes the loop: the webhook endpoint fans out to dedicated
handlers for each event type, each of which produces idempotent
state changes.

## Design decisions

- **Product ID → entitlement type mapping.** The handler dispatches
  based on the `product_id` of the sale: APTITUDE product IDs affect
  course access; token-pack product IDs affect the wallet; anything
  else is logged and ignored. The two allowlists
  (`GUMROAD_APTITUDE_PRODUCT_IDS` and
  `GUMROAD_TOKEN_PACK_PRODUCT_IDS`, introduced in phase-6-01) are the
  sources of truth.
- **Token-pack size encoded in a mapping**, not a Gumroad custom
  field. Gumroad's product metadata is brittle and awkward to
  validate. A `GUMROAD_TOKEN_PACK_SIZES` env var holds
  `product_id:token_count` pairs — same pattern as Railway-friendly
  config.
- **Refund revokes, does not delete.** A refund writes
  `Entitlement.revoked_at` and, for token packs, a negative ledger
  entry of kind `refund`. History is preserved.
- **Refund on token packs can go negative.** If the user has already
  spent the tokens from a pack that later gets refunded, their balance
  can drop below zero. That's the correct outcome for a chargeback:
  they used tokens they didn't pay for. Future debits will fail with
  `insufficient_tokens` until they credit the balance. This mirrors
  how every other credit system handles chargebacks.
- **Monthly subscription: conservative default.** Per the epic's open
  question, we treat `subscription_ended` as an immediate access
  revocation. If you want "keep access through the paid period"
  later, that's a separate issue — simple to add given the ledger
  model (a `paid_through` column on the entitlement).

## Scope

### 1. Event dispatch table (`backend/src/routers/gumroad.py`)

Extend the webhook endpoint from phase-6-01 so `resource_name` routes
to dedicated handlers:

| `resource_name`         | Handler                          |
|-------------------------|----------------------------------|
| `sale`                  | `handle_sale`                    |
| `refund`                | `handle_refund`                  |
| `dispute`               | `handle_refund` (same behavior)  |
| `cancellation`          | `handle_cancellation`            |
| `subscription_ended`    | `handle_cancellation` (alias)    |

Unknown types: log `reason_code=unhandled_event` and return 200 (so
Gumroad doesn't keep retrying). Add a counter so we notice if a new
event type becomes common.

### 2. `handle_sale` (course access + token packs)

Extends phase-6-02's handler:

- If `product_id` in `APTITUDE_PRODUCT_IDS`: call
  `grant_course_access` (existing, idempotent).
- If `product_id` in `TOKEN_PACK_PRODUCT_IDS`: look up the token count
  from `GUMROAD_TOKEN_PACK_SIZES`. Find the user by email. If found,
  call `token_wallet.credit(...)` with `kind="purchase"` and
  `source_sale_id=<the GumroadSale row>`. Idempotent: if a ledger
  entry already exists with the same `source_sale_id` and
  `kind="purchase"`, skip.
- If user does not exist yet: persist the sale (already done in
  phase-6-01) and stop. The credit happens when they sign up; the
  entitlement handler looks up pre-existing unclaimed sales for the
  email.
- Neither allowlist: log and ignore.

### 3. `handle_refund`

- Look up the original sale by `gumroad_sale_id`.
- If not found in our DB: log and ignore (the sale predates us, or
  was never delivered).
- If it was an APTITUDE sale:
  - Check whether the user has any **other** active APTITUDE
    entitlement (they might own both one-time and monthly).
  - If not, call `revoke_course_access(user, reason="refund")`.
- If it was a token-pack sale:
  - Write a negative ledger entry for the original pack size with
    `kind="refund"` and `source_sale_id` pointing at the refunded
    sale. Allow negative balance per the design decision above.
- Idempotency: if a matching `kind="refund"` ledger entry / revoked
  entitlement already exists for that `source_sale_id`, skip.

### 4. `handle_cancellation`

Same as `handle_refund` for APTITUDE monthly subscriptions. Does not
affect token packs (cancellations don't apply to one-time purchases).

### 5. Expanded signup-time claim path

Update phase-6-02's signup handler: after the license verification
succeeds, also look up any **unclaimed token-pack sales** for the
email (i.e., sales that exist in `GumroadSale` but have no
corresponding positive ledger entry yet) and credit them at the same
time as the starter grant. This covers the order-of-operations case
where a user buys the course and a token pack before creating their
Adepthood account.

### 6. Tests

- Integration: token-pack webhook for an existing user credits the
  configured pack size once; replaying the same webhook does not
  double-credit.
- Integration: token-pack webhook for an unknown email persists the
  sale only; subsequent signup credits the wallet.
- Integration: refund on an APTITUDE sale revokes the entitlement.
- Integration: refund on a user who owns both one-time and monthly
  APTITUDE SKUs keeps access (other active entitlement covers them).
- Integration: refund on a token-pack sale writes a negative ledger
  entry, even if it drives the balance negative.
- Integration: cancellation of a monthly subscription revokes access.
- Integration: duplicate refund webhook is idempotent.
- Integration: unknown product ID is logged and ignored.

## Acceptance criteria

- Token-pack purchases credit the buyer's wallet with no manual step.
- Refunds and cancellations remove access within one webhook delivery.
- Duplicate webhook deliveries never double-credit or double-revoke.
- Users who buy before signing up are credited on first login.
- Unknown event types and product IDs degrade gracefully (logged,
  ignored, no 5xx).

## Files to create / modify

| File | Action |
|------|--------|
| `backend/src/routers/gumroad.py` | Modify (event dispatch, new handlers) |
| `backend/src/domain/entitlements.py` | Modify (claim unclaimed sales at signup) |
| `backend/src/domain/token_wallet.py` | Modify (refund helper) |
| `backend/src/routers/auth.py` | Modify (call unclaimed-sale claim on signup) |
| `backend/.env.example` | Modify (`GUMROAD_TOKEN_PACK_SIZES`) |
| `backend/tests/routers/test_gumroad_refund.py` | Create |
| `backend/tests/routers/test_gumroad_token_pack.py` | Create |
| `backend/tests/routers/test_gumroad_cancellation.py` | Create |

## Notes for implementer

- The dispatcher table is the place to add new event types as Gumroad
  expands — keep it a single source of truth.
- Do not rely on Gumroad's `paid_through` or `subscription_duration`
  fields. Treat every event as a discrete state change.
- The "negative balance after refund" decision is opinionated. If
  user-support feedback later says it feels punitive, we can relax
  to "refund debits at most the remaining balance" — but that creates
  an incentive to spend refundable tokens fast, which we don't want.
- For the `dispute` event, consider whether an admin notification is
  worth adding now. Probably not — phase-6-06 adds the admin surface.
