# journal-resonance-19: Remove the chat UI + dead client code

**Labels:** `frontend`, `enhancement`
**Epic:** [Journal Resonance](journal-resonance-epic.md)
**Depends on:** [journal-resonance-13](journal-resonance-13-wire-resonance.md), [journal-resonance-14](journal-resonance-14-margin-notes.md), [journal-resonance-15](journal-resonance-15-essay-modal.md), [journal-resonance-17](journal-resonance-17-shelf-and-search.md)
**Estimated LoC:** ~-300 (net deletion)

## Role

You are a React Native engineer removing the now-replaced chat journal so the
feature contains only the writing surface, shelf, and resonance UI.

## Goal

Delete the chat orchestrator and its message-bubble components, the chat hooks,
and the dead BotMason chat client methods, once the new surfaces (shelf, entry
screen, margin notes, essay modal) are in place and routed.

## Context

- Old chat lives in `frontend/src/features/Journal/`: `JournalScreen.tsx`
  (orchestrator), `MessageBubble.tsx`, `ChatInput.tsx`, `SearchBar.tsx`,
  `TagFilter.tsx`, the typing indicator, and the chat hooks
  (`useJournalComposer`, `useMessageList`, `useMessageLoader`, `useBotSend*`,
  `useFreeformSend`, etc.).
- `frontend/src/api/index.ts` still has `botmason.chat` / `chatStream` and the
  streaming types after backend issue 08 removes the routes.

## Tasks

1. **Delete chat components/hooks** that nothing in the new surface imports:
   `JournalScreen.tsx`, `MessageBubble.tsx`, `ChatInput.tsx`, `TagFilter.tsx`,
   the typing indicator, and the chat-only hooks. Keep anything the new screens
   reuse (e.g. `useDerivedCurrentWeek`, generic helpers) — verify by imports.
2. **Prune the client** — remove `botmason.chat`, `botmason.chatStream`, the
   `ChatRequest/ChatResponse/ChatStream*` types, and `StreamingUnsupportedError`
   if unused. Keep `botmason.getBalance`/`getUsage` (wallet) — resonance uses them.
3. **Remove dead styles** in `Journal.styles.ts` tied only to bubbles/chat input;
   keep/relocate anything the new components still use, or delete the file if the
   new components have their own styles.
4. **Update navigation** so no route points at the removed `JournalScreen`.
5. **Sweep** for dangling imports, dead tests, and unused exports
   (`npx tsc --noEmit` + lint will catch most). Remove obsolete chat tests.

## Acceptance Criteria

- [ ] No chat components, chat hooks, or chat client methods remain; nothing
      imports them.
- [ ] The Journal tab routes only to the shelf/entry surfaces.
- [ ] Wallet client methods still exist and are used by resonance.
- [ ] `npm run lint`, `npx tsc --noEmit`, `npm test` green; coverage thresholds
      still met after deletions.

## Files to Create / Modify

| File | Action |
|------|--------|
| `frontend/src/features/Journal/JournalScreen.tsx` | **Delete** |
| `frontend/src/features/Journal/MessageBubble.tsx` | **Delete** |
| `frontend/src/features/Journal/ChatInput.tsx` | **Delete** |
| `frontend/src/features/Journal/TagFilter.tsx` | **Delete** |
| `frontend/src/features/Journal/` chat hooks | **Delete** |
| `frontend/src/api/index.ts` | Modify (drop chat methods/types) |
| `frontend/src/navigation/*` | Modify |

## Constraints

- Delete only after the replacements are routed and green — this issue lands last
  on the frontend.
- Keep wallet client methods and any shared helpers the new surface imports.
- No `// eslint-disable` / `@ts-ignore` to paper over removals — fix imports.
