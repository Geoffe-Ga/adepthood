# phase-3-09: Build Practice screen — selection, timer with sound cues

**Labels:** `phase-3`, `frontend`, `feature`, `priority-medium`
**Epic:** Phase 3 — Build Missing Features
**Depends on:** phase-3-04, phase-1-10
**Estimated LoC:** ~300

## Problem

The Practice screen is a placeholder. The spec requires:

> "Pick a Practice per stage (custom or recommended, as described in the .docx introduction)"
> "Timer-based (with sound cues)"
> "Tracks completions (target min 4x/week)"

The backend (phase-3-04) provides three layers: `Practice` (catalog), `UserPractice` (user's selection per stage), and `PracticeSession` (logged sessions). The frontend needs to present practice selection, a countdown timer with audio cues, and session tracking.

## Scope

Build the full Practice screen with practice selection, timer, and session logging.

## Tasks

1. **Rewrite `frontend/src/features/Practice/PracticeScreen.tsx`**
   - Two states: **selection view** (default) and **active timer view**
   - Selection view shows: current stage's available practices, user's active practice (if selected), weekly session count
   - If no practice selected for current stage: show practice catalog with "Select" buttons
   - If practice selected: show practice card with "Start" button

2. **Create `frontend/src/features/Practice/PracticeSelector.tsx`**
   - List of available practices for the user's current stage
   - Each card shows: name, description, default duration, "Select" button
   - Selecting creates a `UserPractice` via API
   - Show currently selected practice with a checkmark

3. **Create `frontend/src/features/Practice/PracticeTimer.tsx`**
   - Countdown timer with configurable duration (from `Practice.default_duration_minutes`, adjustable)
   - Visual: circular progress ring with time remaining in center
   - Controls: Start, Pause/Resume, Cancel
   - **Sound cues** (spec requirement):
     - Bell/chime at start (beginning of practice)
     - Soft bell at halfway point
     - Triple bell at completion
     - Use `expo-av` for audio playback
     - Bundle small audio files or use system sounds
   - Keep screen awake during timer (`expo-keep-awake`)
   - Haptic feedback on completion (vibration)

4. **Create session completion flow**
   - On timer completion or manual stop:
     - Show duration summary
     - "Save Session" button → calls `POST /practice-sessions/` with `user_practice_id` and `duration_minutes`
     - Optional: "Write a reflection" button → navigates to Journal with `practice_session_id` pre-filled (phase-3-10)
   - Show weekly progress: "3 of 4 sessions this week" using `week-count` endpoint

5. **Create `frontend/src/features/Practice/WeeklyProgress.tsx`**
   - Shows sessions completed this week vs target (4x/week)
   - Simple progress bar or circle with "3/4" label

6. **Update `api/index.ts`**
   - `practices.list(stageNumber)` — available practices
   - `userPractices.create(practiceId, stageNumber)` — select a practice
   - `userPractices.list()` — user's active practices
   - `practiceSessions.create(userPracticeId, durationMinutes)` — log session
   - `practiceSessions.weekCount()` — this week's count

7. **Add audio assets**
   - `frontend/assets/sounds/bell-start.mp3`
   - `frontend/assets/sounds/bell-half.mp3`
   - `frontend/assets/sounds/bell-end.mp3`

## Acceptance Criteria

- Users can browse and select a practice for their current stage
- Timer counts down with start/pause/cancel
- Sound cues play at start, halfway, and end
- Screen stays awake during active timer
- Completed sessions are logged to the backend
- Weekly progress displayed (X of 4 sessions)

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/PracticeScreen.tsx` | Rewrite |
| `frontend/src/features/Practice/PracticeSelector.tsx` | **Create** |
| `frontend/src/features/Practice/PracticeTimer.tsx` | **Create** |
| `frontend/src/features/Practice/WeeklyProgress.tsx` | **Create** |
| `frontend/src/features/Practice/Practice.styles.ts` | Rewrite |
| `frontend/src/api/index.ts` | Modify |
| `frontend/assets/sounds/` | **Create** (audio files) |
| `frontend/package.json` | Modify (add expo-av, expo-keep-awake) |
