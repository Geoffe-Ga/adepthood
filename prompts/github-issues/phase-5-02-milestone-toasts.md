# phase-5-02: Replace milestone Alert.alert() with toast notifications

**Labels:** `phase-5`, `frontend`, `ux`, `priority-medium`
**Epic:** Phase 5 — Prompt Alignment & UX Refinement
**Depends on:** None (all phases 1–4 complete)
**Estimated LoC:** ~150

## Problem

The original Habit Milestones prompt specifies:

> "Show milestone celebration toast/badge when threshold is crossed"

The current implementation uses native `Alert.alert()` modal dialogs:

```typescript
// useHabits.ts:221
Alert.alert('Achieved! Keep going for the Stretch Goal!');
```

Modal alerts are interruptive — they block the entire UI and require a tap to dismiss. When a user is in the flow of logging habits, a modal alert breaks their rhythm. The prompt's vision of a **toast** is better because:

1. Toasts celebrate without blocking interaction
2. They auto-dismiss, so the user doesn't need to act
3. They can include richer visuals (icons, stage colors, animations)
4. Multiple milestones can stack without modal pileup

## Scope

Add a lightweight toast notification system and replace all milestone `Alert.alert()` calls with celebratory toasts.

## Tasks

### 1. Add a toast component

Create `frontend/src/components/Toast.tsx`:
- Animated slide-in from top (or bottom)
- Auto-dismiss after 3 seconds
- Props: `message: string`, `icon?: string`, `color?: string`, `duration?: number`
- Supports stacking (if two toasts fire in quick succession)
- Uses `Animated` API for smooth entrance/exit (slide + fade)

### 2. Add a toast context or hook

Create `frontend/src/components/ToastProvider.tsx`:
- `ToastProvider` wraps the app (add to `App.tsx`)
- `useToast()` hook returns `showToast(options)` function
- Queue-based: toasts display one at a time with a short gap between them

### 3. Replace Alert.alert() calls in useHabits

Current milestone alerts in `useHabits.ts` (around lines 210–233):
- Low Goal: `Alert.alert('Goal Achieved! ...')`
- Clear Goal: `Alert.alert('Achieved! Keep going for the Stretch Goal!')`
- Stretch Goal: `Alert.alert('Stretch Goal Achieved! ...')`

Replace each with:
```typescript
showToast({
  message: 'Clear Goal achieved! Keep going for the Stretch Goal!',
  icon: '🎯',
  color: TIER_COLORS.clear,  // #807f66
});
```

Use tier-appropriate icons:
- Low Goal: `🏅` (bronze medal vibe, matches `#bc845d`)
- Clear Goal: `🎯` (target hit, matches `#807f66`)
- Stretch Goal: `🌟` (star achievement, matches `#b0ae91`)

### 4. Also replace the "Next steps" alert in onboarding

```typescript
// useHabits.ts:395
Alert.alert('Next steps', 'Tap a habit tile to edit its goals.');
```

Replace with a longer-duration toast (5s) since this is instructional.

### 5. Write tests

- Test that `showToast` renders the toast component
- Test auto-dismiss after specified duration
- Test that milestone toasts fire at correct thresholds
- Test toast stacking behavior

## Acceptance Criteria

- Zero `Alert.alert()` calls remain for milestone/celebration events
- Toasts appear as non-blocking overlays with smooth animation
- Each goal tier (low/clear/stretch) has a distinct icon and color
- Toasts auto-dismiss after 3 seconds (5s for instructional messages)
- Multiple rapid milestones display sequentially, not simultaneously
- No regressions in goal logging or streak calculation

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/components/Toast.tsx` | **Create** |
| `frontend/src/components/ToastProvider.tsx` | **Create** |
| `frontend/src/App.tsx` | Modify (wrap with ToastProvider) |
| `frontend/src/features/Habits/hooks/useHabits.ts` | Modify (replace Alert.alert) |
| `frontend/src/components/__tests__/Toast.test.tsx` | **Create** |
