# Prompt 12 — Backend feature routers hardening (Wave 4, parallelizable across two sub-prompts)

## Role
You are a backend engineer closing out feature-router hygiene: habits, goals, practices, journal, course, prompts, and BotMason/LLM wallet correctness. You work in small, reviewable commits and always prefer server truth.

## Goal
Fix High-severity bugs in reports 09-15 that are NOT covered by earlier prompts. The scope is large; **split into two parallel sub-prompts (12A and 12B)** below to avoid Stream Idle timeouts. Each sub-prompt is self-contained.

Success criteria: every High-severity bug listed in the two sub-scopes below is closed; Medium items triaged (fix or defer with a noted reason); coverage stays >=90%.

## Context — split the work

### Prompt 12A — Habits, Goals, Course, Prompts routers
Bug IDs:
- Report 09 (habits): BUG-STREAK-001 (missed-day reset ignores `notification_days`), BUG-HABIT-004 (delete_habit no cascade), plus Medium items -002/-003/-005/-007 and L -008. Skip -001/-006 [done-by-07/05].
- Report 10 (goals): BUG-GOAL-002 (streak from pre-insert state), -003 (three-step write not transactional), -007 (`did_complete=False` not idempotent; backdating uncapped), -010 (`achieved_milestones` silent-success stub), plus Medium -008/-009. Skip -001/-004/-005/-006 [done-by-06/05/07].
- Report 14 (course): BUG-STAGE-002 (`current_stage` vs `completed_stages` drift), plus Medium -004/-005 and BUG-COURSE-003/-004/-005. Skip -001/-002/-003 [done-by-03/06].
- Report 15 (prompts): BUG-PROMPT-003 already in Prompt 04 (sanitization); BUG-PROMPT-004 already in Prompt 06; **remaining**: Medium -005/-006/-008/-010 and L -007/-009. All prompt-flow UX + pagination issues.

Files (expect ≤14): `backend/src/routers/{habits,goals,course,stages,prompts}.py`, `backend/src/domain/{streaks,goals,progression}.py`, tests.

### Prompt 12B — Practices, Journal, BotMason/LLM wallet
Bug IDs:
- Report 11 (practices): BUG-PRACTICE-002 (`submit_practice` model_dump splats future fields), plus Medium -003/-007/-009/-010 and L -008. Skip -001/-004/-005/-006 [done-by-07/03/06/09].
- Report 12 (journal): BUG-JOURNAL-001 (no server-side cap on message length), -007 (hard delete, no audit, unsafe against FK), plus Medium -005/-006/-008/-009/-010. Skip -002/-003/-004 [done-by-07/04/07].
- Report 13 (botmason/wallet/llm): BUG-BM-001 (model from env fallback, no allowlist), -003 (retry double-counts cost on partial completion), -006 (dropped client doesn't cancel upstream LLM), -007 (`CollectedStream` buffers whole response), -012 (no idempotency on chat spend), -013 (no refund on failed LLM call), plus Medium -005/-009/-014/-015. Skip -002/-004/-008/-010/-011 [done-by-02/04/10/02/10].

Files (expect ≤14): `backend/src/routers/{practices,journal,botmason}.py`, `backend/src/domain/{practice,journal,llm,wallet}.py`, tests.

## Output Format
Run Prompts 12A and 12B in parallel on separate branches (or sequentially on one branch). Within each, group commits by domain:

**Prompt 12A commits:**
1. `fix(backend): habit streak notification_days + hard-delete cascade (BUG-STREAK-001, BUG-HABIT-004, Medium items)`.
2. `fix(backend): goal completion transaction + idempotency + milestones (BUG-GOAL-002/-003/-007/-010, Medium items)`.
3. `fix(backend): stage progress drift + course list hardening (BUG-STAGE-002, BUG-COURSE-003/-004/-005)`.
4. `fix(backend): weekly-prompt UX + pagination (Medium/Low BUG-PROMPT items)`.

**Prompt 12B commits:**
1. `fix(backend): practice submit whitelist + Medium items (BUG-PRACTICE-002, -003/-007/-009/-010)`.
2. `fix(backend): journal length cap + soft delete + Medium items (BUG-JOURNAL-001/-007, Medium items)`.
3. `fix(backend): LLM model allowlist; stream passthrough; upstream cancel; idempotency + refund (BUG-BM-001/-003/-006/-007/-012/-013, Medium items)`.

## Examples

Model allowlist:
```python
_ALLOWED_MODELS = frozenset({
    "claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001",
})
def resolve_model(requested: str | None) -> str:
    model = requested or settings.default_model
    if model not in _ALLOWED_MODELS:
        raise HTTPException(400, f"model not allowed: {model}")
    return model
```

Idempotent chat spend:
```python
# Accept Idempotency-Key header; dedupe in a table keyed by (user_id, idempotency_key).
existing = await session.scalar(
    select(ChatSpend).where(ChatSpend.user_id == user.id, ChatSpend.idem_key == key)
)
if existing:
    return existing.result
```

True stream (no buffering):
```python
async def stream_response() -> AsyncIterator[bytes]:
    async with provider.chat_stream(...) as upstream:
        async for chunk in upstream:
            yield chunk  # no .collect() / no .join()
```

## Requirements
- `concurrency` skill for the LLM upstream-cancel + idempotency bits.
- `security` for the LLM model allowlist: never let the client choose an arbitrary model.
- `max-quality-no-shortcuts`: refund path must be audited — no silent `pass` on failure.
- `bug-squashing-methodology`: RCA + failing test for each High-severity bug.
- Medium/Low items: fix if cheap; otherwise add a "deferred" note in the bug report file and move on.
- Each sub-prompt MUST stay within its file list; if a bug crosses sub-prompt boundaries (e.g., LLM wallet touches goal completion), defer and note.
- `pre-commit run --all-files` before each commit; coverage >=90%.
- Parallelizable with Prompts 11, 13, 14, 15 — no file overlap.
- Do NOT retouch bugs owned by Prompts 01-10; trust the earlier commits.
