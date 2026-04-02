# phase-1-09: Add AsyncStorage persistence layer for offline habit state

**Labels:** `phase-1`, `frontend`, `priority-critical`
**Epic:** Phase 1 — Make It Real
**Depends on:** phase-1-08
**Estimated LoC:** ~200–250

## Problem

The frontend has zero data persistence. If the user closes the app and reopens it, all habit data, completions, and settings are gone. The `@react-native-async-storage/async-storage` package is already in `package.json` (installed but never imported anywhere in the codebase).

This is especially critical for a habit tracker — users log progress throughout the day and expect it to be there tomorrow. Even with API integration (phase-1-08), the app needs local caching for:
- Offline usage (no network on subway, airplane, etc.)
- Instant load times (show cached data while fetching fresh data)
- Resilience against server downtime

Additionally, notification IDs are stored on the `Habit` object in memory. When the app restarts, those IDs are lost, making it impossible to cancel previously scheduled notifications. This leads to duplicate notifications over time.

## Scope

Create a persistence layer using AsyncStorage that caches habit data locally and syncs with the API.

## Tasks

1. **Create `frontend/src/storage/habitStorage.ts`**
   - `saveHabits(habits: Habit[]): Promise<void>` — serialize and store
   - `loadHabits(): Promise<Habit[] | null>` — load and deserialize
   - `clearHabits(): Promise<void>` — for logout/reset
   - Handle `Date` serialization carefully — `JSON.stringify` converts Dates to strings, `JSON.parse` doesn't convert them back. Use ISO string format and rehydrate on load.

2. **Create `frontend/src/storage/notificationStorage.ts`**
   - `saveNotificationIds(habitId: number, ids: string[]): Promise<void>`
   - `loadNotificationIds(habitId: number): Promise<string[]>`
   - Persisting notification IDs ensures old notifications can be cancelled after app restart

3. **Create `frontend/src/storage/authStorage.ts`**
   - `saveToken(token: string): Promise<void>` — use `expo-secure-store` for the auth token (not plain AsyncStorage, which is unencrypted)
   - `loadToken(): Promise<string | null>`
   - `clearToken(): Promise<void>`
   - Add `expo-secure-store` to `package.json`

4. **Implement stale-while-revalidate pattern in HabitsScreen**
   - On mount: load from AsyncStorage immediately (instant UI), then fetch from API in background
   - If API returns newer data, update state and AsyncStorage
   - If API fails, use cached data and show a subtle "offline" indicator
   - On every mutation: update AsyncStorage synchronously, fire API call async

5. **Handle Date rehydration**
   - `start_date`, `last_completion_date`, and `completion.timestamp` are `Date` objects in the type definition
   - AsyncStorage stores strings — need a `rehydrateHabit()` function that converts date strings back to Date objects after `JSON.parse()`

## Acceptance Criteria

- App shows cached habits immediately on cold start (no loading spinner for cached data)
- Data survives app close and reopen
- Auth token stored in secure storage, not AsyncStorage
- Notification IDs persist and old notifications can be cancelled after restart
- Offline usage works (shows cached data, queues mutations)

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/storage/habitStorage.ts` | **Create** |
| `frontend/src/storage/notificationStorage.ts` | **Create** |
| `frontend/src/storage/authStorage.ts` | **Create** |
| `frontend/src/features/Habits/HabitsScreen.tsx` | Modify (load from storage on mount) |
| `frontend/package.json` | Modify (add expo-secure-store) |
