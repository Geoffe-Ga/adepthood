# phase-6-04: BotMason token wallet — model, debit on chat, BYOK bypass

**Labels:** `phase-6`, `backend`, `botmason`, `monetization`, `priority-high`
**Epic:** Phase 6 — Gumroad-gated access and monetization
**Depends on:** phase-6-01, phase-3-07 (BotMason AI)
**Estimated LoC:** ~400–500 (including tests)

## Problem

BotMason calls an LLM on every journal reflection. Right now the cost
of those tokens is absorbed by the server — fine during demo, not
sustainable as the user base grows. Two monetization options already
exist in the codebase:

1. **BYOK** (issue #185) — the user provides their own LLM API key via
   the `X-LLM-API-Key` header, and we pass it through without paying
   for tokens.
2. **Usage-based credits** — we sell BotMason token packs on Gumroad
   and maintain a per-user token balance that debits as the user
   chats.

This issue introduces option 2 as the default for users who haven't
supplied BYOK. A user with both a non-empty token balance and no BYOK
header has tokens debited. A user with BYOK bypasses the balance
entirely. A user with neither gets an `insufficient_tokens` error and
a prompt to either buy a pack or add their own key.

Crediting the balance from Gumroad webhooks is covered in phase-6-05.
This issue is about the **model, the debit path, and the BYOK
interaction** — it lands with a manual admin crediting helper so the
balance can be exercised end-to-end before phase-6-05 automates it.

## Design decisions

- **Ledger, not just a counter**: Every debit and credit writes a
  `TokenLedgerEntry` row. The balance is the sum of ledger entries.
  This makes audits trivial, supports refunds without losing history,
  and prevents race-condition "double-debit" bugs that a mutable
  balance column would invite.
- **Transactional debit**: The debit happens inside the same SQL
  transaction as the BotMason request's other writes (journal entry,
  response persistence). If the LLM call fails after the debit,
  rollback refunds the tokens automatically. If the call succeeds but
  we fail to persist, we also roll back — the user is not charged for
  a response they didn't receive.
- **Fixed-cost estimate at debit time**: We debit a conservative
  upper-bound estimate (e.g., `max_tokens` from the request + a
  prompt-size factor) before calling the LLM. After the response, we
  refund the difference between estimate and actual usage. This avoids
  the "user's balance is $0 but the in-flight request still charges
  them into the negative" trap.
- **BYOK fully bypasses the wallet**: Not "charge them anyway and hope
  they don't notice". If `X-LLM-API-Key` is present and non-empty, no
  ledger entry is written at all.
- **Starter grant**: On first entitlement grant (phase-6-02), the user
  receives a configurable starter balance so they can try BotMason
  before committing to a pack. The starter amount is an env var
  (`BOTMASON_STARTER_TOKENS`) so it can be tuned without a deploy.

## Scope

### 1. Model (`backend/src/models/token_ledger.py`)

- `TokenLedgerEntry`:
  - `id`, `user_id` (FK, indexed), `delta` (signed int, positive =
    credit, negative = debit),
  - `kind` enum: `starter_grant`, `purchase`, `debit`, `refund`,
    `admin_adjustment`,
  - `source_sale_id` (FK to `GumroadSale`, nullable),
  - `request_id` (nullable string, populated on debit/refund for
    matching a debit to its refund),
  - `reason_code` (string, mirrors our structured-logging convention),
  - `created_at`.
- Partial indexes on `(user_id, created_at DESC)` for fast balance
  reads.
- Alembic migration.

### 2. Domain logic (`backend/src/domain/token_wallet.py`)

- `get_balance(session, user_id) -> int` — sums the `delta` column,
  0 for users with no entries.
- `credit(session, user_id, amount, kind, **meta) -> TokenLedgerEntry`
  — positive only; rejects non-positive amounts loudly.
- `debit(session, user_id, amount, request_id, reason_code) -> TokenLedgerEntry`
  — negative; raises `InsufficientTokens` if the balance would drop
  below zero. The check-then-insert is wrapped in a transaction using
  `SELECT ... FOR UPDATE` on the user row (or a dedicated
  `TokenBalance` row — see the race-condition note below) so
  concurrent debits cannot both pass the check.
- `refund_unused(session, request_id, actual_tokens) -> TokenLedgerEntry | None`
  — finds the original debit by `request_id`, writes a positive
  entry for `(estimated - actual)`. No-op if `actual >= estimated`.

### 3. Race-condition handling

Two concurrent BotMason requests for the same user must not both
read the same pre-debit balance and both succeed when the user can
only afford one.

Options:
- (a) `SELECT ... FOR UPDATE` on a dedicated `TokenBalance` summary
  row, updated alongside every ledger write.
- (b) Serializable transaction isolation for the debit path.
- (c) Advisory locks (`pg_advisory_xact_lock(user_id)`).

Pick (a) — it's the simplest to reason about and plays nicely with
the existing SQLModel + async session. The `TokenBalance` row is a
denormalization of the ledger's sum; a DB constraint ensures it can
never go negative.

### 4. BotMason chat integration

Touching `backend/src/routers/botmason.py` (or wherever the chat
endpoint lives — check phase-3-07):

- Before calling the LLM:
  - If request has valid `X-LLM-API-Key`: skip wallet entirely. Log
    `reason_code=byok_bypass`.
  - Else: compute estimated token cost (use an existing tokenizer if
    one is available via `tiktoken`; otherwise a simple heuristic like
    `ceil(len(prompt)/4) + max_tokens`). Call `debit(...)`. If it
    raises `InsufficientTokens`, return 402 Payment Required with
    `detail="insufficient_tokens"`.
- After the LLM returns:
  - Read `response.usage.total_tokens` (Anthropic / OpenAI).
  - Call `refund_unused(request_id, actual)`.
- On LLM or persistence error: the surrounding transaction rolls back,
  automatically undoing the debit. Do not catch-and-swallow.

### 5. Starter grant wired to phase-6-02

- In `backend/src/domain/entitlements.py::grant_course_access`, after
  a successful first-time grant, call `credit(..., amount=starter,
  kind="starter_grant")`. Idempotency: do not re-grant on repeat
  webhook deliveries (phase-6-02's grant is already idempotent; the
  starter credit should key off a `starter_grant` ledger entry
  existing for that user).

### 6. Balance endpoint

- `GET /users/me/tokens` — returns the current balance for the
  authenticated user. Used by the frontend to decide whether to show
  the BYOK prompt or the "buy more tokens" CTA. Rate-limited per
  existing conventions.

### 7. Tests

- Unit: `credit`, `debit`, `refund_unused` behave correctly in
  isolation. `InsufficientTokens` raised when expected.
- Unit: `get_balance` returns zero for users with no ledger entries.
- Integration: two concurrent debits that together exceed the balance
  — exactly one succeeds, one raises `InsufficientTokens`. Run with
  real Postgres (`pytest-postgresql`) to exercise the
  `SELECT ... FOR UPDATE`.
- Integration: chat endpoint with BYOK header writes no ledger
  entries.
- Integration: chat endpoint without BYOK with sufficient balance
  debits the estimate, then refunds the difference after the LLM
  responds.
- Integration: chat endpoint without BYOK with zero balance returns
  402.
- Integration: LLM call fails after debit → rollback → balance
  unchanged.
- Integration: starter grant is written on first entitlement grant
  and not re-written on a duplicate webhook.

## Acceptance criteria

- A new user with a fresh course entitlement has
  `BOTMASON_STARTER_TOKENS` in their wallet.
- A chat with no BYOK header debits their balance; running it while
  at zero returns 402.
- A chat with BYOK header never touches the wallet.
- Under concurrent load, double-spend is impossible.
- LLM errors after debit do not leave the user short.
- `GET /users/me/tokens` returns the current balance.
- Coverage ≥ 90% on the new files.

## Files to create / modify

| File | Action |
|------|--------|
| `backend/src/models/token_ledger.py` | Create (ledger + balance rows) |
| `backend/src/domain/token_wallet.py` | Create |
| `backend/src/routers/users.py` | Modify (add `/me/tokens`) |
| `backend/src/routers/botmason.py` | Modify (wallet debit/refund) |
| `backend/src/domain/entitlements.py` | Modify (starter grant) |
| `backend/src/errors.py` | Modify (`InsufficientTokens`, 402) |
| `backend/alembic/versions/xxxx_token_ledger.py` | Create |
| `backend/tests/domain/test_token_wallet.py` | Create |
| `backend/tests/routers/test_botmason_wallet.py` | Create |
| `backend/.env.example` | Modify (`BOTMASON_STARTER_TOKENS`) |

## Notes for implementer

- If BotMason's chat handler isn't yet structured around a
  transaction, restructure it in this issue. The transactional
  invariant is the whole point of the ledger design.
- Pick the token estimator carefully: underestimating invites
  negative balances; gross overestimation frustrates users. Document
  the chosen heuristic.
- The 402 status code is the right fit (Payment Required, rarely
  used, unambiguous semantics). Don't reuse 401 or 403.
- Do not expose ledger entries directly via an API yet — the balance
  is enough for frontend needs. A history endpoint can land when the
  user actually asks for one.
