# Epic: Practice frontend redesign — minimalist, intentional, uncluttered

**Labels:** `epic`, `enhancement`, `frontend`, `ritual-practice`
**Scope:** Frontend-only overhaul of the Practice feature's information architecture, navigation, affordances, copy, and visual density. No backend changes.
**Estimated total LoC:** ~1,525 (net lower — several components are deleted)

## Role

You are a React Native engineer redesigning the Practice feature's frontend.
You change UI, navigation, and copy only. You do **not** touch the backend,
the ritual engine (`engine/`), the per-mode views (`views/`), the mode
configurator forms (`configurator/forms/`), or any API contract. You build on
the existing endpoints and hooks (`useActivePractice`, `userPractices.create`,
`practices.listAll`, `practices.get`, `useFrequency`) — you do not duplicate or
re-shape them.

## Goal

Make the Practice feature feel deliberate and calm. Today there are **three
overlapping ways to choose a practice** (the inline `PracticeSelector`, the
banner-triggered `PracticeSwitcherSheet`, and the `PracticeCatalogScreen` tab),
**two "edit" affordances that do different things** (the active-card gear edits
a *per-user override*; the detail screen's "Customize a copy" creates a *new*
practice), and a verbose, cluttered active screen. None of it reads as a
consciously chosen design.

After this epic:

- The **catalog is no longer a bottom-nav tab**. It is reached deliberately
  from the Practice screen.
- There is **one** way to choose or switch a practice: the catalog. One clear,
  obviously-tappable **"Change practice"** action opens it.
- The three customization verbs are **distinct and unambiguously labelled**:
  **Switch** (pick a different practice), **Adjust** (tweak the active
  practice's settings — the gear/configurator), and **Duplicate & edit**
  (author a new practice from an existing one).
- The active Practice screen is **minimalist**: a slim frequency chip instead of
  a paragraph banner, no redundant labels, no "tap here"-style hints, no
  card-in-card nesting.
- Copy is **de-duplicated and tightened** — duration is phrased one way
  everywhere; nothing is explained twice.

## Design decisions (locked for this epic)

These were chosen up front so every sub-issue pulls in the same direction:

1. **One catalog, everywhere.** Collapse `PracticeSelector` and
   `PracticeSwitcherSheet` into the single `PracticeCatalogScreen`. The catalog
   is the only place to browse, pick, and create practices.
2. **Slim the frequency banner to a chip.** Replace the paragraph
   `FrequencyBanner` with a compact colour/aspect pill. The longer
   spiral-dynamics copy moves out of the always-on flow.
3. **Core IA + polish scope.** This epic fixes navigation, the choose/switch
   flow, the edit-affordance confusion, clutter, and copy, plus a minimalist
   visual pass. The `CreatePracticeWizard`, the recipe-library modals, and the
   (currently dead) `ShareSheet` are touched **only** where they intersect the
   navigation and copy changes — not redesigned.

## Context — what exists today

| Surface | File | Role in the mess |
|---|---|---|
| `Catalog` bottom tab | `frontend/src/navigation/BottomTabs.tsx:72,94` | 6th nav slot the user wants gone |
| Frequency banner | `frontend/src/features/Practice/components/FrequencyBanner.tsx` | Paragraph + "Tap to replace this practice" hint (line 97); whole card is a disguised switch button |
| Practice switcher sheet | `frontend/src/features/Practice/components/PracticeSwitcherSheet.tsx` | One of three choose-surfaces; opened only from the banner |
| Inline selector | `frontend/src/features/Practice/PracticeSelector.tsx` | Full-screen "Choose a Practice" list shown when nothing is active |
| Catalog | `frontend/src/features/Practice/screens/PracticeCatalogScreen.tsx` | The browse surface to keep — repointed from tab to pushed screen |
| Detail | `frontend/src/features/Practice/screens/PracticeDetailScreen.tsx` | "Use for stage…" + "Customize a copy" (line 332) |
| Active card | `frontend/src/features/Practice/components/ActiveRitualSession.tsx:413-447` | "Your Practice" label + gear ⚙︎ "Configure practice" (per-user override) |
| Composition shell | `frontend/src/features/Practice/PracticeScreen.tsx` | Wires banner + switcher + selector together |

## Sub-issues

| # | Title | Scope | Est. LoC |
|---|-------|-------|----------|
| 01 | [Move the catalog off the bottom nav](practice-redesign-01-catalog-off-bottom-nav.md) | Frontend | ~250 |
| 02 | [Slim frequency banner → frequency chip](practice-redesign-02-slim-frequency-chip.md) | Frontend | ~250 |
| 03 | [One explicit "Change practice" action via the catalog](practice-redesign-03-change-practice-via-catalog.md) | Frontend | ~275 |
| 04 | [Retire the selector + switcher; minimal empty state](practice-redesign-04-retire-selector-switcher.md) | Frontend | ~200 |
| 05 | [Disentangle the edit / adjust / duplicate affordances](practice-redesign-05-clarify-edit-affordances.md) | Frontend | ~150 |
| 06 | [De-duplicate and tighten Practice copy](practice-redesign-06-dedupe-tighten-copy.md) | Frontend | ~200 |
| 07 | [Minimalist visual pass on the Practice surfaces](practice-redesign-07-minimalist-visual-pass.md) | Frontend | ~200 |

## Dependency graph

```
01 catalog-off-bottom-nav
   └─ 02 slim-frequency-chip
        └─ 03 change-practice-via-catalog
             └─ 04 retire-selector-switcher
                  ├─ 06 dedupe-tighten-copy ──┐
05 clarify-edit-affordances (after 02, 03) ───┴─ 07 minimalist-visual-pass (last)
```

Build order for the Ralph picker (ascending issue number = dependency order):
01 → 02 → 03 → 04 → 05 → 06 → 07. Each sub-issue is shippable on its own PR and
leaves the app working; later issues assume the earlier ones have merged.

## Acceptance Criteria (epic-level)

- [ ] The bottom nav has **5 tabs** (Habits, Practice, Course, Journal, Map); no Catalog tab.
- [ ] The catalog is reachable from the Practice screen in one obvious tap.
- [ ] There is exactly one way to switch practices, and the control reads as a button.
- [ ] "Switch", "Adjust", and "Duplicate & edit" are visibly distinct and correctly labelled.
- [ ] `PracticeSelector` and `PracticeSwitcherSheet` are deleted (or fully unused and removed).
- [ ] Duration is formatted by one shared helper everywhere it appears.
- [ ] `npm test`, `npx tsc --noEmit`, and `npm run lint` are green on every sub-issue PR.
- [ ] Jest coverage threshold unchanged (≥90%); no `// @ts-ignore` / `// eslint-disable`.

## Constraints

- **Frontend only.** No changes under `backend/`, no API/route/schema changes,
  no Alembic migrations.
- **Do not touch** `engine/`, `views/`, or `configurator/forms/` except to
  rename a user-facing string. The ritual runtime behaviour is out of scope.
- Reuse existing hooks and API clients (`useActivePractice`, `useFrequency`,
  `userPractices`, `practices`). Do not add new endpoints or duplicate clients.
- All design constants come from `frontend/src/design/tokens.ts`. No magic
  numbers, no hard-coded colours.
- Accessibility is non-negotiable: every interactive element keeps an
  `accessibilityRole` + `accessibilityLabel`; tap targets meet
  `touchTarget.minimum` (44dp).
- Each sub-issue ships with tests and leaves the app in a working state.

## References

- `frontend/src/navigation/BottomTabs.tsx`, `frontend/src/navigation/RootStack.tsx`
- `frontend/src/features/Practice/PracticeScreen.tsx`
- `frontend/src/features/Practice/components/{FrequencyBanner,PracticeSwitcherSheet,ActiveRitualSession}.tsx`
- `frontend/src/features/Practice/PracticeSelector.tsx`
- `frontend/src/features/Practice/screens/{PracticeCatalogScreen,PracticeDetailScreen,CreatePracticeWizard,SharePreviewScreen}.tsx`
- `frontend/src/features/Practice/hooks/{useActivePractice,useFrequency}.ts`
- `frontend/src/design/tokens.ts`
