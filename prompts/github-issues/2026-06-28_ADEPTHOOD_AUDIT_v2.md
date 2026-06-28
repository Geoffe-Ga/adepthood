# Adepthood Audit v2 — Regression & Post-Pivot Consistency

**Date:** 2026-06-28
**Branch:** `claude/adepthood-audit-v2-x3q6sw`
**Author:** automated audit per `2026-06-23_...AUDIT_AND_AUTONOMOUS_BACKLOG_PROMPT` v2
**Scope:** Verify shipped phases hold on `main`, hunt post-pivot (chat → Resonance)
debris, reconcile the monetization epic, and confirm the Phase 7 stubs.

---

## 1. Baseline gate state

| Gate | Result |
|------|--------|
| Backend `pytest` (full suite + coverage) | ✅ green — **95.96%** line coverage, `--cov-fail-under=90` satisfied |
| Backend `ruff` / `mypy` (changed files) | ✅ clean |
| Frontend `tsc --noEmit` (whole project) | ✅ exit 0 |
| Frontend `jest` (`errorMessages`) | ✅ 29/29 |
| Frontend `eslint` / `prettier` (changed files) | ✅ clean |
| `pre-commit run` (orchestration) | ⚠️ **blocked** — the agent egress policy returns 403 for `github.com`, so pre-commit cannot fetch its hook repos. Underlying tools (ruff, mypy, eslint, prettier, tsc, pytest, jest) were run directly instead and pass. This is an environment/policy limitation (§4.2), not a code defect. |

**Conclusion:** `main` is healthy. The shipped phases hold; the highest-value
finding is **doc drift**, not broken code.

---

## 2. Headline finding — the planning docs drifted ahead of `main`

The v2 prompt's three "highest-value targets" are largely **already done in
code**; the planning docs simply hadn't caught up:

- **Phase 7-05 "complete stubs" — all three already implemented:**
  - `domain/stage_progress.py` computes real `habits_progress` (from
    `GoalCompletion`), `course_items` (from `ContentCompletion`), and a dynamic
    divisor (`_average_present`) — the hardcoded `0.0 / 0 / 2` are gone, and a
    batched 3-query variant kills the `list_stages` N+1 (#473).
  - `routers/energy.py` persists plans to the `energyplan` table via
    `get_or_create_persisted_plan` (no in-memory TTL); CPU work runs off-loop.
  - `services/botmason.py` has real LLM error handling: retry set
    `{429,500,502,503,504}`, `_is_retryable`, 30s timeout, SDK-agnostic
    `LLMProviderError` mapped to friendly copy.
  - → `phase-7-05-complete-stubs.md` rewritten to mark these complete and the
    mis-titled "Phase 6-05" header corrected. (commit `134e564`)

- **Phase 4 N+1 concern (#473) is addressed** via `compute_stage_progress_batch`
  and the JOIN-aggregate history helpers in `stage_progress.py`.

The lesson for the autonomous loop: **inspect code before trusting any "todo"
doc** — several open epics may already be satisfied.

---

## 3. Post-pivot debris inventory (chat → Resonance)

BotMason **chat** was removed (#654 backend, #665 frontend) and replaced by the
Resonance + Marginalia journal. A full sweep of `frontend/` and `backend/`
(code, types, tests, fixtures, nav, env, copy) found the removal was clean —
**no orphaned routes, no dead chat screens, no live `/journal/chat` handlers,
and a regression test that asserts the chat send button is absent**
(`JournalEntryScreen.test.tsx`). Remaining debris was cosmetic/textual:

| Item | path | Class | Disposition |
|------|------|-------|-------------|
| User-facing error copy said "start chatting", "messages per minute", "send the same message", "messages for the month" | `frontend/src/api/errorMessages.ts` | UX / copy debris | **FIXED** (commit `2621fc3`) — re-expressed against Resonance + regression test |
| Stale docstrings naming `/journal/chat` | `errorMessages.ts` helper, `Settings/ApiKeySettingsScreen.tsx` | doc drift | **FIXED** (`2621fc3`) |
| `botmason.py` module docstring claimed "multi-turn chat"; dead `CONVERSATION_HISTORY_LIMIT` constant | `backend/src/services/botmason.py` | dead code + doc drift | **FIXED** (`ef5a9fa`) |
| `chat_spend.py` / `llm_usage_log.py` docstrings named removed endpoints | `backend/src/models/` | doc drift | **FIXED** (`ef5a9fa`) |
| `ChatSpend` model/table unused at runtime (still schema-contract-tested) | `backend/src/models/chat_spend.py` | aspirational/retained | **LEFT** — dropping needs a migration (§4.2 destructive flag); docstring now explains retention for Resonance idempotency |
| Wallet fields `monthly_messages_used`, `spend_one_message` | `backend/src/services/wallet.py`, `models/user.py` | legitimate retained | **LEFT** — renaming breaks migrations + API contract; "message" now means a Resonance generation, correctly debited once per pass |
| "BotMason" persona name in Resonance system prompt | `botmason.py` | legitimate | **LEFT** — persona, not the chat product |

---

## 4. Monetization reconciliation note (Phase 6)

`phase-6-epic.md` still described the metered LLM resource as **"BotMason
chat … debited as the user chats"**. Chat no longer exists. Reconciled
(commit `134e564`):

- The metered resource is now a **Resonance generation** (essay + anchored
  marginalia), debited once per request via
  `routers/journal.py` → `services/wallet.py:spend_one_message`.
- The kept wallet/`offering_balance` survives the pivot; the BYOK
  `X-LLM-API-Key` bypass is unchanged.
- The zero-balance error is `insufficient_offerings` (the code the frontend
  already maps), not a hypothetical `insufficient_tokens`.
- **Detailed Resonance pricing is explicitly deferred under #623** ("Resonance
  economy & essay pricing"). Do **not** build chat-turn billing. Phase 6 access
  gating (Gumroad license required to sign up) is independent of the pricing
  question and can proceed.

---

## 5. Resonance journal — end-to-end verification

The Resonance surface is fully present and tested:

- Frontend `features/Journal/`: `JournalShelfScreen` (landing + editorial
  search), `JournalEntryScreen` (long-form), `GetResonanceButton` +
  `useResonance` + idle trigger, `ResonanceEssayModal`, `MarginNote` /
  `HighlightedBody` / `highlightSegments.ts`, `EditConfirmDialog` for
  stale-note edits — **9 test files** cover these components.
- Backend: `routers/journal.py` (resonance + lazy essay expansion),
  `services/marginalia.py` (`BotmasonResonanceLLM` adapter passing a single
  turn), `domain/resonance.py` (pure margin-note generation),
  `journal_encryption.py` (encryption at rest), all green in the suite.

No regressions observed.

---

## 6. Top items that affect a real user right now

1. ✅ **Misleading post-pivot error copy** — users were told to "start
   chatting" / slow down "messages per minute" for a chat UI that no longer
   exists. **Fixed this session.**
2. **Phase 6 access gating not yet wired** — signup does not yet require a
   Gumroad license (epic active, not shipped). Highest *product* gap; pricing
   piece deferred (#623).
3. **`ChatSpend` table retained but unused** — harmless, but a future migration
   should either repurpose it explicitly for Resonance idempotency or drop it.
   Flag, don't rush (destructive migration).

---

## 7. Recommendations for the loop

- Treat the open EPIC issues (#459–#496, #463) as **candidates to verify against
  code first** — at least the de-stub and N+1 buckets appear already satisfied.
- Phase 6 access-gating sub-issues (`phase-6-01/02/03`) are the most valuable
  remaining *product* work; they are independent of the deferred pricing (#623).
- Keep doc-vs-code reconciliation in the loop: drift, not bugs, is the dominant
  defect class on this codebase right now.
