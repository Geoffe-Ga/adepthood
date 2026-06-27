# journal-resonance-16: Deliberate edit confirm + stale-note rendering

**Labels:** `frontend`, `enhancement`
**Epic:** [Journal Resonance](journal-resonance-epic.md)
**Depends on:** [journal-resonance-11](journal-resonance-11-writing-surface.md), [journal-resonance-14](journal-resonance-14-margin-notes.md)
**Estimated LoC:** ~200

## Role

You are a React Native engineer making edits to a *finished* (resonated) entry a
deliberate act, and giving stale notes a clear, gentle visual treatment.

## Goal

When the user tries to edit a `finished` entry, intercept with a confirm dialog:
**"Edit finished entry?"** → **Edit** (unlock + re-anchor on save) or **Start
new** (open a fresh draft). After an edit, notes returned as `stale` by the
backend render dimmed with a small "the writing this referred to has changed"
affordance, but remain openable.

## Context

- Backend marks notes `stale` on body edits and re-anchors survivors
  (issue 07); `PATCH /journal/{id}` (issue 03) does the work — the frontend just
  re-reads marginalia after saving an edit.
- Entry `status` is `draft | finished`; resonance/finishing sets `finished`.
- Issue 14's `MarginNote` already accepts a stale prop.

## Tasks

1. **Edit gate** — in `JournalEntryScreen`, body/title inputs on a `finished`
   entry are read-only until the user confirms. Tapping the body raises an
   `EditConfirmDialog` with:
   - **Edit** → set the entry editable; on the next save (`journal.update` with
     the new body), re-fetch marginalia (`resonance.list`) so re-anchored/stale
     state refreshes.
   - **Start new** → navigate to a fresh `JournalEntryScreen` (no id).
   - **Cancel** → leave it untouched.
2. **`EditConfirmDialog.tsx`** — a small modal with the three choices, warm copy,
   accessible. Pure-ish; takes `{ visible, onEdit, onStartNew, onCancel }`.
3. **Stale rendering** — pass `stale` notes to `MarginNote` in the dimmed variant
   with a one-line caption (e.g. "the passage this noted has changed"). Stale
   highlights are not drawn inline (their span may be gone); the note stays
   tappable to read its essay.
4. **Finish action** — a quiet control to mark a draft `finished` (sets status via
   `journal.update`). (Resonating can also imply finishing — keep it simple:
   resonance leaves status as-is; an explicit "Finish" sets `finished`.)
5. **Tests** — `__tests__/EditConfirmDialog.test.tsx` + screen interaction:
   - Editing a finished entry shows the dialog; **Edit** unlocks inputs;
     **Start new** navigates to a blank screen; **Cancel** keeps it locked.
   - After an edit-save, marginalia are re-fetched.
   - Stale notes render dimmed with the caption and are still openable.

## Acceptance Criteria

- [ ] Editing a finished entry requires confirmation (Edit / Start new / Cancel).
- [ ] After an edit, marginalia refresh; stale notes render dimmed but openable.
- [ ] A draft can be explicitly marked finished.
- [ ] `npm run lint`, `npx tsc --noEmit`, `npm test` green.

## Files to Create / Modify

| File | Action |
|------|--------|
| `frontend/src/features/Journal/EditConfirmDialog.tsx` | **Create** |
| `frontend/src/features/Journal/JournalEntryScreen.tsx` | Modify (edit gate + finish) |
| `frontend/src/features/Journal/MarginNote.tsx` | Modify (stale caption) |
| `frontend/src/features/Journal/__tests__/EditConfirmDialog.test.tsx` | **Create** |

## Constraints

- The confirm is mandatory for `finished` entries; never silently mutate them.
- Re-anchoring is the backend's job (issue 07); the frontend only re-reads.
- Stale notes are preserved and readable — never hidden or deleted client-side.
