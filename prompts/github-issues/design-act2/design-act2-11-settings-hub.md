# design-act2-11: Settings hub + warm adoption

**Labels:** `frontend`, `ux`, `design`
**Epic:** [Candle & Ink, Act II](design-act2-epic.md)
**Depends on:** 01 (scaffold)
**Estimated LoC:** ~200

## Problem

Settings is scattered and grey. There are two independent root-stack screens —
`ApiKeySettingsScreen.tsx` and `TimezoneSettingsScreen.tsx` — reached separately,
with no Settings landing that organises them; logout lives only as a header text
link in the tab bar (`BottomTabs.tsx:113-121`), and the header-right entry is a ⚙︎
emoji (`:111`) (`a7d95417` survey). Both screens are competent but on legacy grey
(`colors.background.card`/`colors.text.primary`), so they read as a different
product from the warm app.

## Scope

Add a single **Settings hub** screen that organises the existing settings as
editorial rows, and migrate the two existing settings screens onto the warm
language and shared scaffold. No settings behaviour changes (API-key storage,
timezone resolution, logout all unchanged).

## Tasks

### 1. Settings hub

- New `frontend/src/features/Settings/SettingsHubScreen.tsx` built from
  `ScreenScaffold` + `ScreenHeader` (eyebrow "SETTINGS", serif title): grouped
  `EditorialSection`s of tappable rows —
  - **Account** → BotMason API key, time zone
  - **Program** → (placeholder rows that route where they already can: e.g.
    re-run habit onboarding if exposed; otherwise omit)
  - **Session** → Log out (moved here from the tab header as a clear destructive
    row), with the existing logout wiring.
- Register the hub in `RootStack.tsx`; point the header-right gear at the hub
  instead of jumping straight to a single settings screen. Replace the ⚙︎ emoji
  with the lucide `Settings` icon for consistency.

### 2. Warm the existing settings screens

- Migrate `ApiKeySettingsScreen.tsx` + `TimezoneSettingsScreen.tsx` onto
  `ScreenScaffold` + `ScreenHeader` and `surface`/`ink`/`accent`; keep the
  stored-key / current-zone cards, validation feedback, reveal toggle, and
  "use device time zone" exactly. Reach them **from** the hub.

## Tasks — tests

- New `SettingsHubScreen.test.tsx`: rows render under grouped sections; tapping a
  row navigates to the right settings screen; the Log-out row fires the existing
  logout.
- `ApiKeySettingsScreen.test.tsx` / `TimezoneSettingsScreen.test.tsx`: warm
  tokens only; all existing behaviour (save/remove/validate/device-tz) unchanged.
- `RootStack`/nav tests: the gear opens the hub; existing deep links
  (`adepthood://api-key-settings`) still resolve.

## Acceptance Criteria

- A Settings hub organises API key, time zone, and logout as editorial rows in
  the warm language; the gear opens the hub.
- Both existing settings screens are on the shared scaffold + warm tokens with no
  behaviour change; logout works from the hub; the deep link to API-key settings
  still resolves.
- No legacy grey grounds; no magic numbers. `cd frontend && npm test &&
  npm run lint && npx tsc --noEmit` green.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Settings/SettingsHubScreen.tsx` | **Create** |
| `frontend/src/features/Settings/ApiKeySettingsScreen.tsx` | Modify — warm + scaffold |
| `frontend/src/features/Settings/TimezoneSettingsScreen.tsx` | Modify — warm + scaffold |
| `frontend/src/navigation/RootStack.tsx` | Modify — register hub, point gear at it |
| `frontend/src/navigation/BottomTabs.tsx` | Modify — gear icon → hub; move logout |
| `frontend/src/features/Settings/__tests__/*.test.tsx` | **Create/Modify** |
