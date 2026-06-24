# audit-destub-06: Reconcile the BotMason model allowlist with the pricing table

**Labels:** `audit-destub`, `backend`, `data-integrity`, `priority-high`
**Epic:** De-Stub: Make Aspirational Features Real
**Estimated LoC:** ~150  (hard cap 700)

## Problem
The provider allowlist in `backend/src/services/botmason.py:105,113-122` permits models that have
**no pricing row** in `backend/src/services/llm_pricing.py:69-77` (`MODEL_PRICING`):
`gpt-4-turbo` (openai), and `claude-haiku-4-5-20251001`, `claude-opus-4-7`, `claude-sonnet-4-6`
(anthropic). When any of these is used, `estimate_cost_usd` correctly returns `None` (by design,
to distinguish "free" from "unpriced"), so every call on those models logs cost as `None` — the
per-model admin cost view is blind to them.
**Current state:** §5.1 class **fake** / drift (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md` §6, row 6).
Metering is **supposed to be real for ship**: an allowlisted model must be priced, or it must not
be reachable.

## Scope
**Covers:** closing the allowlist↔pricing gap so the two sets agree, plus a guard test that fails
if a future allowlist entry lacks a price. **Does NOT cover:** changing the `None`-for-unknown
contract in `llm_pricing.py` (that behaviour is correct and intentional — BUG-BM-008) or adding new
models beyond what the allowlist already permits.

## Tasks
1. **Add the missing pricing rows** — extend `MODEL_PRICING` with current published list prices for
   `gpt-4-turbo`, `claude-haiku-4-5-20251001`, `claude-opus-4-7`, and `claude-sonnet-4-6`, using
   the `_price("input", "output")` string-decimal helper. Cite each provider's pricing page in the
   inline comment (matching the existing table's style).
2. **Add a reconciliation guard** — add a test that iterates every `allowed_models` set in
   `PROVIDER_REGISTRY` and asserts `get_model_pricing(model) is not None` for each. This is the
   gate that prevents the drift from recurring. TDD: write it first — it fails on the four
   currently-unpriced models, then passes once they are priced.
3. **Decide the alias policy** — for floating aliases (`claude-opus-4-7`, `claude-sonnet-4-6`),
   price them at their family's current list price and add a comment noting the price tracks the
   alias; this keeps the guard green without pinning.

## Acceptance Criteria
- [ ] Every model in every `PROVIDER_REGISTRY[*].allowed_models` set has a `MODEL_PRICING` row.
- [ ] A guard test fails if any allowlisted model lacks a price (added in this issue).
- [ ] `estimate_cost_usd` no longer returns `None` for any reachable allowlisted model.
- [ ] The `None`-for-truly-unknown contract is unchanged.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on --all-files.

## Files to Create/Modify
| File | Action |
|------|--------|
| `backend/src/services/llm_pricing.py` | Modify (add 4 pricing rows) |
| `backend/tests/services/test_llm_pricing.py` | Modify (allowlist↔pricing reconciliation guard) |
