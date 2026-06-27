# practice-redesign-02: Replace the verbose frequency banner with a slim frequency chip

**Labels:** `enhancement`, `frontend`, `ritual-practice`
**Epic:** [Practice frontend redesign](practice-redesign-epic.md)
**Depends on:** #01 (catalog reachable as a route).
**Estimated LoC:** ~250

## Problem

The Practice screen leads with a heavy paragraph banner that is the single
biggest source of clutter and the reason switching practices "doesn't look
clickable and has to say *click here*".

Current state — `frontend/src/features/Practice/components/FrequencyBanner.tsx`:
- `BannerContent` (lines 70-100) renders an aspect chip, a colour label, the
  full server-written `banner_text` paragraph, **and** an italic hint
  `"Tap to replace this practice"` (line 97).
- The entire coloured card is the tap target that opens the switcher
  (`onPress={onSwitch}`, line 80) — a disguised button, hence the explicit hint.
- `ActiveRitualSession.tsx:417` adds a redundant uppercase `"Your Practice"`
  label above the practice name.

## Scope

Collapse the paragraph banner into a compact colour/aspect **chip** and remove
the disguised-switch behaviour and the redundant label. Keep the `useFrequency`
data fetch (the chip still shows colour + aspect). The explicit "Change
practice" button is issue 03 — this issue removes the banner's switch role and
the clutter, leaving a clean header. Do **not** delete `PracticeSwitcherSheet`
yet (issue 04).

## Tasks

1. **Build the slim chip**
   - Replace `FrequencyBanner`'s paragraph layout with a compact pill: a colour
     dot/swatch (from `swatchFor(data.color)`) + the aspect text, sized small.
     Keep the loading/error/`null` branches (lines 109-112).
   - Remove the `banner_text` paragraph and the `"Tap to replace this practice"`
     hint from the always-on flow. If the longer copy is worth keeping, expose it
     behind a tap-to-reveal disclosure on the chip (an expandable line / small
     popover) — it must **not** sit open in the main flow.
   - The chip is **not** the switch control. Drop the `onSwitch` press handler
     here; if you keep `onSwitch` in the props for issue 03, leave the chip
     non-switching for now (or remove the prop and re-add in 03 — coordinate with
     `PracticeScreen.tsx:55-80 usePracticeChrome`).

2. **Remove the redundant label**
   - In `ActiveRitualSession.tsx` `SessionCard` (lines 413-447), drop the
     `"Your Practice"` label (line 417); the practice name (line 428) stands on
     its own.

3. **Tests**
   - Rework `components/__tests__/FrequencyBanner.test.tsx`: chip shows colour +
     aspect, no `banner_text` paragraph in the default render, no
     "Tap to replace" hint.
   - Update `__tests__/PracticeScreen.test.tsx` and any `ActiveRitualSession`
     test that asserted the "Your Practice" label.

## Acceptance Criteria

- [ ] The active Practice screen shows a compact colour/aspect chip, not a paragraph banner.
- [ ] No "Tap to replace this practice" hint and no "Your Practice" label render.
- [ ] `useFrequency` is still the data source for the chip's colour/aspect.
- [ ] `npm test`, `npx tsc --noEmit`, `npm run lint` green; coverage unchanged.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/components/FrequencyBanner.tsx` | Modify (rework; may rename to `FrequencyChip.tsx`) |
| `frontend/src/features/Practice/PracticeScreen.tsx` | Modify |
| `frontend/src/features/Practice/components/ActiveRitualSession.tsx` | Modify |
| `frontend/src/features/Practice/components/__tests__/FrequencyBanner.test.tsx` | Modify (rename if file renamed) |
| `frontend/src/features/Practice/__tests__/PracticeScreen.test.tsx` | Modify |

## Constraints

- Frontend only. Keep using `useFrequency` / `swatchFor`; no API change.
- All colours/spacing from `design/tokens.ts`.
- If you rename the component/file, update every import.
