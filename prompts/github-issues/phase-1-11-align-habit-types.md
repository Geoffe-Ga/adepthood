# phase-1-11: Align frontend and backend Habit type definitions

**Labels:** `phase-1`, `frontend`, `backend`, `priority-high`
**Epic:** Phase 1 — Make It Real
**Depends on:** phase-1-02, phase-1-07
**Estimated LoC:** ~150–200

## Problem

"Habit" is defined in three places with three different shapes:

**Frontend `Habits.types.ts`:**
```typescript
interface Habit {
  id?: number; stage: string; name: string; icon: string; streak: number;
  energy_cost: number; energy_return: number; progress?: number;
  start_date: Date; goals: Goal[]; completions?: Completion[];
  notificationIds?: string[]; notificationTimes?: string[];
  notificationFrequency?: 'daily' | 'weekly' | 'custom' | 'off';
  notificationDays?: string[]; milestoneNotifications?: boolean;
  last_completion_date?: Date; revealed?: boolean;
}
```

**Backend `schemas/habit.py`:**
```python
class Habit(BaseModel):
    id: int; user_id: int; name: str; icon: str; start_date: date;
    energy_cost: int; energy_return: int;
    notification_times: list[str] | None; notification_frequency: str | None;
    notification_days: list[str] | None; milestone_notifications: bool;
    sort_order: int | None
```

**Backend `models/habit.py` (SQLModel):**
```python
class Habit(SQLModel, table=True):
    id: int | None; name: str; icon: str; start_date: date;
    energy_cost: int; energy_return: int;
    user_id: int; goals: list[Goal] (relationship)
```

**Key mismatches:**
- Frontend has `stage`, `streak`, `progress`, `completions`, `revealed` — backend has none of these
- Backend schema has `user_id`, `sort_order` — frontend type doesn't
- Frontend has `goals: Goal[]` inline — backend schema doesn't include goals (they're a separate model)
- Frontend uses `Date` objects — backend uses `date` (ISO string format over the wire)
- Frontend `notificationFrequency` is a union type `'daily' | 'weekly' | 'custom' | 'off'` — backend is `str`

If the frontend calls the backend API, the response won't match the expected type and things will silently break.

## Scope

Create a shared contract between frontend and backend. The backend schema is the API source of truth; the frontend type must match what the API actually returns.

## Tasks

1. **Extend the backend `Habit` schema to include missing fields**
   - Add `stage: str` (which APTITUDE stage the habit belongs to)
   - Add `streak: int` (calculated or stored)
   - Add `sort_order: int | None` (already present)
   - Decide: should `goals` be nested in the habit response, or fetched separately? Recommendation: nested for read, separate endpoint for write

2. **Extend the backend `Habit` SQLModel to include missing columns**
   - Add `stage: str` column
   - Add `streak: int = 0` column
   - Add `sort_order: int | None` column (if not already there)
   - Add `revealed: bool = True` column (or handle on frontend only)

3. **Create a backend `HabitWithGoals` response schema**
   - `class HabitWithGoals(Habit)` that includes `goals: list[Goal]` and `completions: list[Completion]`
   - Use this for the GET endpoints so the frontend receives the full habit object

4. **Update frontend `Habits.types.ts` to match the API contract**
   - `id` should be `number` (not optional) — after creation it always has an ID
   - `start_date` should be `string` (ISO format from API) — convert to Date on the frontend when needed
   - `last_completion_date` should be `string | null`
   - Keep client-only fields like `notificationIds` (these are device-local, not from the API)
   - Clearly separate API fields from client-only fields with comments or a separate interface

5. **Add frontend type for API response vs local state**
   - `HabitFromAPI` — what the server returns (no `notificationIds`, dates as strings)
   - `Habit` — local enriched version (with notification IDs, dates as Date objects)
   - `toLocalHabit(apiHabit: HabitFromAPI): Habit` conversion function

6. **Enforce `notificationFrequency` as a Literal/enum on the backend**
   - Currently `str` — should be `Literal["daily", "weekly", "custom", "off"] | None`

## Acceptance Criteria

- Frontend Habit type matches what the API actually returns
- Backend schema includes all fields the frontend needs
- Date serialization is handled explicitly (ISO strings over the wire)
- No silent type mismatches when connecting frontend to backend
- Conversion function exists for API response -> local state

## Files to Modify

| File | Action |
|------|--------|
| `backend/src/schemas/habit.py` | Modify (add stage, streak, nested goals schema) |
| `backend/src/models/habit.py` | Modify (add stage, streak columns) |
| `frontend/src/features/Habits/Habits.types.ts` | Modify (align with API, add conversion) |
| `frontend/src/api/types.ts` | Modify (add/update Habit types) |
