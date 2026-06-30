# design-act2-01: Editorial screen scaffold + section rhythm

**Labels:** `frontend`, `ux`, `design`
**Epic:** [Candle & Ink, Act II](design-act2-epic.md)
**Depends on:** — (foundation; uses tokens shipped by #799/#800/#802)
**Estimated LoC:** ~260

## Problem

Every screen re-invents its own header, page padding, and section spacing.
**Habits** earns its composed feel through a scale-aware `spacing(n, scale)`
rhythm and a consistent header/menu band; nobody else inherits that discipline,
so Practice, Course, Journal-shelf, Auth, and Settings each drift in their own
direction. There is no shared "this is a screen in Adepthood" container, and no
editorial section primitive (eyebrow caption → serif display title → lead) to
give a screen an editorial *arrival*.

Current state:
- No shared scaffold. `CourseScreen.tsx`, `PracticeScreen.tsx`,
  `JournalShelfScreen.tsx`, and the Auth screens each build their own
  `SafeAreaView` + `ScrollView` + ad-hoc title `Text`.
- `type(width).display` (serif, `tokens.ts:520`) exists but is used at hero
  scale only in the journal — screen titles are plain bold sans.
- Spacing tops out at `SPACING.xxl = 30` (`tokens.ts:251-263`); there is no
  named "section rhythm" between major bands, so vertical pacing is inconsistent.

## Scope

Add a small family of shared, token-driven layout primitives and a section
rhythm token. **Presentation + composition only** — no data flow, no behaviour.
This issue ships the primitives and adopts them on **one** screen
(`SettingsHub` is built in 11; here we retrofit the **Auth** container's outer
shell is out of scope) — instead, prove the primitives by adopting them on the
**Course screen header band** as the reference adoption, leaving Course's body
re-imagination to issue 08. Other screens adopt in their own issues.

## Tasks

### 1. Section-rhythm tokens

In `tokens.ts`, add a `rhythm` object (and extend the token tests):

```ts
/** Vertical rhythm between major screen bands (mobile-tuned editorial pacing). */
export const rhythm = {
  screenPaddingH: spacing(2),   // 16 — gutter on phone
  screenPaddingTop: spacing(2), // 16
  sectionGap: spacing(4),       // 32 — between EditorialSections
  blockGap: spacing(2),         // 16 — within a section
  heroPaddingV: spacing(4),     // 32 — hero band vertical breathing room
} as const;
```

### 2. `ScreenScaffold` primitive

New `frontend/src/components/layout/ScreenScaffold.tsx`:
- `SafeAreaView` on `surface.canvas` + an optional `scroll` mode wrapping a
  `ScrollView` with `contentContainerStyle` padding from `rhythm`.
- Props: `{ scroll?: boolean; children; footer?: ReactNode; testID? }`.
- Honours `useResponsive` scale for horizontal padding (match Habits' scale
  approach — `useResponsive.ts`).

### 3. `ScreenHeader` primitive (the editorial arrival)

New `frontend/src/components/layout/ScreenHeader.tsx`:
- Renders an optional **eyebrow** (`type().caption` uppercase, `ink.muted`), a
  **serif display title** (`type().display`, `ink.primary`), an optional **lead**
  paragraph (`type().body`, `ink.soft`), and an optional right-aligned `action`
  slot (e.g. an `IconButton`).
- Props: `{ eyebrow?: string; title: string; lead?: string; action?: ReactNode;
  testID? }`. Title uses `accessibilityRole="header"`.

### 4. `EditorialSection` primitive

New `frontend/src/components/layout/EditorialSection.tsx`:
- A titled content band: optional `title` (`type().heading`, serif) +
  optional `caption` action link, then `children`, with `marginBottom:
  rhythm.sectionGap`.
- Props: `{ title?: string; action?: ReactNode; children; testID? }`.

### 5. Reference adoption

Retrofit the **Course screen's header + stage-metadata band** to use
`ScreenScaffold` + `ScreenHeader` (`CourseScreen.tsx:341-396`, header region
only) so the primitives are exercised by a real screen. Keep all existing Course
testIDs and the content FlatList untouched (full Course re-imagination is 08).

## Tasks — tests

- `tokens.test.ts`: assert the `rhythm` keys/values exist (it is additive).
- New `ScreenHeader.test.tsx`: eyebrow/title/lead render; title carries
  `accessibilityRole="header"`; title style flattens to `fonts.serif`.
- New `ScreenScaffold.test.tsx`: root flattens to `surface.canvas`; `scroll`
  toggles a `ScrollView`.
- Course header test updated for the new nodes; existing Course tests pass.

## Acceptance Criteria

- `rhythm` tokens exist and are the only source of screen padding / section gaps.
- `ScreenScaffold`, `ScreenHeader`, `EditorialSection` exist, are token-only,
  AA-clearing, and responsive-scale aware.
- The Course header renders through the new primitives with a serif display
  title and an eyebrow; no Course route/testID regressions.
- No magic numbers in the new components; `cd frontend && npm test &&
  npm run lint && npx tsc --noEmit` green.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/design/tokens.ts` | Modify — add `rhythm` |
| `frontend/src/components/layout/ScreenScaffold.tsx` | **Create** |
| `frontend/src/components/layout/ScreenHeader.tsx` | **Create** |
| `frontend/src/components/layout/EditorialSection.tsx` | **Create** |
| `frontend/src/components/layout/__tests__/*.test.tsx` | **Create** |
| `frontend/src/features/Course/CourseScreen.tsx` | Modify — header band only |
