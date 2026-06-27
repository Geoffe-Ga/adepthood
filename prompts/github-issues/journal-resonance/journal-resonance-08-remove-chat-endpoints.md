# journal-resonance-08: Remove BotMason chat endpoints (keep the wallet)

**Labels:** `backend`, `enhancement`
**Epic:** [Journal Resonance](journal-resonance-epic.md)
**Depends on:** [journal-resonance-05](journal-resonance-05-resonance-endpoints.md)
**Estimated LoC:** ~-200 (net deletion)

## Role

You are a backend engineer removing the now-replaced chat surface, leaving the
wallet/usage endpoints (still used by resonance) intact.

## Goal

Delete `POST /journal/chat`, `POST /journal/chat/stream`, and the internal
bot-reply entry path, since resonance fully replaces conversational AI. Keep
`GET /user/balance`, `GET /user/usage`, and the wallet/provider helpers that
resonance reuses.

## Context

- `backend/src/routers/botmason.py` holds chat (`/journal/chat`,
  `/journal/chat/stream`), wallet (`/user/balance`, `/user/usage`,
  `/user/balance/add`), and shared provider/wallet helpers.
- The bot-reply path creates `JournalEntry(sender="bot")` via
  `create_bot_response()` in `backend/src/routers/journal.py`.
- Do this **only after** issue 05 (resonance endpoints) is merged, so AI
  response capability is never absent from `main`.

## Tasks

1. **Remove chat routes** — delete the `/journal/chat` and `/journal/chat/stream`
   handlers and any SSE plumbing exclusive to them.
2. **Remove the bot-reply entry path** — delete `create_bot_response()` and the
   internal `POST /journal/bot-response` route. (The `sender` column can stay on
   the model for historical rows; do not write a destructive data migration.)
3. **Keep** the wallet endpoints and the provider/preflight/rate-limit/idempotency
   helpers that issues 04–06 import. If those helpers lived inside the chat
   handlers, extract them to a shared module instead of deleting them.
4. **Prune tests/fixtures** that target the removed routes; keep wallet tests.
5. **Verify** nothing else imports the removed symbols (grep the backend).

## Acceptance Criteria

- [ ] `/journal/chat` and `/journal/chat/stream` return 404 (routes gone).
- [ ] `GET /user/balance` and `GET /user/usage` still work and are tested.
- [ ] Resonance/essay endpoints still function (their wallet helpers survived).
- [ ] No dangling imports or dead references; `./scripts/backend/check-all.sh`
      green; coverage thresholds still met after deletions.

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/routers/botmason.py` | Modify (remove chat, keep wallet) |
| `backend/src/routers/journal.py` | Modify (remove `create_bot_response`) |
| `backend/src/routers/*` (shared wallet helpers) | Possibly **Create** (extract) |
| `backend/tests/test_botmason*.py` | Modify (drop chat tests, keep wallet) |

## Constraints

- Never let `main` lose AI-response capability — this lands after issue 05.
- No destructive data migrations; historical bot entries stay in the table.
- Extract, don't delete, any helper that resonance depends on.
