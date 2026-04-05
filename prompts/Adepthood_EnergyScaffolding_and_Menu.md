## Prompt: Improve Energy Scaffolding flow and 3-dot menu UX for Adepthood onboarding

You are a senior RN with Expo engineer enhancing the Energy Scaffolding onboarding flow and refining the HabitTile 3-dot menu UX for the Adepthood app. Your goal is to provide a clean, intuitive, user-driven experience for habit ordering, icon selection, and habit visibility.

---

### Objectives

- Smooth the onboarding sequence for Energy Scaffolding:
  - Prevent premature backfill of calculated net energy return:
    - We don't want to see net energy before filling out investment and return,
    - We don't want to see investment and return at the same time
    - Users should fill out each option with maximum honesty, not gaming the numbers.
    - Do a flashy reveal at the end that shows all habits net energy and what order they ended up in
  - Ensure correct calendar picker behavior on the final Energy Scaffolding screen.
    - Show start dates on each Habit calculated as +21 days per habit for the first 8 habits and +42 days each for habits 9 and 10
  - Let users visually order habits anywhere there is an emoji, allow them to tap it to bring up an emoji picker with search and change it
  - Provide option to hide/archive the Energy Scaffolding button on the main screen once it’s no longer needed
    - Display a message saying that the button has moved to the three dot menu
  - At the end of Energy Scaffolding, display a message saying how you can edit the goals for the habits you have just created (by clicking or tapping on the tile)

- Polish the 3-dot HabitTile menu:
  - Display it in consistent location on all screen sizes
  - Include helpful icons for each menu item
  - Ensure all menu text is tappable
    - e.g. the Stats option should enable a mode where when you click on any habit tile you get stats
  - Migrate the “Energy Scaffolding” button into the menu (after completion)

---

### Deliverables

#### 1. Energy Scaffolding Input Refinement

- Delay net energy score calculation and habit reordering until after both “Investment” and “Return” values are entered
- Hide the calculated net until both fields are set to avoid user bias in scoring
- Ensure habit rows are draggable in final step of scaffolding (post-calculation)

#### 2. Date Picker Functionality

- Fix the calendar pop-up that opens when editing the start date for the scaffolding flow
- Confirm that start date correctly anchors habit unlock schedule (each 21 days apart unless adjusted)
- Add logic to prevent calendar from silently failing (click should trigger native or custom date modal)

#### 3. Icon Selection Improvements

- Replace static habit icon with a tappable emoji selector
- On tap, open emoji picker and update tile icon accordingly
- If user does not select one, assign randomized emoji from a preset stage pool

#### 4. Three-Dot Menu UX

- Display menu icon in top-right of tile regardless of screen size
- Ensure menu options (e.g., “Edit Habit”, "View Stats" etc) are fully tappable
  - They should essentially set the tiles to a mode where now clicking on them edits them or views stats etc
- Add “Energy Scaffolding” as a persistent menu option until user disables it

#### 5. Energy Scaffolding Call-to-Action

- Add a small "Archive This" button alongside the Energy Scaffolding Call-to-Action at the bottom of the habits screen
- Archiving the button clears it from the screen and puts it in the three dot menu
  - Display a message saying that the button has moved to the three dot menu

---

### Acceptance Criteria

- Users must enter both energy inputs before seeing net return or reordered list
- Calendar field reliably opens and sets habit start dates
- Users can tap the emoji to customize the icon
- 3-dot menu works on all platforms and screen sizes
- Energy Scaffolding no longer appears on main screen unless manually re-enabled

---

### Testing

- Unit test: net energy return calculation logic (correct ordering, no premature display)
- UI test: tap calendar → picker opens → date is saved and applied
- UX test: drag-and-drop order matches net energy return post-“Go”
- Manual QA:
  - Confirm icon selection updates HabitTile
  - Check 3-dot menu renders correctly across screen sizes and platforms

---

### Notes

- Use built-in DateTimePicker or native-base modal date component for reliability
- Animate emoji icon changes with subtle scale or opacity effect
- Ensure that hiding the “Energy Scaffolding” button does not affect habit functionality
- Persist all edits and orders to backend/store immediately after “Go!” step

Implement in atomic commits and validate that each step is non-breaking and visually consistent across mobile and web.
