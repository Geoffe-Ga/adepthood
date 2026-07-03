# Epic: Map screen legibility — kill overlap/overflow, corner-hug the Aspect labels, fix helix colors

**Labels:** `epic`, `frontend`, `ux`, `bug`, `design`, `priority-critical`
**Scope:** Frontend only (`frontend/src/features/Map/`)
**Estimated total LoC:** ~580
**Source:** Founder screenshot review of the live Map screen (app.aptitude.guru, Stage 3 · Week 8, 2026-07-03)

## Role

You are a senior React Native engineer with a strong visual design sense,
working inside Adepthood's Candle & Ink design language on the Map screen's
"spiral of becoming." You fix layout defects at the **root cause** (the
bug-squashing methodology: RCA → reproduce → red → green → refactor), never by
nudging pixels until a screenshot looks right. Pure geometry lives in
`waveGeometry.ts` and layout copy in `mapLayout.ts`, both fully unit-testable
without rendering — use that.

## Goal

After this epic ships, the Map screen renders with **zero overlapping or
overflowing elements** at phone widths, every label legible without ellipsis
or mid-word truncation, a single (not doubled) helix whose **color bands begin
and end on the center line**, Aspect words hugging **alternating corners** of
the center panel with their unlock estimates attached, and a left column that
reads slightly darker beneath lighter UNITY / EMPTINESS watermarks that stay
inside the screen.

### The seven defects (from the screenshot RCA)

1. **Overlap (circled, top):** the "How the Wavelength works" explainer
   trigger collides with the EMPTINESS watermark and the grid's top rows.
2. **Overlap (circled, bottom):** the balance summary sentence ("Your balance
   right now: some Aspects are alive, others are still thin.") crowds the
   bottom row and overflows its band.
3. **Truncation (right column):** "Understanding" renders as "Understan…"
   and "Yes-And-Ness" as "Yes-And-…" despite the shrink-to-fit escape hatch.
4. **Shadow helix:** every wave segment draws a mirrored, faded far-side path
   (`farD`, opacity 0.35) that reads as a greyed-out ghost helix.
5. **Aspect words swallowed by the helix:** center-column labels (Agency,
   Receptivity, …) are horizontally centered, exactly where the strands cross;
   the "Unlocks in N days" estimate floats separately below the lock.
6. **Left column contrast + watermark overflow:** left-hand stage text is too
   light; UNITY / EMPTINESS should be lighter still, and EMPTINESS overflows
   the right screen edge.
7. **Helix color phase:** strand colors start/end at the outside edges (the
   pole extremes at each stage anchor) instead of at the center line.

## Context

The Map is a three-column responsive grid (`MapScreen.tsx`), with an SVG wave
overlay behind the center column:

| File | Role |
|------|------|
| `frontend/src/features/Map/MapScreen.tsx` | Screen structure: `JourneyHeader`, `MapGrid`, `BalanceSummary`, center cells |
| `frontend/src/features/Map/mapLayout.ts` | Static copy: `STAGE_DISPLAY` (persona/label/textColor), `MAP_ROWS` (right labels), `TITLE_BY_STAGE` |
| `frontend/src/features/Map/waveGeometry.ts` | Pure wave math: `waveSegments` (near `d` + far `farD` paths), `waveArrowheads` |
| `frontend/src/features/Map/WaveOverlay.tsx` | Renders segments/arrowheads; draws the faded `farD` ghost |
| `frontend/src/features/Map/Map.styles.ts` | All Map styles (`rightLabelText`, `titleText`, `arrowLabelText`, `balanceSummary`, `explainerTrigger`) |
| `frontend/src/features/Map/wheelBalance.ts` | `BALANCE_COPY` / `summaryFor` (balance sentence), `emphasisStyle` (keep) |

Key mechanics to know before touching anything:

- **Stage parity:** `isLeftReturning` (`stageData.ts:38`) — even stages swing
  the wave **left**, odd stages **right**. Corner-hugged labels therefore go
  on the **opposite** side (odd → left corner, Agency first), which is what
  the founder asked for and what keeps words off the strand.
- **Wave color today:** each of the 9 segments spans stage *i*'s anchor (a
  pole extreme) to stage *i+1*'s anchor and carries stage *i*'s `textColor`
  (`waveGeometry.ts:256-277`) — that is *why* colors change at the outside
  edges. The bezier's t=0.5 point sits on the midline at the pair's vertical
  midpoint, so splitting there moves every color boundary to the center line.
- **`textColor` is shared** by the left-column text, the wave stroke, and the
  arrowheads. Darkening the left column must NOT darken the helix — issue 05
  introduces a separate derived color for the left text only.

## Output Format

Six independently-shippable sub-issues, each a self-contained 6-component
prompt (role, goal, context/RCA, tasks with TDD ordering, acceptance criteria,
constraints). 01–05 are mutually independent (02/04/05 all touch
`mapLayout.ts`, so rebase in number order if run in parallel); 06 depends on
03 because both rewrite the same `waveGeometry.ts` segment builder and
removing the ghost paths first halves the surface 06 must split.

```
01 remove-overlapping-chrome ─┐
02 hyphenate-right-labels ────┤
03 remove-shadow-helix ───────┼──► 06 centerline-color-transitions
04 corner-hugging-labels ─────┤        (depends on 03 only)
05 left-column-contrast ──────┘
```

## Sub-issues

| # | Title | Scope | Est. LoC |
|---|-------|-------|----------|
| 01 | [Remove the explainer trigger + balance summary (the two overlapping elements)](map-legibility-01-remove-overlapping-chrome.md) | Frontend | ~90 |
| 02 | [Hyphenate the right-column Aspect labels instead of truncating](map-legibility-02-hyphenate-right-labels.md) | Frontend | ~60 |
| 03 | [Remove the greyed-out shadow helix (far-side coil paths)](map-legibility-03-remove-shadow-helix.md) | Frontend | ~60 |
| 04 | [Corner-hug the Aspect labels (Agency left, Receptivity right, …), attach the unlock estimate, rename Self-Love](map-legibility-04-corner-hugging-aspect-labels.md) | Frontend | ~150 |
| 05 | [Darken the left column; lighten UNITY/EMPTINESS and stop their overflow](map-legibility-05-left-column-contrast-and-watermarks.md) | Frontend | ~90 |
| 06 | [Start/end each helix color at the center line](map-legibility-06-centerline-color-transitions.md) | Frontend | ~130 |

## Acceptance Criteria (epic-level)

- [ ] No element on the Map screen overlaps another or overflows the screen
      at 320–430 pt widths: the explainer trigger and balance-summary sentence
      are gone; EMPTINESS/UNITY fit inside the grid.
- [ ] Every right-column Aspect label is fully legible: long words break at a
      correct hyphenation point ("Under-standing", "Yes-And- / Ness") — no
      ellipsis, no shrink-to-fit scaling.
- [ ] Exactly one helix renders — the faded ghost (far-side) strand is gone.
- [ ] Center-column Aspect words hug alternating corners of the center panel
      (Agency bottom-left, Receptivity right, Self-Love left, Community
      right, … all the way up), each with its "Unlocks in N days" estimate
      directly attached; stage 3 reads **Self-Love**, not Self-Interest.
- [ ] Left-column stage text is slightly darker than today; the UNITY and
      EMPTINESS watermarks are lighter than today, unmoved, and fully
      on-screen.
- [ ] Each stage's helix color band starts and ends on the center line (color
      transitions happen at the midline crossings, not at the outside edges).
- [ ] **No regressions:** all existing testIDs (`stage-hotspot-*`, `map-wave`,
      `you-are-here`, `stage-unlock-*`) keep working; every existing Map test
      passes or is updated in the same PR that changes its contract.
- [ ] `cd frontend && npm test && npm run lint && npx tsc --noEmit` green;
      `pre-commit run --all-files` green on every PR. Backend untouched.

## Constraints

- **Bug-squashing methodology on every sub-issue:** reproduce with a failing
  test first (geometry defects reproduce in `waveGeometry.test.ts` /
  `mapLayout.test.ts` without rendering), then the minimal fix, then refactor.
- **No dead code left behind:** removing UI must also remove its orphaned
  styles, copy tables, helpers, and tests (repo de-slop standard).
- **No magic numbers:** every new offset/color/scale is a named constant with
  a docstring, in the module that owns it.
- **Geometry stays pure:** `waveGeometry.ts` must remain React-free and fully
  unit-tested; color-band math is asserted numerically, not by snapshot.
- **Accessibility:** corner-hugged labels keep their stage cells' 44 dp touch
  targets and accessibility labels; contrast changes keep WCAG AA (4.5:1)
  for the left-column text on the parchment ground.
- Conventional commits (`fix(map): …`, `style(map): …`, `test(map): …`);
  one logical change per PR; TDD; coverage ≥ 90% line / 80% branch.

## References

- `frontend/src/features/Map/MapScreen.tsx:731-759` — `JourneyHeader` + explainer trigger
- `frontend/src/features/Map/MapScreen.tsx:835-843` — `BalanceSummary`
- `frontend/src/features/Map/MapScreen.tsx:316-325` — right-label shrink-to-fit render
- `frontend/src/features/Map/MapScreen.tsx:149-162` — `CenterContent` (centered Aspect word)
- `frontend/src/features/Map/mapLayout.ts:69-150` — `STAGE_DISPLAY` (labels + textColors)
- `frontend/src/features/Map/mapLayout.ts:157-164` — `MAP_ROWS` (right labels)
- `frontend/src/features/Map/waveGeometry.ts:215-277` — bezier + segment builder
- `frontend/src/features/Map/WaveOverlay.tsx:67-76` — faded far-side render
- `frontend/src/features/Map/Map.styles.ts` — `rightLabelText:102`, `arrowLabelText:153`, `titleText:162`, `explainerTrigger:252`, `balanceSummary:297`
