# phase-3-14: Add GoalGroup support to backend and frontend

**Labels:** `phase-3`, `frontend`, `backend`, `feature`, `priority-medium`
**Epic:** Phase 3 — Build Missing Features
**Depends on:** phase-1-02, phase-1-05
**Estimated LoC:** ~200–250

## Problem

The data model defines `GoalGroup` as a way to group related goals:

```python
class GoalGroup(SQLModel, table=True):
    id: Optional[int]
    name: str
    icon: Optional[str]
    description: Optional[str]
    user_id: Optional[int]
    shared_template: bool = False
    source: Optional[str]
    goals: List["Goal"] = Relationship(back_populates="goal_group")
```

And `Goal` has:
```python
class Goal(SQLModel, table=True):
    goal_group_id: Optional[int] = Field(foreign_key="goalgroup.id")
    goal_group: Optional["GoalGroup"] = Relationship(back_populates="goals")
```

The spec docstring explains: "When multiple goals share the same target_unit and are part of a tiered system (e.g. low, clear, stretch), they should be grouped using goal_group_id. This allows the system to evaluate all tiers together based on the same logged completions."

Currently, the three goal tiers (low/clear/stretch) are loosely associated by being on the same habit. GoalGroup adds:
- **Shared templates** (`shared_template: bool`) — pre-built goal templates that users can adopt
- **Explicit grouping** — goals across different habits could share a group
- **Source tracking** (`source`) — where the goal template came from

Nothing in the backend or frontend implements this. The `GoalGroup` model exists but has no router, no schema, and no UI.

## Scope

Build GoalGroup CRUD and integrate it into the goal creation flow.

## Tasks

### Backend

1. **Create `backend/src/routers/goal_groups.py`**
   - `GET /goal-groups/` — List user's goal groups + shared templates
   - `GET /goal-groups/{id}` — Single group with its goals
   - `POST /goal-groups/` — Create a new group (user-specific or shared template)
   - `PUT /goal-groups/{id}` — Update
   - `DELETE /goal-groups/{id}` — Delete (cascade to unlink goals, don't delete goals)

2. **Create `backend/src/schemas/goal_group.py`**
   - `GoalGroupCreate`: `name`, `icon`, `description`, `shared_template`
   - `GoalGroupResponse`: all fields + `goals: list[Goal]`

3. **Update Goal creation** to optionally accept `goal_group_id`

4. **Seed shared templates**
   - Create a few built-in goal group templates (e.g., "Meditation Goals", "Exercise Goals", "Nutrition Goals")
   - These have `shared_template: true` and `user_id: null`

### Frontend

5. **Add goal group selection to OnboardingModal**
   - During step 4 (goal definition), show available templates
   - User can pick a template or create custom goals
   - Selected template pre-fills low/clear/stretch targets

6. **Add goal group display to GoalModal**
   - If a habit's goals belong to a group, show the group name/icon
   - Allow changing the group or creating a new one

7. **Update `api/index.ts`**
   - `goalGroups.list()`, `goalGroups.create()`, `goalGroups.get(id)`

## Acceptance Criteria

- GoalGroups can be created, listed, and managed
- Shared templates are available to all users
- Goals can be linked to groups
- Onboarding can use templates to pre-fill goal tiers
- Backend tests cover CRUD and template sharing

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/routers/goal_groups.py` | **Create** |
| `backend/src/schemas/goal_group.py` | **Create** |
| `backend/src/main.py` | Modify |
| `backend/tests/test_goal_groups_api.py` | **Create** |
| `frontend/src/features/Habits/components/OnboardingModal.tsx` | Modify |
| `frontend/src/features/Habits/components/GoalModal.tsx` | Modify |
| `frontend/src/api/index.ts` | Modify |
