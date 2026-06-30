# design-act2-06: Practice catalog + "begin a session" + warm adoption

**Labels:** `frontend`, `ux`, `design`
**Epic:** [Candle & Ink, Act II](design-act2-epic.md)
**Depends on:** 01 (scaffold), 02 (showcase), 03 (empty state)
**Estimated LoC:** ~280

## Problem

Practice is entirely on the **legacy grey/brown** palette — `colors.background.*`
(`#f8f8f8`/`#fff`/`#f0f0f0`), `colors.text.secondary` (`#666`), `colors.primary`
dark brown — across `PracticeScreen.tsx`, `PracticeCatalogScreen.tsx`,
`PracticeDetailScreen.tsx` (`a3bf2f34` survey). It never adopted the warm
"Candle & Ink" language, so it visibly clashes with Habits and the journal.
Two specific user-story weaknesses:

- The **active-practice landing** (`PracticeScreen.tsx:167-214`) presents the
  practice and a Start button as flat grey rows — there is no sense of *arrival
  into a session*, no focal "begin" moment.
- The **catalog** (`PracticeCatalogScreen.tsx`) already has good bones (sectioned
  Presets / My drafts / Imported + stage/mode chips + search) but the rows are
  utilitarian and there is no "recently used" or favourites affordance; empty
  sections say a passive "Nothing here yet." (`:212-216`).

## Scope

Migrate the Practice **landing + catalog + detail chrome** onto the warm semantic
tokens, and re-frame the active-practice landing as a focal "begin a session"
moment using the showcase surface. The in-session player views and the completion
celebration are issue 07; this issue stops at pressing **Start**.

## Tasks

### 1. Warm adoption across Practice chrome

- Replace `colors.background.*` → `surface.*`, `colors.text.*` → `ink.*`,
  `colors.primary` CTAs → `accent.primary`, across `PracticeScreen.tsx`,
  `PracticeCatalogScreen.tsx`, `PracticeDetailScreen.tsx`, and their styles. Use
  `ScreenScaffold` + `ScreenHeader` on the catalog (eyebrow "PRACTICE", serif
  title) and detail screens. Fix the `colors.text.secondary` → accessible/`ink`
  usages flagged in the survey (`PracticeScreen.tsx:333`).

### 2. The "begin a session" moment

- Re-build the active-practice landing as a focal hero: a `ShowcaseCard` carrying
  the practice name (serif `type().title` in `onShowcase.primary`), the frequency
  chip, the duration, and a single large **Begin** CTA (accent fill on showcase).
  The umber surface signals "you are about to drop into focus." Keep the ⚙︎
  Adjust affordance and the existing engine wiring (`status: idle → running`) —
  this is presentation only.
- Give "Change practice" a clear icon (`RefreshCw`) so it reads as *swap*, not
  refresh (survey gap #1).

### 3. Catalog discovery polish

- Add a **Recently used** section at the top of the catalog (derive from the
  user's recent sessions already available to the client; cap ~3). Editorialise
  the rows (icon + serif name + "duration · mode" caption) on `surface.raised`
  with `surfaceShadow.card`.
- Replace passive empty-section text with the shared `EmptyState` where a whole
  section is empty (e.g. My drafts → "Create your first practice" CTA into the
  wizard).

## Tasks — tests

- `PracticeScreen.test.tsx`: the active landing renders the showcase hero with a
  Begin CTA that drives the engine to `running` (mock engine); "Change practice"
  navigates to Catalog; the no-practice path renders `EmptyState` (from 03).
- `PracticeCatalogScreen.test.tsx`: header is the scaffold; a Recently-used
  section appears when recent sessions exist; warm tokens only (no
  `colors.background.*`); existing stage/mode filter + search behaviour unchanged.

## Acceptance Criteria

- Practice landing, catalog, and detail are fully on `surface`/`ink`/`accent` —
  no legacy grey grounds remain; the catalog uses the shared scaffold.
- The active practice presents a focal showcase "begin" moment with one clear
  Begin CTA; engine wiring and Adjust unchanged.
- Catalog shows Recently-used and warm editorial rows; empty sections invite
  creation.
- All existing Practice navigation/engine/testIDs intact; `cd frontend &&
  npm test && npm run lint && npx tsc --noEmit` green.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/PracticeScreen.tsx` | Modify — warm + showcase begin |
| `frontend/src/features/Practice/screens/PracticeCatalogScreen.tsx` | Modify — scaffold, recently-used, rows |
| `frontend/src/features/Practice/screens/PracticeDetailScreen.tsx` | Modify — warm + scaffold |
| `frontend/src/features/Practice/**/*.styles.ts` (as present) | Modify — token swap |
| `frontend/src/features/Practice/__tests__/*.test.tsx` | Modify |
