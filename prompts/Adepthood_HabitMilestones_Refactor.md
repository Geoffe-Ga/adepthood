## Prompt: Refactor the Habit system in Adepthood to align with energy-based milestone tracking and intuitive progress

You are a senior React Native + Expo engineer enhancing the `Habits` feature in the Adepthood app to fully support energy scaffolding, milestone celebrations, intuitive editing, and progressive unlocking logic across 10 habit tiles tied to APTITUDE stages.

---

### Objectives

- Rebuild HabitTile logic to support additive/subtractive milestone progress (Low, Clear, Stretch), including dynamic progress bar with colored markers and real-time updates.

- Refactor editing modal to use a unified horizontal progress bar with draggable milestone markers, labeled and color-coded per stage.

- Add support for milestone achievements with daily streak logic: “Low Goal Achieved Today,” etc.

- Ensure tapping a HabitTile opens an editing modal with emoji picker, milestone sliders, and goal descriptions.

- Streak trackers must only allow 1-day logging per calendar day.

---

### Deliverables (atomic PRs)

#### 1. Milestone Progress Refactor
- Refactor progress bar in `HabitTile.tsx` to:
  - Show dynamic progress toward low/clear/stretch goals
  - Markers color-coded by stage
  - Tooltip on long-press/hover on Goal Markers.
  - Labeled markers on the progress bar at the increments for each goal, with tool tips showing full goal name ("LG"-Low Grit, "CG"-Clear Goal, "SG"-Stretch Goal)
- Clamp logged units to a single “day complete” event per 24-hour period

#### 2. Milestone Editing Modal
- Modify the Habit Editing and unit logging modal to:
  - Displays 1 horizontal progress bar with draggable markers for low and clear goals
  - Markers update low/clear/stretch goals (preserving their order: low goals cant be a higher target than clear goals, etc)
  - Dragging snap-to values (e.g. 1–10 units)
  - Stretch is fixed rightmost (on Additive; left most on Subtractive) and only Low and Clear are adjustable
  - Clicking on a marker for low, clear or stretch goals allows for editing with units, frequencies, etc.
  - Low/Clear/Stretch goals must always be in the correct order, and must always use the same units and frequency_units.
- Add in-place emoji picker when tapping the habit icon (this should also be visible during Energy Scaffolding)
- Hovering over goal markers anywhere (Low Grit, Clear, Stretch) displays how many units and the frequency in order to achieve them

#### 3. Habit Logging Behavior
- Add checkbox or tap zone to log a single unit/day from main HabitTile
- Show milestone celebration toast/badge when threshold is crossed
- “Mark Complete” button only visible for currently unlocked habit

#### 4. Unlocking & Greying Logic
- Only first habit (Beige) is fully active on app start
- All others greyed out visually and do not display streak/units unless unlocked
- Unlock new habit every 21 days (or 42 for last 2 stages)
- Optional override setting: allow manual unlocking

---

### Acceptance Criteria

- Habits grid displays 10 total tiles; only active stage is interactable.
- Tapping tile opens modal with goal sliders, emoji picker, and milestone info.
- Progress bar shows real-time updates, no overflows or misalignment.
- Streaks update once per day max; backfill prompt if user was offline.
- Marker milestones are respected in ordering and visually distinct.

---

### Testing

- Unit test for `getProgressPercentage()` and `getMarkerPositions()`:
  - Validate additive vs subtractive logic
  - Prevent progress overflow
- UI test:
  - Mock habits at different stages and confirm visual behavior
  - Simulate drag of milestone slider, check logical ordering
- Manual QA:
  - Check layout on small/mobile vs wide/tablet view
  - Ensure progress markers do not overlap or disappear
  - Confirm streaks respect daily limits

---

### Notes

- Add marker label abbreviations (LG, CG, SG) below bar
- Apply stage background color and accessibility label
- Use tooltip or label on tap/hover to show full milestone names
- Store progress at the Habit level, not per-goal

Please implement in atomic commits grouped by Deliverable.
