fix(habits): persist goal completions across sessions

The backend stored every check-in as a ``GoalCompletion`` row but the goal
schema never serialized them, so ``mapApiHabits`` / ``toLocalHabit`` on the
frontend hardcoded ``completions: []``.  A logged completion survived only
in the local Zustand store + AsyncStorage cache; on the next ``GET /habits``
the cache was overwritten with the wire shape and the progress bar reset to
0%.  The streak (a scalar on the parent habit) was the only durable signal,
which is exactly what the user reported: "the streak was retained but the
full progress bar wasn't".

Backend
- New ``GoalCompletionPublic`` + ``GoalWithCompletions`` schemas embed the
  completions list on every goal returned by ``GET /habits/`` and
  ``GET /habits/{id}``.
- ``HabitWithGoals`` switched to the embedded variant; ``PUT /goals/{id}``
  keeps the lean ``Goal`` schema so it does not trigger a greenlet
  lazy-load on a session that didn't eager-load the relation.
- Per-row ``user_id`` filter in ``_filter_completions_to_caller`` mirrors
  the pattern in ``_populate_streak`` / ``get_habit_stats`` so a future
  shared-goal feature or stray cross-tenant row cannot leak via the
  embedded list.

Frontend
- ``ApiGoal`` gains optional ``completions`` (back-compat with older API
  builds).  ``goalSchema`` extends with ``goalCompletionSchema``.
- ``mapApiHabits`` / ``toLocalHabit`` flatten per-goal completions into the
  habit-level array (deduped by row id) and rehydrate timestamps to ``Date``.

Tests
- 3 new backend tests pin the embed contract, the list-endpoint variant,
  and the cross-tenant filter.
- 2 new frontend tests cover the flatten path and the dedupe invariant.
