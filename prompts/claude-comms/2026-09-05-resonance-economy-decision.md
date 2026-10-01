# Resonance economy — launch decision record (2026-09-05 / 2026-09-06)

**Issue:** #623 (resonance economy & essay pricing)
**Status:** Ratified by the owner in two comments on #623. This file copies them
into the repository so the constants that carry out the decision can link to
something that ships with the code.

The two owner comments are quoted **verbatim** below. Everything after them is
the implementation map. Where the map and the quotes disagree, the quotes win.

---

## 1. Owner decision — 2026-09-05

Source: <https://github.com/Geoffe-Ga/adepthood/issues/623#issuecomment-5556328575>
(posted 2026-09-06T02:22:50Z by the repository owner)

> Owner decision — 2026-09-05
>
> ## Default economy for launch
>
> - Resonance pass: **1 offering**
> - First essay expansion for a note: **1 offering**
> - Reopening an already-generated/cached essay: **free**
> - Failed or empty provider result: **refund the reserved offering**
> - Monthly included balance: **20 offerings** (reduce the current default from 50 until real usage establishes the cost curve)
> - One-time packs: **50 / $5**, **125 / $10**, **300 / $20**; purchased offerings never expire
>
> ## Abuse and cost guardrails
>
> - enforce generation limits per authenticated user, not only per IP;
> - maximum **5 LLM generations/minute/user**;
> - maximum **2 concurrent generations/user**;
> - configurable launch ceiling of **100 charged generations/day/user**;
> - preserve idempotency/caching and the wallet hard-stop;
> - retain the existing note/input and output bounds;
> - instrument actual input/output tokens, model, cost estimate, refunds, and cache hits so these defaults can be revised from evidence.
>
> This makes essays predictably paid without charging again for the same generated artifact, and resolves the pricing-policy blocker.

## 2. Economics validation — 2026-09-06

Source: <https://github.com/Geoffe-Ga/adepthood/issues/623#issuecomment-5562113852>
(posted 2026-09-06T20:55:42Z by the repository owner)

> Economics validation — 2026-09-06
>
> The approved launch packs have now been checked against the configured model, prompt bounds, retry behavior, and Gumroad's current fee schedule.
>
> ## Net receipts
>
> At Gumroad's current direct-card fees (10% + $0.50, plus 2.9% + $0.30 processing), the approximate creator net is:
>
> - $5 / 50: $3.555 total, 7.11¢ per offering
> - $10 / 125: $7.91 total, 6.33¢ per offering
> - $20 / 300: $16.62 total, 5.54¢ per offering
>
> At the 30% Discover fee (processing included), the same tiers net 7.00¢, 5.60¢, and 4.67¢ per offering respectively.
>
> ## Model cost envelope
>
> The server-side Anthropic default is `claude-sonnet-5`, and the repository's $2 input / $10 output per million-token row matches Anthropic's current list price. The 10,000-character journal cap plus five 1,000-character prior-entry caps bounds input. The adapter permits up to 4,096 output tokens.
>
> A normal Resonance or essay generation is expected to land around 1.5–2.7¢ on Sonnet 5, so every tier has useful contribution margin. The pathological one-call ceiling is roughly 5.3¢; a Resonance corrective second pass can double that. OpenAI's default `gpt-4o-mini` is far cheaper. Opus/Turbo models are not safely covered by a flat one-offering charge at their worst case.
>
> ## Launch decision
>
> The 50/$5, 125/$10, and 300/$20 tiers are economically reasonable for the configured default models and bounded, normal responses. They should be launched through direct links. One offering is a product unit, not permission for unbounded compute.
>
> Implementation of this issue must therefore also:
>
> - keep paid server-side usage on a cost-bounded default model;
> - treat Opus/Turbo as BYOK/admin-only or charge a model-specific multiplier;
> - meter real input/output tokens and corrective attempts;
> - alert/revisit pricing if p95 provider cost approaches 3.5¢ per charged generation or if aggregate provider cost exceeds 50% of net pack receipts;
> - preserve the already-decided per-user concurrency/day limits, caching, hard wallet stop, and refunds;
> - keep packs out of Discover until observed costs prove the 4.67¢ floor is safe.
>
> Official rate cards checked:
> - https://platform.claude.com/docs/en/about-claude/pricing
> - https://developers.openai.com/api/docs/models/gpt-4o-mini
> - https://gumroad.com/help/article/66-gumroads-fees
>
> The three Gumroad products were created as unpublished drafts after this check.

---

## 3. What "one offering" means in code

An "offering" in the decision is **one wallet unit**, spent by
`services/wallet.py::preflight_deduction`. That function draws from the free
monthly allowance (`User.monthly_messages_used` against `get_monthly_cap()`)
first, and from the paid `User.offering_balance` only once the month is spent.
So "1 offering" means one unit from whichever bucket pays. It does not always
mean one unit from `offering_balance`. There is one wallet, and no new balance
column is added.

## 4. Decision line → code

| Decision line | Where it lives | Delivered in |
|---|---|---|
| Resonance pass: 1 offering | `routers/journal.py::_resonance_payment` → `preflight_deduction` | already shipped |
| First essay expansion: 1 offering | `routers/journal.py::ESSAY_PRICE_UNITS = 1`, charged in `_cache_essay` | PR1 |
| Reopening a cached essay: free | `expand_marginalia_essay` returns a cached `note.essay` before any wallet or LLM work | already shipped; pinned by a test in PR1 |
| Failed or empty result: refund | pass: `_refund_failed_pass`, `_settle_empty_pass`. Essay: `REASON_REFUND_FAILED_ESSAY` and `REASON_REFUND_NO_ESSAY` in `models/wallet_audit.py` | pass shipped; essay PR1 |
| Monthly included balance: 20 | `services/usage.py::DEFAULT_MONTHLY_CAP = 20` (the `BOTMASON_MONTHLY_CAP` env override is still honoured) | PR1 |
| Packs 50/125/300, never expire | `services/token_packs.py` → `grant_purchase_credit`; sizes are operator env (`GUMROAD_TOKEN_PACK_*`) | shipped code; the product and env setup is external (#1940/#1938) |
| 5 generations/minute/user | `services/generation_guardrails.py::GENERATIONS_PER_MINUTE_PER_USER`: a per-user moving window shared by the resonance and essay routes, peeked at admission and spent atomically after payment is staged, so cached, intimate, 404, 402, 409 and daily-refused requests never spend it. BYOK spends it too. Transcription keeps its own 20/minute. **Per worker** (limiter memory), like every other limit in `DEPLOYMENT.md`: `WEB_CONCURRENCY` x 5 per deployment; the two database-backed rows below are the cross-worker backstop | PR2 |
| 2 concurrent generations/user | `generation_slot` over the `generationslot` lease table (`UNIQUE(user_id, slot)`): cross-worker, covers resonance, essay and transcription (BYOK included), taken before any charge, released on every exit, fails closed (503). Refusal: `429 generation_in_progress`, `Retry-After` one provider timeout | PR2 |
| 100 charged generations/day/user, configurable | `services/wallet.py::preflight_deduction` (the single chokepoint for resonance, essay and transcription): net generation spends since 00:00 UTC counted from `walletaudit` after the row-locking spend, inside a savepoint. `BOTMASON_DAILY_GENERATION_CEILING` (default `DEFAULT_DAILY_GENERATION_CEILING = 100`; `0` refuses every charged generation). Refusal: `429 daily_generation_limit_reached`, `Retry-After` to the next UTC midnight. BYOK never counted | PR2 |
| Paid server usage on a cost-bounded model; Opus/Turbo BYOK/admin-only | `services/botmason.py::SERVER_PAID_REFUSED_MODELS` = {`claude-opus-5`, `claude-opus-4-7`, `gpt-4-turbo`}, refused in `generate_response` before any dial when the server key pays; the existing refund arms settle the unit. No multiplier; allowlists and pricing unchanged. "Admin-only" is not honoured: `generate_response` has no user identity, so these models are BYOK-only. **Open question:** `claude-sonnet-4-6` ($3/$15) and `gpt-4o` ($2.50/$10) were not named as Opus/Turbo and stay allowed server-paid; whether they are "cost-bounded" is for the owner | PR2 |
| Meter tokens, model, cost, refunds, cache hits, corrective attempts | `services/llm_usage.py::record_llm_usage` (tokens/model/cost, shipped); cache-hit and attempt logs | PR3 |
| p95 cost ≥ 3.5¢ alert | structured warning plus an admin metric | PR3 |
| Aggregate cost > 50% of net receipts alert | **known gap**: `GumroadSale` stores no price column, only `raw_payload` | PR3, or record the gap |

## 5. A charged depth is offered with its price on it

The in-repo rule (header of
`frontend/src/features/Journal/resonanceExplainerCopy.ts`) is: *a charged
depth is offered with its price on it, and declining costs nothing.* Charging
essays therefore brings two more changes with it:

- **No silent charge on open.** The essay modal no longer asks for a letter on
  its own when it opens. It shows the price and offers "Ask for the letter" and
  "Not now" with equal weight. A cached letter still opens straight away, with
  no price shown, because reopening is free.
- **The server enforces the disclosure.** A server-paid, uncached, non-intimate
  essay request must carry `{"price_acknowledged": true}`. Without it the
  request is refused with `409 essay_price_unacknowledged`, before any charge
  or provider call. This way an installed build that still asks automatically
  on open cannot be charged without showing the price. BYOK, cached and
  intimate requests do not need the acknowledgement, because none of them is
  charged.

## 6. Blast radius of the 20 cap: BotMason chat

The monthly allowance is **one shared wallet**. BotMason chat
(`routers/botmason.py` → `get_monthly_cap`), transcription, resonance passes
and essays all draw from it. Lowering `DEFAULT_MONTHLY_CAP` from 50 to 20
therefore also lowers **chat's** free monthly allowance from 50 to 20. The
owner's line says "Monthly included balance", which is the whole shared
allowance, so this follows from the decision. It should still be pointed out
to users.

## 7. Out of scope for the code PRs

These actions spend money, touch external accounts or need credentials. They
belong to the owner:

- publishing or configuring the Gumroad products, and the `GUMROAD_TOKEN_PACK_*`
  env values and sizes (#1940, #1938);
- keeping packs out of Discover (a Gumroad console setting);
- changing the production `BOTMASON_MONTHLY_CAP` or `LLM_MODEL` env values.
  PR1 changes only the code default. A production deployment that sets
  `BOTMASON_MONTHLY_CAP` keeps whatever value it sets;
- wiring any external pager or alert channel. Alerts ship only as structured
  log warnings or an admin-visible metric.

## 8. Known gap: the net-receipts alert

"Aggregate provider cost exceeds 50% of net pack receipts" needs the sale
price. `models/gumroad_sale.py::GumroadSale` has no price column, only
`raw_payload`. PR3 will either read the price from `raw_payload` or record this
alert as a gap with a linked product issue.
