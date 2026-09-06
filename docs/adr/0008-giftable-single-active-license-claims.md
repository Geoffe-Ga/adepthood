# ADR 0008: Gumroad licenses are giftable, single-active-account claims

- **Status:** Accepted
- **Date:** 2026-09-06
- **Issue:** [#1987](https://github.com/Geoffe-Ga/adepthood/issues/1987)
- **Amends:** the email-equality rule implemented by the original Gumroad
  signup epic [#1938](https://github.com/Geoffe-Ga/adepthood/issues/1938).
  The current code continues to enforce that older rule until #1987 ships.

## Context

Adepthood uses Gumroad as the system of record for course access. The shipped
verifier requires the email on the Gumroad purchase to equal the email used for
Adepthood sign-in. That blocks Sign in with Apple users who choose Hide My
Email, people who bought with a different mailbox, and—more importantly for the
product's Gift Economy—one person intentionally buying access for another.

Purchase-email control is not Adepthood's identity proof. Google, Apple, or the
password flow establishes the Adepthood account; Gumroad establishes that a
valid course entitlement was purchased. Joining those systems by email adds
friction without defending the property the product actually needs: one live
purchase must not grant simultaneous access to many accounts.

A Gumroad license key is already a high-entropy credential intended for
redemption. Treating it as a bearer claim accepts one explicit risk: whoever
possesses an unclaimed key can claim it. That is compatible with gifting and is
preferable to requiring purchaser and learner to share an identity.

## Decision 1 — Possession of a valid license key is sufficient claim proof

All account-creation paths accept a Gumroad-verified license for an allowlisted
APTITUDE product without comparing the purchase email with the account email.
No mailed code, purchaser-mailbox challenge, or special Hide-My-Email path is
required.

The provider response must still prove that the license exists, belongs to an
allowlisted product, and is not refunded, reversed, chargebacked, cancelled, or
otherwise invalid. Provider outage remains fail-closed for new claims.

The purchase email remains financial/audit data received from Gumroad. It is
not authorization data and must not be exposed in a claim refusal.

## Decision 2 — One license binds to exactly one active account

The implementation introduces an explicit active-license binding keyed by the
stable Gumroad sale/license identity. A database uniqueness constraint—not an
application pre-check—enforces at most one active account for that identity.

Claim behavior is atomic and idempotent:

- an unbound valid license binds to the account and grants course access;
- the same account presenting its existing binding succeeds idempotently;
- another active account presenting the bound license receives the same generic
  license refusal used for any unsuccessful claim; and
- concurrent first claims produce one winner and no double entitlement.

The raw license key is never persisted. Store the stable provider sale and
product identifiers and, only where lookup or abuse controls need it, a keyed
HMAC fingerprint under an independently rotatable application secret. A plain
hash of a human-transcribed credential is not an acceptable substitute.

## Decision 3 — Deleting the account releases the license

Completed account deletion deletes the active-license binding with the account.
If the Gumroad purchase is still valid, the same key may then be claimed by a
new account. There is no transfer operation while the original account remains
active; the owner first deletes that account or uses an administrator recovery
process whose actions are audited.

Reclaiming the license transfers access only. It never transfers or resurrects
the deleted account's journal, corpus, identity links, practices, consent
events, private vault, offering balance, or generated material.

The retained anonymized `GumroadSale` financial record is not an active binding
and must not prevent a legitimate post-deletion claim. Conversely, token-pack
credit idempotency is deliberately permanent: deleting an account does not make
an already-credited token-pack purchase reusable by the next license claimant.

## Decision 4 — Revocation follows the sale, not the email

Refund, chargeback, cancellation, and subscription-end handling locate the
active binding by stable sale identity and revoke the entitlement it granted.
Changing, anonymizing, or deleting either account's email must not break this
link. Webhook replay remains idempotent.

If a sale becomes valid again, the system does not silently bind it to a new
account while an earlier binding survives. Reactivation behavior must operate
through the same single-active-binding invariant.

## Decision 5 — Gifting is product behavior, not an exception

Signup and purchase copy may say that a license can be given to someone else.
It must not instruct a gift recipient to use the purchaser's email or imply
that sharing an inbox is required. Support and administrator tooling reason
about the binding and stable sale id, not email equality.

The terms may continue to forbid resale, credential stuffing, automated abuse,
and simultaneous sharing. They must not prohibit an ordinary one-person gift.
Privacy and terms copy are updated in the implementation PR so they describe
the behavior users can actually exercise, not this future state prematurely.

## Decision 6 — Bearer-key abuse is constrained at the boundary

Removing email equality increases the value of guessing or stealing an
unclaimed key. The implementation therefore preserves or strengthens all of
these controls:

- existing per-IP and per-route signup limits;
- a bounded invalid-license throttle applied before repeated provider calls;
- maximum key length and blank-key refusal;
- generic, byte-identical refusal surfaces across password, Google, and Apple;
- no response that distinguishes invalid, refunded, wrong-product, or
  valid-but-already-bound keys;
- no raw key in logs, analytics, exceptions, audit rows, or database columns;
- alerting on anomalous claim volume; and
- an audited administrator path for genuine support disputes.

Email equality is removed only after tests prove these controls and the atomic
binding/deletion behavior.

## Consequences

- Hide-My-Email, alternate-mailbox, and gifted-license users have one simple
  path.
- A leaked unclaimed key can be claimed by its possessor; this is the explicit
  bearer-credential trade-off.
- The data model gains a binding lifecycle separate from sale retention,
  entitlement state, and token-pack credit idempotency.
- Account deletion becomes a security-critical release event and must be
  covered by concurrency and end-to-end tests.
- Legal, onboarding, support, and observability copy must move with the code
  when #1987 ships.
