# phase-3-07: Integrate BotMason AI with offering_balance metering

**Labels:** `phase-3`, `frontend`, `backend`, `feature`, `ai`, `priority-medium`
**Epic:** Phase 3 — Build Missing Features
**Depends on:** phase-3-03, phase-3-06
**Estimated LoC:** ~250 backend, ~100 frontend

## Problem

The spec describes BotMason as:

> "Chat interface with BotMason — your Liminal Trickster Mystic guide"
> "BotMason should respond intelligently based on keywords related to the APTITUDE program, The Archetypal Wavelength, and the transition from 'Liminal Creep' to 'Whole Adept.'"
> "AI usage metered via `offering_balance`"

The `User` model has `offering_balance: int = Field(default=0)` — a credit-based system for AI access. BotMason responses should cost credits, and users with zero balance should see a message about needing more offerings.

The spec also mentions: "I will provide a system prompt and documents to reference for BotMason" — the system prompt and reference documents will be provided later, but the integration infrastructure needs to exist.

## Scope

Build the AI integration layer: backend endpoint that calls an LLM, stores the response as a `JournalEntry` with `sender: 'bot'`, and deducts from `offering_balance`.

## Tasks

### Backend

1. **Create `backend/src/services/botmason.py`**
   - `generate_response(user_message: str, conversation_history: list, system_prompt: str) -> str`
   - Calls OpenAI API (or configurable LLM provider via environment variable)
   - Includes conversation history for context (last N messages)
   - System prompt loaded from a config file or database
   - Returns the bot's response text

2. **Create `backend/src/routers/botmason.py`**
   - `POST /journal/chat` — The main chat endpoint:
     1. Check `user.offering_balance > 0` — if not, return 402 with "Insufficient offerings"
     2. Store user's message as `JournalEntry(sender='user')`
     3. Load recent conversation history (last 20 messages)
     4. Call `botmason.generate_response()`
     5. Store bot's response as `JournalEntry(sender='bot')`
     6. Deduct 1 from `user.offering_balance`
     7. Return bot's response + remaining balance

3. **Create `backend/src/schemas/botmason.py`**
   - `ChatRequest`: `message: str`
   - `ChatResponse`: `response: str`, `remaining_balance: int`, `bot_entry_id: int`

4. **Add offering_balance management**
   - `GET /user/balance` — Current balance
   - `POST /user/balance/add` — Add credits (for admin/payment integration later)

5. **Configuration**
   - `BOTMASON_SYSTEM_PROMPT` — path to system prompt file or inline text
   - `LLM_PROVIDER` — "openai" | "anthropic" | "local"
   - `LLM_API_KEY` — API key for the chosen provider
   - Add to `.env.example`

### Frontend

6. **Update ChatInput.tsx** (from phase-3-06)
   - After sending a user message, call `POST /journal/chat` instead of just `POST /journal/`
   - Show a typing indicator while waiting for BotMason's response
   - Display remaining offering balance in the UI (subtle counter)
   - If balance is 0, show a "BotMason is resting" message and disable AI chat (user can still write freeform journal entries via `POST /journal/`)

7. **Add balance display to Journal header**

## Acceptance Criteria

- User sends a message → BotMason responds with contextually relevant text
- Response stored as `JournalEntry(sender='bot')` and appears in chat history
- Each AI interaction deducts 1 from offering_balance
- Zero balance prevents AI chat (402 response)
- Freeform journaling (without AI) still works at zero balance
- System prompt is configurable, not hardcoded

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/services/botmason.py` | **Create** |
| `backend/src/routers/botmason.py` | **Create** |
| `backend/src/schemas/botmason.py` | **Create** |
| `backend/src/main.py` | Modify |
| `backend/.env.example` | Modify (add LLM config) |
| `backend/requirements.txt` | Modify (add openai or anthropic SDK) |
| `backend/tests/test_botmason_api.py` | **Create** |
| `frontend/src/features/Journal/ChatInput.tsx` | Modify |
| `frontend/src/features/Journal/JournalScreen.tsx` | Modify (balance display) |
| `frontend/src/api/index.ts` | Modify (add journal.chat endpoint) |
