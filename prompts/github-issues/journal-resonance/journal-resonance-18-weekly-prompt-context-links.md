# journal-resonance-18: Weekly prompt as a pre-titled page + practice/stage context links

**Labels:** `frontend`, `enhancement`
**Epic:** [Journal Resonance](journal-resonance-epic.md)
**Depends on:** [journal-resonance-11](journal-resonance-11-writing-surface.md), [journal-resonance-17](journal-resonance-17-shelf-and-search.md)
**Estimated LoC:** ~225

## Role

You are a React Native engineer carrying the two retained entry points — weekly
prompts and practice/stage deep-links — onto the new writing surface.

## Goal

Reimagine the weekly prompt as opening a **pre-titled page** (the prompt becomes
the page's title/prologue) instead of a banner + "Respond" button, and preserve
opening the journal from a practice session or stage reflection by pre-linking the
new entry to that context.

## Context

- `prompts.current()` / `prompts.respond(weekNumber, response)` exist; today
  `WeeklyPromptBanner` shows the question with a Respond button and creates a
  `weekly_prompt`-tagged message.
- The old journal accepted route params for practice session / stage reflection
  context (`practice_session_id`, `user_practice_id`, stage reflection).
  `journal.create`/`update` accept `practice_session_id` / `user_practice_id`.
- Entry screen (issue 11) opens with/without an `entryId` and can take initial
  title/body/context.

## Tasks

1. **Weekly prompt page**:
   - On the shelf (or a gentle nudge), surface the current unanswered prompt as
     "Week N — <question>". Tapping it opens `JournalEntryScreen` pre-titled with
     the prompt (e.g. title = "Week N Reflection", the question shown as a
     prologue/placeholder above the body).
   - On first save, record the response via `prompts.respond(weekNumber, body)`
     (and/or persist as a normal entry — match the backend's expectation; if
     `respond` creates the entry, open that entry afterward).
   - Once answered, the prompt no longer nags (mirror today's `has_responded`).
   - Use `useDerivedCurrentWeek()` as the banner did for display.
2. **Practice / stage context links**:
   - Preserve route params so a practice session or stage reflection opens a new
     entry pre-linked (`practice_session_id` / `user_practice_id` threaded into
     `journal.create`/`update`), optionally with a pre-filled title like
     "After <practice>".
   - Keep the existing entry points (practice → journal, course/stage → journal)
     navigating to the new entry screen rather than the old chat screen.
3. **Remove the old banner** — delete `WeeklyPromptBanner` usage from the new
   surface (the component file removal can ride with issue 19's cleanup or here if
   trivial).
4. **Tests**:
   - Opening the weekly prompt navigates to a pre-titled entry; saving calls
     `respond` with the week number and body.
   - An answered prompt does not re-surface.
   - Opening from a practice session pre-links `practice_session_id` on create.

## Acceptance Criteria

- [ ] The weekly prompt opens a pre-titled page; answering it records the response
      and stops the nudge.
- [ ] Practice/stage deep-links open the new entry screen pre-linked to context.
- [ ] No banner + "Respond" button remains.
- [ ] `npm run lint`, `npx tsc --noEmit`, `npm test` green.

## Files to Create / Modify

| File | Action |
|------|--------|
| `frontend/src/features/Journal/JournalEntryScreen.tsx` | Modify (initial title/prologue/context) |
| `frontend/src/features/Journal/JournalShelfScreen.tsx` | Modify (surface current prompt) |
| `frontend/src/features/Journal/WeeklyPromptBanner.tsx` | **Delete** (or in issue 19) |
| `frontend/src/features/Journal/__tests__/weeklyPrompt.test.tsx` | **Create** |

## Constraints

- Match the backend's weekly-prompt response contract exactly (week number +
  body); don't double-create entries.
- Preserve practice/stage linking fields end-to-end.
- Editorial styling; no tag chips.
