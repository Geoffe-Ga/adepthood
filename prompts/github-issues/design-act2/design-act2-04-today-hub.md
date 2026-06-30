# design-act2-04: Today hub — the editorial home tab

**Labels:** `frontend`, `ux`, `design`
**Epic:** [Candle & Ink, Act II](design-act2-epic.md)
**Depends on:** 01 (scaffold), 02 (showcase/callout), 03 (motion/empty). **Coordinate with #803** (tab-bar theming).
**Estimated LoC:** ~360

## Problem

The app has no center of gravity. `BottomTabs.tsx:87-93` opens straight into
**Habits** with `initialRouteName="Habits"` (`:144`); the five tabs (Habits,
Practice, Course, Journal, Map) are independent islands. There is no surface that
answers *"where am I in the 36-week journey, and what should I do today?"* — the
exact question a daily inner-development practice should answer on open. This is
the single biggest wow-factor lever in the epic.

Current state: no `HomeScreen` / `TodayScreen` exists anywhere in the router
(`a7d95417` shell survey). Each feature is reached only by its own tab.

## Scope

Add a new **Today** tab as the app's landing surface — an editorial "front page"
that **aggregates existing data** (no new backend, no new endpoints) into one
calm, paced screen and routes into the feature tabs for the actual work. Reuse
the existing stores/clients (`useProgramStore`, habits hook, practice + course +
journal clients). This issue builds the hub shell + the aggregation; deep
polish of each linked feature stays in its own issue.

## Tasks

### 1. Register the tab

- Add a `Today` tab to `BottomTabs.tsx` as the **first** tab and set
  `initialRouteName="Today"` (icon: `Sunrise`/`Sun` from lucide). Update
  `RootTabParamList` + `BottomTabs.test.tsx` for the new tab and order.
- Keep all existing routes/deep-links; Habits stays a tab, just no longer first.

### 2. Build the hub, paced with the new primitives

New `frontend/src/features/Today/TodayScreen.tsx` built from `ScreenScaffold`
(scroll) with these bands, top to bottom:

1. **Hero (`ShowcaseCard`)** — a serif greeting + the user's place in the
   journey: eyebrow `WEEK 12 · ORANGE` (from `useProgramStore`), a serif
   `type().display` line (time-of-day greeting), and a one-line "today's
   intention" drawn from the current stage. The umber showcase is the arrival.
2. **Today's habits (`EditorialSection`)** — a compact, read-only summary of
   today's habit progress (e.g. "3 of 5 logged") with a row of mini tiles or a
   progress strip, reusing the habits store/selectors (do **not** re-implement
   logging here — tapping routes to the Habits tab).
3. **A practice to begin (`EditorialSection`)** — the active practice for the
   current stage (from the practice client) with a single **Begin** CTA that
   routes to the Practice tab; falls back to an `EmptyState` ("No practice set —
   browse the catalog") when none is set.
4. **From the journal (`EditorialSection`)** — the current weekly prompt (reuse
   the weekly-prompt data already on the shelf) or the most recent entry's title;
   CTA routes to Journal (prompt → entry with prefill, mirroring the shelf wiring).
5. **Continue the course (`EditorialSection`)** — the next unread chapter / stage
   intro for the current stage; CTA routes to Course.
6. **Optional `CalloutBand`** — one scarce high-voltage nudge when there is a
   single clear next action (e.g. "You're one practice from this week's goal").

### 3. States

- First paint uses `Skeleton`/`SkeletonCard` (issue 03) per band while its source
  loads — never a full-screen spinner.
- Each band degrades to a quiet `EmptyState` independently; one failing source
  never blanks the hub.
- Bands stagger in with `useEntrance` (issue 03), disabled under reduced motion.

## Tasks — tests

- `BottomTabs.test.tsx`: Today is present, first, and the initial route.
- `TodayScreen.test.tsx`: renders the hero from program-store data; the practice
  band shows Begin when a practice is set and `EmptyState` when not; each CTA
  navigates to the right tab (mock navigation); skeletons show while loading; a
  thrown source renders that band's empty state without crashing the screen.

## Acceptance Criteria

- Opening the app lands on **Today**; it shows the journey position, today's
  habits summary, a practice-to-begin, a journal nudge, and the next course step,
  each routing into its feature tab.
- No new backend; all data comes from existing stores/clients; one failing source
  degrades only its own band.
- Hero uses the showcase surface; sections use the shared scaffold; loading uses
  skeletons; motion is reduced-motion-safe.
- All existing tab routes/deep-links/testIDs intact; `cd frontend && npm test &&
  npm run lint && npx tsc --noEmit` green.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/navigation/BottomTabs.tsx` | Modify — add Today, make it initial |
| `frontend/src/features/Today/TodayScreen.tsx` | **Create** |
| `frontend/src/features/Today/components/*.tsx` | **Create** — band components |
| `frontend/src/navigation/__tests__/BottomTabs.test.tsx` | Modify |
| `frontend/src/features/Today/__tests__/TodayScreen.test.tsx` | **Create** |
