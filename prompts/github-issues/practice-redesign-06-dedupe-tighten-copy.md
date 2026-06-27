# practice-redesign-06: De-duplicate and tighten the copy across Practice surfaces

**Labels:** `enhancement`, `frontend`, `ritual-practice`
**Epic:** [Practice frontend redesign](practice-redesign-epic.md)
**Depends on:** #04 (surfaces settled).
**Estimated LoC:** ~200

## Problem

The same information is phrased differently in different places and explained
more verbosely than it needs to be — "information being repeated and explained
in an overly verbose way".

Current state:
- Duration is phrased three ways: `"{n} min default"` in the (now-deleted)
  switcher, `"{n} min per session"` in `PracticeSelector` (also deleted), `"{n} min"`
  badge in `PracticeDetailScreen.tsx:205-208`, and `"{label} · {n} min"` subtitle
  in `PracticeCatalogScreen.tsx:396`. There is no shared formatter.
- `PracticeDetailScreen` shows mode/stage/duration as badges (lines 202-209)
  **and** re-states the mode in the config summary — and renders Description +
  Instructions + Configuration bullets, which can read long.
- Wizard helper copy is wordy: `CreatePracticeWizard.tsx` ("Most adepts find it
  fastest to copy a preset and tweak it.", "Smart defaults are already filled
  in. Tweak anything that doesn't fit, or jump ahead to naming.") and
  `ModePicker.tsx` blurbs.

## Scope

Introduce one shared duration/copy helper and use it everywhere duration is
shown; trim the detail screen's redundancy; shorten the wizard/picker helper
sentences. Wording and a tiny util only — no layout restructure (that is #07).

## Tasks

1. **Shared duration formatter**
   - Add a small helper (e.g. `frontend/src/features/Practice/utils/formatDuration.ts`
     returning `"{n} min"`) with a unit test, and use it in
     `PracticeCatalogScreen` (row subtitle) and `PracticeDetailScreen` (badge +
     anywhere duration appears). One phrasing everywhere.

2. **Trim the detail screen**
   - In `PracticeDetailScreen.tsx`, remove duplicated facts: the badges already
     show mode/stage/duration, so the config summary should not restate the mode;
     keep Description and Instructions only when present (the guards at lines
     219/224 already do this) and tighten the section labels. Aim for a scannable
     read, not three stacked prose blocks.

3. **Shorten guidance copy**
   - In `CreatePracticeWizard.tsx` and `ModePicker.tsx`, cut the helper sentences
     to one short line each (or remove where the UI is self-evident). Example:
     "Smart defaults are already filled in…" → "Defaults are filled in — tweak or
     continue." Keep meaning, drop words.

4. **Tests**
   - `utils/__tests__/formatDuration.test.ts` for the helper.
   - Update `PracticeCatalogScreen` / `PracticeDetailScreen` / `CreatePracticeWizard`
     / `ModePicker` tests for the new strings.

## Acceptance Criteria

- [ ] Duration is produced by one shared helper everywhere it appears.
- [ ] No fact is shown twice on the detail screen (mode/stage/duration appear once).
- [ ] Wizard and mode-picker helper copy is one short line each.
- [ ] `npm test`, `npx tsc --noEmit`, `npm run lint` green; coverage unchanged.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/utils/formatDuration.ts` | **Create** |
| `frontend/src/features/Practice/utils/__tests__/formatDuration.test.ts` | **Create** |
| `frontend/src/features/Practice/screens/PracticeCatalogScreen.tsx` | Modify |
| `frontend/src/features/Practice/screens/PracticeDetailScreen.tsx` | Modify |
| `frontend/src/features/Practice/screens/CreatePracticeWizard.tsx` | Modify |
| `frontend/src/features/Practice/components/ModePicker.tsx` | Modify |
| `frontend/src/features/Practice/screens/__tests__/*` | Modify |

## Constraints

- Frontend only. Wording + one tiny util; no structural layout change here.
- Do not remove genuinely useful instructions — collapse duplication and trim
  verbosity, don't strip content the user needs.
