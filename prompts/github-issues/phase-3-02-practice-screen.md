# phase-3-02: Build Practice frontend screen with timer and session logging

**Labels:** `phase-3`, `frontend`, `feature`, `priority-medium`
**Epic:** Phase 3 — Build Missing Features
**Depends on:** phase-1-01, phase-1-04, phase-1-10
**Estimated LoC:** ~300

## Problem

The Practice screen is a placeholder:

```tsx
const PracticeScreen = (): React.JSX.Element => {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>Practice Screen</Text>
    </View>
  );
};
```

The backend already has a `/practice_sessions` router (being migrated to DB in phase-1-04) with `POST /` (create session) and `GET /{user_id}/week_count` endpoints. The `Practice` and `UserPractice` SQLModels exist. The README describes this feature as: "Complete timed meditations unique to each stage, with sound cues and progress tracking."

## Scope

Build a functional practice screen where users can select a stage-specific practice, run a countdown timer, and log the completed session.

## Tasks

1. **Create practice selection view**
   - List available practices for the user's current stage
   - Each practice card shows: name, description, recommended duration, times completed
   - Practices are stage-specific (Beige stage has different practices than Purple stage)
   - For MVP: hardcode practice definitions per stage (similar to how `HABIT_DEFAULTS` works), migrate to API-fetched content in phase-3-03

2. **Create timer component: `frontend/src/features/Practice/PracticeTimer.tsx`**
   - Countdown timer with configurable duration
   - Start, pause, resume, cancel controls
   - Visual circle/ring progress indicator
   - Keep screen awake during practice (`expo-keep-awake`)
   - Optional: haptic/vibration feedback at completion

3. **Create session completion flow**
   - On timer completion: show reflection prompt
   - Optional text input for `reflection` field
   - "Save" button calls `practice.log()` API
   - Show session summary (duration, streak info from `week_count`)

4. **Create `frontend/src/features/Practice/PracticeCard.tsx`**
   - Renders a single practice option with stage color accent
   - Shows completion count and last practiced date

5. **Update `api/index.ts`**
   - Add `practice.weekCount(userId)` method
   - Ensure `practice.log()` matches the backend schema

6. **Weekly progress display**
   - Show "X sessions this week" using the `week_count` endpoint
   - Simple progress bar toward a weekly target (e.g., 3 sessions/week)

7. **Rewrite `frontend/src/features/Practice/PracticeScreen.tsx`**
   - State: selected practice, timer state, session history
   - Two views: practice list (default) and active timer
   - Navigation between them

8. **Update Practice styles** — `Practice.styles.ts`

## Acceptance Criteria

- Users can select a practice and start a timed session
- Timer counts down accurately with pause/resume
- Completed sessions are logged to the backend
- Weekly session count is displayed
- Screen stays awake during active timer
- Practice session log includes optional reflection text

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/PracticeScreen.tsx` | Rewrite |
| `frontend/src/features/Practice/PracticeTimer.tsx` | **Create** |
| `frontend/src/features/Practice/PracticeCard.tsx` | **Create** |
| `frontend/src/features/Practice/Practice.styles.ts` | Modify |
| `frontend/src/api/index.ts` | Modify (add practice.weekCount) |
| `frontend/package.json` | Modify (add expo-keep-awake if needed) |
