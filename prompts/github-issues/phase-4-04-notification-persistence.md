# phase-4-04: Fix notification persistence and lifecycle management

**Labels:** `phase-4`, `frontend`, `bug`, `priority-medium`
**Epic:** Phase 4 — Polish & Harden
**Depends on:** phase-1-09
**Estimated LoC:** ~150–200

## Problem

Notification scheduling works but is fragile:

1. **Notification IDs are stored in memory only** (`habit.notificationIds` array). When the app restarts, these IDs are lost. Consequence: the app can't cancel previously scheduled notifications, leading to duplicate notifications accumulating over time.

2. **Registration is fire-and-forget** (HabitsScreen.tsx:242-244):
   ```tsx
   useEffect(() => {
     void registerForPushNotificationsAsync();
   }, []);
   ```
   If registration fails, it's never retried. No error is shown to the user.

3. **Notification updates are fire-and-forget** (HabitsScreen.tsx:335):
   ```tsx
   void updateHabitNotifications(updatedHabit);
   ```
   If scheduling fails, the notification IDs array won't be updated, but the habit state already changed. No error handling, no retry.

4. **Scheduled notifications don't survive app updates** on some platforms. iOS and Android handle this differently.

5. **The `notificationTimes` field stores time strings like `"08:00"`** but there's no UI to set them — they come from `HabitDefaults` or the settings modal.

## Scope

Make notifications resilient to app restarts and handle errors gracefully.

## Tasks

1. **Persist notification IDs in AsyncStorage** (or the notification storage from phase-1-09)
   - When scheduling: save `{ habitId: [notificationId1, notificationId2, ...] }`
   - On app start: load persisted IDs so old notifications can be cancelled

2. **Add a notification reconciliation step on app start**
   - Load all persisted notification IDs
   - Load all currently scheduled notifications from `Notifications.getAllScheduledNotificationsAsync()`
   - Cancel any orphaned notifications (scheduled but not in our persisted list)
   - Re-schedule any missing notifications (in our list but not currently scheduled)

3. **Add error handling to notification scheduling**
   - Wrap `scheduleHabitNotification` in try/catch
   - If scheduling fails, log the error and show a subtle warning
   - Retry once before giving up
   - Don't block habit operations on notification failures

4. **Add retry logic to push token registration**
   - If `registerForPushNotificationsAsync()` fails, retry after 30 seconds
   - Maximum 3 retries
   - Store the push token in AsyncStorage for reuse

5. **Move notification logic out of HabitsScreen** (builds on phase-2-01)
   - Ensure `useHabitNotifications.ts` is a standalone hook that:
     - Registers for push permissions on mount
     - Reconciles scheduled notifications
     - Exposes `scheduleForHabit(habit)` and `cancelForHabit(habitId)` functions

## Acceptance Criteria

- Notification IDs survive app restarts
- No duplicate notifications accumulate over time
- Orphaned notifications are cleaned up on app start
- Scheduling errors don't break habit operations
- Push token registration retries on failure

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Habits/hooks/useHabitNotifications.ts` | Modify (persistence, reconciliation, error handling) |
| `frontend/src/storage/notificationStorage.ts` | Modify (from phase-1-09) |
