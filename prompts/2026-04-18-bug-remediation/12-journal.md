# Journal Bug Report — 2026-04-18

**Scope:** `backend/src/routers/journal.py` (157 LOC), `backend/src/services/journal.py` (98 LOC). Covers journal entry CRUD, list/search, BotMason chat-turn persistence, and the LLM conversation-recency helper.

**Total bugs: 10 — 1 Critical / 4 High / 5 Medium / 0 Low**

## Executive Summary

1. **Stored XSS risk (Critical).** BUG-JOURNAL-003: journal message content is persisted verbatim with no sanitization. If the React Native client ever renders journal HTML (markdown preview, share-to-web) — or an admin dashboard does — a prior entry can inject script. User journals also flow into BotMason prompts, so prompt-injection against the LLM is a second vector.
2. **Server doesn't constrain user-controlled write fields (High).** BUG-JOURNAL-001: `message` has no server-side length cap; a user can store multi-megabyte rows. BUG-JOURNAL-002: `sender` is free-form text (pairs with BUG-MODEL-004) so a client can submit `sender="bot"` to plant fake AI replies in their own history.
3. **Cross-tenant & PII leaks (High).** BUG-JOURNAL-004: `JournalMessageResponse` and the older `JournalEntry` response echo `user_id`. BUG-JOURNAL-006: 404 path uses `session.get` then checks ownership — timing side-channel leaks entry-id existence across tenants.
4. **Hard delete + chat pollution (High/Medium).** BUG-JOURNAL-007: hard delete has no audit trail or FK safety for `LLMUsageLog.journal_entry_id`. BUG-JOURNAL-008: `load_recent_conversation` pulls deleted and cross-sender rows into subsequent LLM prompts, polluting BotMason context and potentially re-materializing content the user deleted.
5. **Pagination, search and idempotency gaps (Medium).** BUG-JOURNAL-005: bespoke `JournalListResponse` envelope (pairs with BUG-SCHEMA-005). BUG-JOURNAL-009: `ILIKE '%term%'` search on unbounded text with no index. BUG-JOURNAL-010: no idempotency key — double-tap = duplicate entry + double LLM billing.

## Table of Contents

| # | ID | Severity | Component | Title |
|---|----|----------|-----------|-------|
| 1 | BUG-JOURNAL-003 | Critical | `routers/journal.py` | No HTML / script sanitization on stored message |
| 2 | BUG-JOURNAL-001 | High | `routers/journal.py` | No server-side cap on `message` length |
| 3 | BUG-JOURNAL-002 | High | `routers/journal.py` | `sender` is free-form; client can forge `bot` replies |
| 4 | BUG-JOURNAL-004 | High | `routers/journal.py` | `JournalMessageResponse` leaks `user_id` |
| 5 | BUG-JOURNAL-007 | High | `routers/journal.py` | Hard delete — no audit, unsafe against `LLMUsageLog` FK |
| 6 | BUG-JOURNAL-005 | Medium | `routers/journal.py` | Bespoke pagination envelope vs `Page[T]` |
| 7 | BUG-JOURNAL-006 | Medium | `routers/journal.py` | `session.get` before ownership check — timing side channel |
| 8 | BUG-JOURNAL-008 | Medium | `services/journal.py` | `load_recent_conversation` pulls deleted/cross-sender rows |
| 9 | BUG-JOURNAL-009 | Medium | `routers/journal.py` | `ILIKE '%term%'` search, no index, no length cap |
| 10 | BUG-JOURNAL-010 | Medium | `routers/journal.py` | No idempotency — double-tap duplicates + double LLM billing |

---

# Fragment 12 — Journal Backend Surface

Scope: `backend/src/routers/journal.py` (157 LOC) and `backend/src/services/journal.py` (98 LOC).

---

### BUG-JOURNAL-001 — No server-side cap on journal message length (Severity: High)

**Component:** `backend/src/routers/journal.py:41` (`create_journal_entry`), `backend/src/routers/journal.py:135` (`create_bot_response`)

**Symptom:** `JournalMessageCreate.message` is inserted straight into `JournalEntry.message` with no length validation at the router layer. A malicious or buggy client can persist multi-megabyte rows, blowing up storage, the conversation-history prompt window, and the list endpoint's JSON payload.

**Root cause:**
```python
@router.post("/", response_model=JournalMessageResponse, status_code=status.HTTP_201_CREATED)
async def create_journal_entry(
    payload: JournalMessageCreate,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> JournalEntry:
    """Create a journal message for the authenticated user."""
    entry = JournalEntry(sender="user", user_id=current_user, **payload.model_dump())
    session.add(entry)
    await session.commit()
```

**Fix:** Add `max_length` (e.g. 8_000 chars) and a newline cap (`\n` count <= 200) to `JournalMessageCreate.message` via `StringConstraints` / a `field_validator`. Mirror the same validator on `JournalBotMessageCreate`. Reject with 422 before the DB round-trip so we do not pay storage cost for malformed input.

**Cross-references:** BUG-SCHEMA-005.

---

### BUG-JOURNAL-002 — `sender` column is unconstrained free-form text (Severity: High)

**Component:** `backend/src/routers/journal.py:48`, `backend/src/services/journal.py:55,74` (all three `JournalEntry(sender=..., ...)` call sites)

**Symptom:** Per BUG-MODEL-004, `JournalEntry.sender` is an unvalidated `str(max_length=10)`. The router currently writes the hardcoded literals `"user"` and `"bot"`, but any future reviewer or service that forgets to pin the literal can store `"system"`, `"admin"`, `"bot "` (trailing space), or an attacker-controlled value injected through a bulk-import path. Downstream logic (`load_recent_conversation`, client rendering) then receives ambiguous role tags.

**Root cause:**
```python
entry = JournalEntry(sender="user", user_id=current_user, **payload.model_dump())
# ...
entry = JournalEntry(sender="bot", user_id=current_user, **payload.model_dump())
```

**Fix:** Replace the column with a `JournalSender` enum (`"user" | "bot"`) at the model layer and pass the enum member at the call sites. Persist the enum value and validate on read so existing rows with stray whitespace or casing are normalised.

**Cross-references:** BUG-MODEL-004.

---

### BUG-JOURNAL-003 — No HTML / script sanitisation on stored message (Severity: Critical)

**Component:** `backend/src/routers/journal.py:48,150` (`create_journal_entry`, `create_bot_response`)

**Symptom:** Journal entries are rendered in the React Native chat feed and on the web mirror. The router stores the raw `message` string verbatim. A payload like `<img src=x onerror=alert(1)>` or a crafted markdown-link-with-javascript flows through untouched; if any frontend renderer uses `dangerouslySetInnerHTML`, a `WebView`, or a markdown renderer with HTML passthrough, this is stored XSS. Server-side is the right place to normalise because the same row is consumed by the LLM prompt builder in `load_recent_conversation`.

**Root cause:**
```python
entry = JournalEntry(sender="user", user_id=current_user, **payload.model_dump())
session.add(entry)
await session.commit()
await session.refresh(entry)
logger.info("journal_entry_created", extra={"user_id": current_user, "entry_id": entry.id})
return entry
```

**Fix:** Add a `sanitize_plaintext()` helper (strip control chars, reject null bytes, escape lone `<`/`>` or run through `bleach.clean(strip=True)` with an empty allowlist) and apply it in the schema `field_validator`. Document in `JournalMessageResponse` that the server returns plaintext-safe content; audit every frontend render site to confirm it never unescapes.

**Cross-references:** BUG-SCHEMA-005.

---

### BUG-JOURNAL-004 — `JournalMessageResponse` leaks `user_id` to clients (Severity: High)

**Component:** `backend/src/routers/journal.py:41,106,135` — all endpoints return `JournalMessageResponse` built from `JournalEntry`

**Symptom:** Since FastAPI serialises via `JournalMessageResponse.model_validate(e, from_attributes=True)` (see list endpoint) and by `response_model` inference for POST/GET/DELETE, any attribute on the response schema named `user_id` will be populated. Even if it is stripped today, the three endpoints use divergent paths — POST/GET return the ORM instance directly and let FastAPI coerce it, while the list endpoint validates explicitly. The asymmetry means a future schema field (`user_id`, `ip_hash`, `raw_sentiment_payload`) gets leaked silently on the POST path.

**Root cause:**
```python
return JournalListResponse(
    items=[JournalMessageResponse.model_validate(e, from_attributes=True) for e in items],
    total=total,
    has_more=(filters.offset + filters.limit) < total,
)
# ...
# Elsewhere (GET, POST) the ORM object is returned directly:
return entry  # FastAPI coerces via response_model
```

**Fix:** Unify the serialisation path — always call `JournalMessageResponse.model_validate(entry, from_attributes=True)` in the router so field exposure is controlled in one place. Add a `model_config = ConfigDict(extra="forbid")` on the response schema and write a regression test asserting `"user_id" not in response.json()`.

**Cross-references:** BUG-SCHEMA-005.

---

### BUG-JOURNAL-005 — Bespoke pagination envelope instead of `Page[T]` (Severity: Medium)

**Component:** `backend/src/routers/journal.py:78-103` (`list_journal_entries`)

**Symptom:** The list endpoint returns a one-off `JournalListResponse(items, total, has_more)` shape while the rest of the backend standardises on `Page[T]` (`items`, `total`, `limit`, `offset`, `next_offset`). Frontend clients have to special-case journal pagination — see BUG-FRONTEND-API mirrors — and `has_more` silently flips wrong when `offset + limit == total` due to the strict `<` comparison on an incrementing list (edge case: exactly the last page renders "load more" until the user scrolls once and gets an empty page).

**Root cause:**
```python
return JournalListResponse(
    items=[JournalMessageResponse.model_validate(e, from_attributes=True) for e in items],
    total=total,
    has_more=(filters.offset + filters.limit) < total,
)
```

**Fix:** Replace `JournalListResponse` with the shared `Page[JournalMessageResponse]` schema and derive `next_offset` server-side (`None` when exhausted). Update the OpenAPI snapshot tests and the frontend client type in lockstep.

**Cross-references:** BUG-SCHEMA-005, BUG-FRONTEND-API-004.

---

### BUG-JOURNAL-006 — `not_found` surface may leak entry existence across tenants (Severity: Medium)

**Component:** `backend/src/routers/journal.py:113-116,126-128` (`get_journal_entry`, `delete_journal_entry`)

**Symptom:** Both handlers do `session.get(JournalEntry, entry_id)` and only then compare `entry.user_id != current_user`. The two branches — "no row at all" and "row belongs to another user" — collapse to the same `not_found("journal_entry")`, which is good. But because the fetch happens before auth scoping, a timing side-channel remains (a SELECT on an existing foreign row vs. a miss), and the `session.get` warms SQLAlchemy's identity map, so a subsequent handler in the same request could inadvertently read the cross-tenant row.

**Root cause:**
```python
entry = await session.get(JournalEntry, entry_id)
if entry is None or entry.user_id != current_user:
    raise not_found("journal_entry")
```

**Fix:** Scope the fetch via `SELECT ... WHERE id = :id AND user_id = :user_id` using `session.execute(select(...).where(...))` so cross-tenant rows never enter the identity map. Document the pattern once in a `_get_owned_entry()` helper and reuse it from both handlers.

**Cross-references:** BUG-HABIT-006.

---

### BUG-JOURNAL-007 — Hard delete with no audit trail or undo window (Severity: High)

**Component:** `backend/src/routers/journal.py:119-132` (`delete_journal_entry`)

**Symptom:** Journal entries are a core user-authored artefact (the whole point of the product). `session.delete(entry)` irrevocably removes the row, and since `LLMUsageLog` holds an FK to `journal_entry_id` (see `services/journal.py:95`), a bot-response delete either cascades into billing/usage history loss or fails at the DB with an opaque 500. There is no `deleted_at` soft-delete, no 30-day recovery window, and the log line records only the ID — not the content — so support cannot restore an entry a user deletes by mistake.

**Root cause:**
```python
entry = await session.get(JournalEntry, entry_id)
if entry is None or entry.user_id != current_user:
    raise not_found("journal_entry")
await session.delete(entry)
await session.commit()
logger.info("journal_entry_deleted", extra={"user_id": current_user, "entry_id": entry_id})
```

**Fix:** Add a nullable `deleted_at: datetime | None` column on `JournalEntry`, convert delete to a soft-delete that stamps `deleted_at = utcnow()`, and filter `deleted_at IS NULL` in all read paths (list, get, `load_recent_conversation`). Ship a separate nightly hard-purge job that respects a configurable retention window.

**Cross-references:** BUG-MODEL-004.

---

### BUG-JOURNAL-008 — `load_recent_conversation` leaks deleted and cross-sender noise into LLM prompts (Severity: Medium)

**Component:** `backend/src/services/journal.py:21-40` (`load_recent_conversation`)

**Symptom:** The history query filters only by `user_id` and orders by `id DESC` with `CONVERSATION_HISTORY_LIMIT`. It has no filter for deleted rows (see BUG-JOURNAL-007), no filter for `tag` or `practice_session_id` (so untagged private journal entries bleed into a BotMason chat context the user didn't opt into), and no `sender IN (...)` constraint — if a future bug writes `sender="system"`, it poisons the prompt. Additionally, ordering by `id DESC` is not equivalent to chronological order if `JournalEntry` ever gets a natural-key backfill or timezone-aware `created_at`.

**Root cause:**
```python
history_query = (
    select(JournalEntry)
    .where(JournalEntry.user_id == user_id)
    .order_by(col(JournalEntry.id).desc())
    .limit(CONVERSATION_HISTORY_LIMIT)
)
result = await session.execute(history_query)
entries = list(reversed(result.scalars().all()))
return [{"sender": entry.sender, "message": entry.message} for entry in entries]
```

**Fix:** Filter `JournalEntry.deleted_at.is_(None)`, `JournalEntry.sender.in_([JournalSender.USER, JournalSender.BOT])`, and scope by "chat thread" (e.g. `practice_session_id IS NULL` or an explicit `conversation_id`). Order by `created_at DESC, id DESC` once timestamps are trustworthy.

**Cross-references:** BUG-MODEL-004, BUG-JOURNAL-007.

---

### BUG-JOURNAL-009 — Search uses `ILIKE '%term%'` with no full-text index or length cap (Severity: Medium)

**Component:** `backend/src/routers/journal.py:56-75` (`_escape_like`, `_build_filter_conditions`)

**Symptom:** `filters.search` has no `max_length` constraint (nothing in `_ListFilters` bounds it) and is interpolated into an unanchored `%search%` `ILIKE` against the full `message` column. On a user with thousands of entries this forces a sequential scan every time; worse, a 100 KB search string is quietly accepted, escaped, and sent to Postgres, where it becomes a quadratic pattern match. There is no rate-limit budget distinction between search hits and simple list calls — both share the `30/minute` limit.

**Root cause:**
```python
@dataclass
class _ListFilters:
    search: str | None = Query(default=None)
    tag: JournalTag | None = None
    practice_session_id: int | None = Query(default=None)
    limit: int = Query(default=50, ge=1, le=200)
    offset: int = Query(default=0, ge=0)

# ...
if filters.search is not None:
    escaped = _escape_like(filters.search)
    conditions.append(col(JournalEntry.message).ilike(f"%{escaped}%", escape="\\"))
```

**Fix:** Constrain `search` to `Query(default=None, min_length=2, max_length=200)` and add a GIN trigram index (`pg_trgm`) on `JournalEntry.message` via an Alembic migration. Long-term, split "search" onto its own rate-limit bucket (e.g. `10/minute`) so a hot loop cannot crowd out normal list reads.

**Cross-references:** None.

---

### BUG-JOURNAL-010 — No idempotency key on POST endpoints; double-tap creates duplicates (Severity: Medium)

**Component:** `backend/src/routers/journal.py:41-53,135-157` (`create_journal_entry`, `create_bot_response`)

**Symptom:** Mobile clients retry aggressively on flaky networks. Both POST handlers commit unconditionally — no `Idempotency-Key` header, no dedup on `(user_id, message, created_at within 2s)`. A user who taps "send" twice ends up with two identical journal rows, and `create_bot_response` can double-bill an `LLMUsageLog` entry because `persist_bot_reply` is invoked twice for the same upstream LLM call. The log line at the end of each handler silently records both as legitimate, hiding the defect from observability.

**Root cause:**
```python
async def create_journal_entry(
    payload: JournalMessageCreate,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> JournalEntry:
    """Create a journal message for the authenticated user."""
    entry = JournalEntry(sender="user", user_id=current_user, **payload.model_dump())
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    logger.info("journal_entry_created", extra={"user_id": current_user, "entry_id": entry.id})
    return entry
```

**Fix:** Accept an optional `Idempotency-Key` header, hash it with `user_id`, and persist it on `JournalEntry` behind a unique index. On a duplicate, return the previously-created row with `200 OK` (instead of `201`). Apply the same pattern to `create_bot_response` so `LLMUsageLog` cannot be double-written.

**Cross-references:** BUG-FRONTEND-API-004.

---

## Suggested Remediation Order

1. **BUG-JOURNAL-003** (Critical) — Run every user-submitted `message` through a strict sanitizer (bleach, nh3) before persistence OR guarantee that every consumer (mobile app, web admin, LLM prompt) treats it as text and never as HTML. Add a regression test asserting `<script>` round-trips inert.
2. **BUG-JOURNAL-001** (High) — Add `message: str = Field(min_length=1, max_length=8000)` to `JournalMessageCreate`. Add a DB-level `CHECK (length(message) <= 8000)` in a migration.
3. **BUG-JOURNAL-002** (High) — Promote `sender` to `Literal["user", "bot"]` / an Enum (pair with BUG-MODEL-004). Reject client-sent `sender="bot"` and set it server-side: `user` on the POST, `bot` only when the BotMason service writes.
4. **BUG-JOURNAL-004** (High) — Define a DTO with `model_config = ConfigDict(from_attributes=True)` that excludes `user_id`. Apply to every journal endpoint.
5. **BUG-JOURNAL-007** (High) — Switch to soft-delete (`deleted_at`). Cross-check `LLMUsageLog.journal_entry_id` FK has `ondelete="SET NULL"` (pair with BUG-MODEL-002). Emit an audit log on delete.
6. **BUG-JOURNAL-008** (Medium) — `load_recent_conversation` must filter `deleted_at IS NULL` and scope by sender as the caller expects. Add a pytest asserting deleted rows are never re-sent to the LLM.
7. **BUG-JOURNAL-006** (Medium) — Push the ownership filter into the `WHERE` clause (`JournalEntry.user_id == current_user`) so the DB returns `None` in one round-trip regardless of existence.
8. **BUG-JOURNAL-005** (Medium) — Migrate to the shared `Page[T]` envelope.
9. **BUG-JOURNAL-009** (Medium) — Cap `term` at `max_length=64`, require `min_length=3`. Add a `pg_trgm` GIN index on `message`. Fall back to a slower `ILIKE` only when the query is longer than the trigram minimum.
10. **BUG-JOURNAL-010** (Medium) — Require `Idempotency-Key` header on POST, or dedupe on `(user_id, sender, message, truncated_timestamp)`.

## Cross-References

- **BUG-SCHEMA-005** (JournalListResponse bespoke envelope) — router-side mirror is BUG-JOURNAL-005.
- **BUG-MODEL-004** (JournalEntry.sender unconstrained `str(max_length=10)`) — BUG-JOURNAL-002 is the router/API layer pair.
- **BUG-MODEL-002** (FK `user_id` no `ondelete`) — BUG-JOURNAL-007 surfaces the downstream hazard.
- **BUG-HABIT-006** / **BUG-STREAK-002** / **BUG-GOAL-004** (UTC day boundaries) — any future "today's entries" filter will need the same ZoneInfo treatment.
- **BUG-API-006** (client signup persists dummy user) — BUG-JOURNAL-004's `user_id` leak becomes more dangerous when dummy `user_id=0` rows mix with real ones.
- **BUG-ADMIN-004** (estimated_cost_usd drift) — BUG-JOURNAL-010 double-billing is a direct amplifier.
- **BUG-AUTH-018** / **BUG-MODEL-001** (no admin flag) — BUG-JOURNAL-007 audit requires admin identity to be meaningful.
