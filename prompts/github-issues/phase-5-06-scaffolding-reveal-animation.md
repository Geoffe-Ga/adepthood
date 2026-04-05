# phase-5-06: Add reveal animation to Energy Scaffolding reorder step

**Labels:** `phase-5`, `frontend`, `ux`, `priority-low`
**Epic:** Phase 5 — Prompt Alignment & UX Refinement
**Depends on:** None (all phases 1–4 complete)
**Estimated LoC:** ~100

## Problem

The original Energy Scaffolding prompt specifies:

> "Do a flashy reveal at the end that shows all habits net energy and what order they ended up in"

Currently, Step 4 of the OnboardingModal just renders a DraggableFlatList with the habits already sorted by net energy. The transition from Step 3 (energy return sliders) to Step 4 (reordered list) is instant — there's no moment of revelation. The user enters cost and return values on separate screens (good — prevents gaming), but the payoff of seeing the sorted result is anticlimactic.

The prompt's vision is better because the Energy Scaffolding flow is designed to feel like an alchemical process. The user inputs raw data (cost, return) without seeing the outcome, and then the sorted result should feel like a "reveal" — a moment of insight about which habits serve them best energetically.

## Scope

Add a brief reveal animation between Steps 3 and 4 that shows habits sorting into their energy-efficient order before the user can interact with the list.

## Tasks

### 1. Add a reveal transition state

In `OnboardingModal.tsx`, when advancing from Step 3 → Step 4:
- Don't immediately show the DraggableFlatList
- Instead, show a brief "calculating" state (1–2 seconds):
  - Display habit tiles in their original (user-entered) order
  - Show net energy scores appearing one by one (stagger 150ms per habit)
  - Then animate the tiles sliding into their sorted positions

### 2. Implement the sort animation

Use React Native's `LayoutAnimation` or `Animated` API:

**Option A (simpler): LayoutAnimation**
```typescript
LayoutAnimation.configureNext(LayoutAnimation.Presets.spring);
setSortedHabits(sortByNetEnergy(habits));
```
This gives a spring animation as items move to their sorted positions.

**Option B (richer): Staggered reveal**
1. Show all habits in input order with net energy hidden
2. Fade in net energy values one at a time (top to bottom, 150ms stagger)
3. Pause 500ms
4. Animate sort with `LayoutAnimation.spring`
5. After animation settles, enable interaction (DraggableFlatList becomes active)

Recommend Option B for maximum impact — it matches the "flashy reveal" intent.

### 3. Add a header during the reveal

During the animation, show a header like:
- "Calculating your energy order..." (during score reveal)
- "Your optimal habit order:" (after sort completes)

This frames the moment as meaningful, not just decorative.

### 4. Disable interaction during the reveal

While the animation plays (~2–3 seconds total):
- Disable the "Next" / "Back" buttons
- Disable drag handles on the FlatList
- Re-enable everything once the animation completes

### 5. Write tests

- Test that Step 4 shows habits in sorted order after animation
- Test that interaction is disabled during the reveal
- Test that the reveal only plays on first entry to Step 4 (not when navigating back)

## Acceptance Criteria

- Transitioning from Step 3 to Step 4 plays a reveal animation
- Net energy scores appear one at a time (staggered)
- Habits animate from input order to sorted order
- Interaction is disabled during the animation (~2–3 seconds)
- The reveal only plays once (navigating back and forward skips it)
- Animation works on both iOS and Android (no platform-specific crashes)
- The "Back" button still works after the animation completes

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Habits/components/OnboardingModal.tsx` | Modify (add reveal state + animation) |
| `frontend/src/features/Habits/components/__tests__/OnboardingModal.test.tsx` | Modify or create |
