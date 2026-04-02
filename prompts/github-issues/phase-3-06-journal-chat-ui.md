# phase-3-06: Build Journal chat interface and message history

**Labels:** `phase-3`, `frontend`, `feature`, `priority-medium`
**Epic:** Phase 3 — Build Missing Features
**Depends on:** phase-3-03, phase-1-10
**Estimated LoC:** ~300

## Problem

The Journal screen is a placeholder. The spec describes it as:

> "A conversational UI similar to a chat app where users can type questions or reflections and receive responses from BotMason."

> "Store and display past conversations in a scrollable feed."

This is a **chat interface**, not a simple form. Messages alternate between `sender: 'user'` and `sender: 'bot'` in a threaded conversation view. Past conversations are scrollable and persistent.

## Scope

Build the chat UI and message history display. AI/BotMason integration is phase-3-07.

## Tasks

1. **Rewrite `frontend/src/features/Journal/JournalScreen.tsx`**
   - Chat-style message list (FlatList, inverted for newest-at-bottom)
   - Each message shows: avatar (user vs bot), message text, timestamp
   - User messages right-aligned, bot messages left-aligned
   - Load message history from API on mount (`journal.list()`)
   - Pagination: load older messages on scroll-up

2. **Create `frontend/src/features/Journal/MessageBubble.tsx`**
   - Renders a single message with sender-appropriate styling
   - User messages: right-aligned, subtle background
   - Bot messages: left-aligned, different background, optional BotMason avatar
   - Show tags as small badges if present (`stage_reflection`, `practice_note`, `habit_note`)
   - Timestamp shown below message

3. **Create `frontend/src/features/Journal/ChatInput.tsx`**
   - Multiline text input at bottom of screen
   - Send button (disabled when empty)
   - On send: create `JournalEntry` via API with `sender: 'user'`, add to local message list immediately (optimistic)
   - Optional: tag selector for `is_habit_note`, `is_stage_reflection`, `is_practice_note`

4. **Create `frontend/src/features/Journal/WeeklyPromptBanner.tsx`**
   - If the user hasn't responded to this week's reflection prompt, show a banner at the top
   - "This week's reflection: [prompt text]" with a "Respond" button
   - Tapping opens a focused input for the prompt response
   - Submits via the prompts API (phase-3-05) and creates a journal entry

5. **Update `api/index.ts`**
   - `journal.list({ search?, tag?, practiceSessionId?, limit?, offset? })` — full query support
   - `journal.create(message)` — create a user message
   - `journal.delete(id)`
   - `prompts.current()` — get this week's prompt
   - `prompts.respond(weekNumber, response)`

6. **Update Journal styles** for chat aesthetic: "minimalism with elements of mysticism (soft gradients, symbolic icons)"

## Acceptance Criteria

- Chat interface displays message history in conversation format
- User can send messages that persist to the backend
- Older messages load on scroll-up (pagination)
- Weekly prompt banner appears when a response is due
- Tags displayed on relevant messages
- Mystical-minimalist aesthetic maintained

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Journal/JournalScreen.tsx` | Rewrite |
| `frontend/src/features/Journal/MessageBubble.tsx` | **Create** |
| `frontend/src/features/Journal/ChatInput.tsx` | **Create** |
| `frontend/src/features/Journal/WeeklyPromptBanner.tsx` | **Create** |
| `frontend/src/features/Journal/Journal.styles.ts` | Rewrite |
| `frontend/src/api/index.ts` | Modify |
