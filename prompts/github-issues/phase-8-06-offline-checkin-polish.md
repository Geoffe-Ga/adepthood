# phase-8-06: Offline check-in polish — tap-time timestamps, known-offline fast path, honest null-id toast

**Labels:** `phase-8`, `frontend`, `offline`, `priority-medium`
**Epic:** Phase 8 — Post-Drain Hardening
**Depends on:** None
**Estimated LoC:** ~175

## Problem

PR #450 (issue #415) wired the offline check-in queue and its review left
three flagged-but-non-blocking gaps:

1. **Timestamp is failure-handler time, not tap time** — `handleLogUnitFailure`
   in `frontend/src/features/Habits/hooks/useHabitActions.ts` calls
   `new Date().toISOString()` after the network call errors; a slow DNS
   timeout drifts the queued timestamp (and therefore the replay's derived
   day) minutes past the actual tap.
2. **Known-offline taps still burn a doomed POST** —
   `NetworkStatusContext.tsx:16` advertises "per-feature queue/replay flows
   (follow-up work)" and the API client already exposes
   `setNetworkOnlineGetter`; logUnit doesn't consult it, so an
   airplane-mode tap waits out the fetch failure before queueing.
3. **Null-goal-id offline taps get a misleading toast** — when
   `ctx.currentGoal.id` is null (pre-sync onboarding goal) and the network
   fails, the guard falls through to the generic "check your connection"
   revert toast; the real problem is that onboarding hasn't synced.

## Scope

Polish the existing queue path only — no schema or replay changes
(`PendingCheckIn` already carries `timestamp` + `completed_on`).

## Tasks

1. **Capture tap time in the mutation context**
   - Add `tappedAt: string` to `LogUnitContext`, set in
     `habitManager.prepareLogUnit`; `handleLogUnitFailure` queues
     `ctx.tappedAt` instead of `new Date()`.

2. **Known-offline fast path**
   - In `useLogUnitMutation`, when the network-status getter reports
     offline, skip the POST: apply optimistically, queue immediately, show
     the will-sync toast. Online-but-failing requests keep today's path.

3. **Honest toast for unsynced onboarding goals**
   - Distinct copy when offline + `currentGoal.id == null`: the check-in
     cannot be queued (no server goal id) — tell the user their habits
     haven't finished syncing rather than implying a connection problem.

4. **Tests**
   - tap-time: freeze a fake clock at prepare, advance before failure,
     assert the queued timestamp is prepare-time.
   - fast path: offline getter true → `goalCompletions.create` never
     called, queue written, optimistic state kept.
   - null-id: no queue write, revert, distinct message.

## Acceptance Criteria

- Queued timestamps equal tap time, not failure time (test-pinned).
- Known-offline taps produce zero network calls.
- All three branches have dedicated tests; existing #415 tests unchanged.
- No existing tests break.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Habits/services/habitManager.ts` | Modify (`LogUnitContext`, `prepareLogUnit`) |
| `frontend/src/features/Habits/hooks/useHabitActions.ts` | Modify |
| `frontend/src/features/Habits/hooks/__tests__/useHabitActions.test.tsx` | Modify |
