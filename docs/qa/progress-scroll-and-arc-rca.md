# Progress scrolling and arc readability

## Problem and reproduction

Open Map → Your progress on a phone or a short desktop window. Try to scroll
to the energy section, then expand the arc's “Show as table” control and try
again. Content below the viewport is unreachable. Habit births wrap into a
dense emoji legend, and the arc table repeats `Weeks / week: 3` for stages.

## Root cause

- `features/Map/progress/ProgressScreen.tsx` renders `ScreenScaffold` without
  `scroll`; the scaffold defaults to a fixed `View`, even when tables expand.
- `components/charts/Ribbon.tsx` uses the generic wrapping `ChartLegend` for
  stage names and habit births. `progressPresentation.ts` adds an emoji to
  every birth and carryover. Neither group has a stable row layout.
- `ribbonTableRows` projects each stage to its duration alone. Three-week
  stages therefore have identical values, and the shared `Weeks / week`
  heading conflates durations with birth/current-week positions.

## Intended behavior and impact

Epic #3519 D13 and D22, and #3528, call for a 36-week timeline with labelled
stages, habit births, current position, and an equivalent accessible table.
The table must explain where each stage and event falls in that timeline.
The lower rhythm, cycle and energy sections must remain reachable when any
table expands. The merged #3596 still contains these defects; the open
observations PR #3603 supplies prose and does not repair this layout.

## Fix strategy

Use the scaffold's existing scroll mode. Give ribbon labels their own rows,
with a week range or event week beside each name; omit decorative habit icons
from this information-dense surface. List carryovers separately. Project stage
durations to cumulative inclusive week ranges for the table, retaining habit
births, current position and secondary ribbons.

## Why existing checks missed it

The screen tests assert that sections exist, without asserting a ScrollView.
The browser journey uses `toBeVisible`, which also passes for elements outside
the viewport, and captures extra-tall screenshots instead of exercising scroll.
The chart tests assert that a duration is present, without checking timeline
ranges or the geometry of label rows.

## Verification

Add failing regressions for the screen's scroll container, range and event
table values, and icon-free presentation. Extend the existing real-API browser
journey with wheel scrolling in chart and expanded-table modes, viewport
containment and label-row geometry at phone and desktop sizes.

Recorded results:

- Before the fix: 5 failing assertions across the three regression suites.
- After the fix: 71 focused tests pass across 11 suites.
- `scripts/frontend/check-all.sh`: all seven gates pass, including 910 Jest
  suites / 13,598 tests, audit, SDK alignment, lint, format, types and web build.
- The real-API Playwright journey passes at 320×568, 390×844 and 1280×720:
  wheel paging reaches the final energy control with both the chart and the
  expanded arc table; ten stage rows stay separate and within the viewport.
  A first attempt raced one oversized wheel event; repeated viewport-sized
  wheel gestures verify actual reachability without extending any deadline.
