# Epic: Journal Resonance — reimagine the journal as a page you write in, with AI marginalia

**Labels:** `epic`, `enhancement`, `frontend`, `backend`
**Scope:** Backend (marginalia model + resonance/essay endpoints) + Frontend (long-form writing surface, margin notes, hovering essays) — full replacement of the chat UI
**Estimated total LoC:** ~3,200 across 19 sub-issues

## Role

You are a full-stack engineer redesigning Adepthood's Journal. You are
replacing a streaming **chat** interface (user/bot message bubbles) with a
**long-form journal page** the user writes in, where the AI responds the way a
thoughtful reader writes in the margins — short notes that highlight themes,
connections, and symbols, each of which can be opened into a full essay that
**hovers** over the page rather than scrolling past it in a conversation.

## Goal

After this epic ships, the Journal works like this:

1. The user opens a **page** and writes freely in long form (title + body).
2. When they pause typing, a friendly **"Get Resonance"** button floats into
   view (and hides again the moment they resume typing).
3. Tapping it asks the AI to read the whole entry and leave **margin notes**,
   each pinned to a specific span of the writing and labeled by **kind** —
   a recurring *theme*, a *connection* to earlier writing, or a *symbol/motif*.
4. The anchored span is highlighted inline. Tapping a margin note opens a
   **hovering essay modal** above the page — a longer letter-like expansion on
   that note, generated on demand.
5. Editing a *finished* entry is a deliberate act (a confirm dialog: "Edit
   finished entry?" → *Edit* / *Start new*). After an edit, notes **re-anchor**
   to their span where the text still exists, and are marked **stale** (dimmed,
   preserved) where it does not.

The old per-message BotMason **chat** is fully removed. Weekly prompts, search,
and practice/stage context links are **carried over** and restyled into the new
surface. The user's old **tags** (freeform/reflection/practice/habit) are
**replaced** by the AI's marginalia *kinds* — categorization moves from
something the user applies to something the AI surfaces.

## Canonical contract (every sub-issue depends on these exact shapes)

### Enums
- `MarginaliaKind` (StrEnum): `theme`, `connection`, `symbol`
- `MarginaliaStatus` (StrEnum): `active`, `stale`
- `EntryStatus` (StrEnum): `draft`, `finished`

### `Marginalia` table (`marginalia`)
| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `journal_entry_id` | int FK `journalentry.id` `ondelete=CASCADE`, indexed | owning page |
| `user_id` | int FK `user.id` `ondelete=CASCADE` | denormalized owner for auth filtering |
| `kind` | str(20) | one of `MarginaliaKind` |
| `anchor_start` | int | char offset into entry body at generation time |
| `anchor_end` | int | exclusive char offset |
| `anchor_text` | str(280) | verbatim snapshot of the anchored span (used to re-anchor) |
| `note` | str(600) | the short margin note |
| `essay` | str(10000) \| None | lazily generated full essay; `None` until expanded |
| `essay_generated_at` | datetime \| None | |
| `status` | str(20) default `active` | `active` / `stale` |
| `created_at` | datetime | |
| `updated_at` | datetime | `onupdate=now` |

### `JournalEntry` additions (the page becomes a document)
- `title: str | None` (max 200)
- `status: str(20)` default `draft` (`EntryStatus`); migration backfills existing rows to `finished`
- `updated_at: datetime` (`onupdate=now`)
- The existing `message` column **remains the body** of the page (no rename).

### REST endpoints
- `PATCH /journal/{entry_id}` — edit `message` / `title` / `status`; when
  `message` changes, re-anchor marginalia (see sub-issue 07).
- `POST /journal/{entry_id}/resonance` — run a resonance pass: the AI reads the
  body and persists a set of `Marginalia`; returns them plus wallet balances.
- `GET /journal/{entry_id}/marginalia` — list active+stale marginalia for a page.
- `POST /journal/marginalia/{marginalia_id}/essay` — lazily generate (and cache)
  the full essay for one note; idempotent (returns the cached essay if present).
- **Removed:** `POST /journal/chat`, `POST /journal/chat/stream`, and the
  bot-entry chat-reply path. `GET /user/balance` and `GET /user/usage` stay.

### Marginalia response shape (frontend + backend agree)
```jsonc
{
  "id": 12,
  "journal_entry_id": 3,
  "kind": "theme",            // theme | connection | symbol
  "anchor_start": 142,
  "anchor_end": 187,
  "anchor_text": "the river kept coming back to me",
  "note": "Water returns whenever you write about your father.",
  "essay": null,              // string once expanded
  "status": "active",         // active | stale
  "created_at": "2026-06-27T12:00:00Z",
  "updated_at": "2026-06-27T12:00:00Z"
}
```

## Output Format — sub-issues & dependency graph

Backend data + services land first and unblock the frontend surface. Frontend
component work fans out once tokens + API client exist. Chat removal lands last
on each side, after its replacement is proven.

```
Backend
  01 marginalia-model ──┬── 04 resonance-service ──┬── 05 resonance-endpoints ── 08 remove-chat-endpoints
                        │                          └── 06 essay-endpoint
                        └── 07 reanchor-on-edit
  02 entry-document ──┬── 03 patch-entry-endpoint ── 07 reanchor-on-edit
                      └── 05 resonance-endpoints

Frontend
  09 editorial-tokens ─┬── 11 writing-surface ─┬── 13 wire-resonance ── 19 remove-chat-ui
                       │                        ├── 14 margin-notes ──┬── 15 essay-modal
                       │                        │                     └── 16 edit-confirm-stale
                       │                        └── 18 weekly-prompt-context-links
                       ├── 12 get-resonance-button ── 13 wire-resonance
                       └── 17 shelf-and-search ── 18 weekly-prompt-context-links
  10 api-client ── (11, 13, 15, 17)

Deferred (not Ralph-eligible; labeled `blocked`)
  20 resonance-economy-pricing
```

## Sub-issues

| # | Title | Scope | LoC |
|---|-------|-------|-----|
| 01 | [Marginalia model + migration](journal-resonance-01-marginalia-model.md) | Backend | ~225 |
| 02 | [JournalEntry document fields](journal-resonance-02-entry-document-fields.md) | Backend | ~175 |
| 03 | [`PATCH /journal/{id}` edit endpoint](journal-resonance-03-patch-entry-endpoint.md) | Backend | ~175 |
| 04 | [Resonance generation service](journal-resonance-04-resonance-service.md) | Backend | ~275 |
| 05 | [Resonance + marginalia endpoints](journal-resonance-05-resonance-endpoints.md) | Backend | ~250 |
| 06 | [Essay expansion endpoint](journal-resonance-06-essay-endpoint.md) | Backend | ~175 |
| 07 | [Re-anchor marginalia on edit](journal-resonance-07-reanchor-on-edit.md) | Backend | ~200 |
| 08 | [Remove BotMason chat endpoints](journal-resonance-08-remove-chat-endpoints.md) | Backend | ~-200 |
| 09 | [Editorial design tokens + typography](journal-resonance-09-editorial-tokens.md) | Frontend | ~150 |
| 10 | [API client: entry/resonance/marginalia/essay](journal-resonance-10-api-client.md) | Frontend | ~200 |
| 11 | [Long-form writing surface](journal-resonance-11-writing-surface.md) | Frontend | ~300 |
| 12 | [Get Resonance floating button + useIdle](journal-resonance-12-get-resonance-button.md) | Frontend | ~200 |
| 13 | [Wire the resonance request flow](journal-resonance-13-wire-resonance.md) | Frontend | ~225 |
| 14 | [Margin notes + inline anchor highlighting](journal-resonance-14-margin-notes.md) | Frontend | ~275 |
| 15 | [Hovering resonance essay modal](journal-resonance-15-essay-modal.md) | Frontend | ~225 |
| 16 | [Edit-confirm dialog + stale notes](journal-resonance-16-edit-confirm-stale.md) | Frontend | ~200 |
| 17 | [Journal shelf + search restyle](journal-resonance-17-shelf-and-search.md) | Frontend | ~275 |
| 18 | [Weekly prompt page + context links](journal-resonance-18-weekly-prompt-context-links.md) | Frontend | ~225 |
| 19 | [Remove chat UI + dead client code](journal-resonance-19-remove-chat-ui.md) | Frontend | ~-300 |
| 20 | [Resonance economy & essay pricing](journal-resonance-20-resonance-economy.md) | Full-stack | ~150 |

## Acceptance Criteria (epic-level)

- [ ] The Journal opens to a long-form page you write in — no chat bubbles, no
      `ChatInput`, no inverted message list anywhere in the feature.
- [ ] A "Get Resonance" button appears on idle and hides while typing.
- [ ] One resonance pass produces span-anchored margin notes labeled
      theme/connection/symbol; tapping a note opens a hovering essay modal.
- [ ] Editing a finished entry requires confirmation; afterward notes re-anchor
      or are marked stale.
- [ ] Weekly prompts, search, and practice/stage context links work on the new
      surface.
- [ ] `./scripts/backend/check-all.sh` and `./scripts/frontend/check-all.sh`
      green on every sub-issue PR; coverage thresholds unchanged.

## Constraints

- **One resonance pass = one wallet charge** by default (reuse the existing
  monthly-cap + offerings wallet); finer pricing is deferred to sub-issue 20.
  Do not build a new billing system in this epic.
- Reuse the **existing LLM provider abstraction** that BotMason chat used
  (`backend/src/routers/botmason.py` provider/wallet helpers). Do not introduce
  a second provider integration.
- Marginalia anchors are **character offsets** into the body plus a verbatim
  `anchor_text` snapshot. Re-anchoring matches on `anchor_text`, never on
  offsets alone.
- The AI never writes to the page body. It only ever produces marginalia and
  essays. The body is the user's; sanitize AI output the same way user text is
  sanitized (`sanitize_user_text`).
- Keep all existing journal security guarantees: server sets ownership, soft
  delete is preserved, `user_id` is never returned in responses, search input is
  length-bounded.
- Stay within the established quality gates. No `# noqa` / `# type: ignore` /
  `// @ts-ignore` / `// eslint-disable` without an `Issue #N` justification.

## References

- `frontend/src/features/Journal/JournalScreen.tsx` — current chat orchestrator
  (to be replaced)
- `frontend/src/features/Journal/MessageBubble.tsx`,
  `ChatInput.tsx`, `Journal.styles.ts` — current chat UI (to be removed/replaced)
- `frontend/src/features/Journal/WeeklyPromptBanner.tsx` — weekly prompt (to be
  reimagined as a pre-titled page)
- `frontend/src/api/index.ts` — `journal`, `botmason`, `prompts` clients
- `frontend/src/design/tokens.ts` — design tokens (extend with editorial type)
- `backend/src/models/journal_entry.py` — `JournalEntry` + `JournalTag`
- `backend/src/routers/journal.py` — journal CRUD
- `backend/src/routers/botmason.py` — chat + wallet (chat path removed; wallet kept)
- `backend/src/schemas/journal.py` — journal DTOs
