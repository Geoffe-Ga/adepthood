# audit-render-03: Memoize Journal MessageBubble

**Labels:** `audit-render`, `frontend`, `performance`, `priority-high`
**Epic:** Frontend Render Cost & List Virtualization
**Estimated LoC:** ~120  (hard cap 700)

## Problem

`frontend/src/features/Journal/MessageBubble.tsx` is not `React.memo`'d. Current
state (§5.2 render cost, severity **High**): the Journal conversation is a long
**inverted** `FlatList`, and although the list itself is the frontend gold
standard for virtualization (stable `keyExtractor`, `getItemLayout`, windowing —
§10), each bubble still re-renders whenever the list re-renders, because the
bubble component has no memoization to bail out on unchanged props. New messages,
streaming updates, or unrelated state changes therefore re-render bubbles whose
content has not changed.

## Scope

Covers wrapping `MessageBubble` in `React.memo` with a correct prop comparison so
unchanged bubbles bail out of re-render, and ensuring any props the list passes
to it (handlers, style refs) are stable enough for the comparison to be
effective. Does NOT change bubble appearance, message formatting, or interaction
behavior — visual output and behavior must be identical.

## Tasks

1. **Memoize the bubble** — wrap the `MessageBubble` export in `React.memo`
   (`frontend/src/features/Journal/MessageBubble.tsx`). If any prop is an object
   or function created per-render by the parent list, stabilize it (or supply a
   custom comparator keyed on the message id + mutable fields like
   streaming/deleted state) so the memo actually bails.
2. **Stabilize parent props** — in the Journal list/screen that renders the
   bubbles, confirm the `renderItem` and per-bubble handlers are stable
   (`useCallback`); add stabilization only where missing.
3. **Render-count test** — in `frontend/src/features/Journal/__tests__/`, add a
   `@testing-library/react-native` test that renders a conversation, records each
   bubble's render count, appends/updates a single message, and asserts unchanged
   bubbles do not re-render.

## Acceptance Criteria

- [ ] Appending or updating one message does not re-render unchanged bubbles,
      proven by the render-count test.
- [ ] `MessageBubble` is `React.memo`'d with an effective comparison.
- [ ] Visual output unchanged (snapshot/behavior tests pass).
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Journal/MessageBubble.tsx` | Modify (`React.memo`) |
| `frontend/src/features/Journal/*` (list/screen rendering bubbles) | Modify (stabilize props if needed) |
| `frontend/src/features/Journal/__tests__/MessageBubble.rendercount.test.tsx` | Create (render-count test) |
