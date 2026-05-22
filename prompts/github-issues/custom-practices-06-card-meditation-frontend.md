# custom-practices-06: Build `CardMeditationView` + image picker form

**Labels:** `enhancement`, `ritual-practice`, `frontend`
**Epic:** [Customizable practices](custom-practices-epic.md)
**Depends on:** [custom-practices-02](custom-practices-02-card-meditation-backend.md), [custom-practices-04](custom-practices-04-rws-deck-content.md)
**Estimated LoC:** ~350

## Role

You are a React Native engineer building the session UI and the configurator form for the new `card_meditation` mode. You integrate `expo-image-picker` so users can attach photos from their phone to a custom card list.

## Goal

Build `CardMeditationView` (full-screen card image + name + timer) and `CardMeditationForm` (deck picker → optional custom card list editor with image picker → per-card duration). The view supports three card sources: a bundled deck (e.g. `rws`), the existing major arcana text deck (`major_arcana_text`), and a fully custom deck of user-picked photos (`deck_id: "custom"`).

## Context

Reference view: `frontend/src/features/Practice/views/TarotMeditationView.tsx` — text-only card display with hidden timer. Reference form: `frontend/src/features/Practice/configurator/forms/TarotForm.tsx`. Bundled decks ship from sub-issue 04 (`frontend/src/features/Practice/data/decks/`). `expo-image-picker` is already a project dependency (verify in `frontend/package.json`; if not, add it).

## Tasks

1. **Frontend types** in `frontend/src/features/Practice/engine/types.ts`:
   - `CardMeditationCard`: `{ name: string; image_asset_key: string | null; image_uri: string | null; symbolism: string | null }`
   - `CardMeditationConfig`: matches backend (sub-issue 02)
   - `CardMeditationMetadata`
   - Extend `RitualConfig` and `RitualMetadata` unions

2. **Card resolution helper** at `frontend/src/features/Practice/data/resolveCard.ts`:
   - `pickCard(config: CardMeditationConfig): CardMeditationCard` — applies `shuffle` to either `config.cards` or the bundled deck's card list, returns one
   - Idempotent within a session: cache the picked card on first render so a re-render doesn't reshuffle

3. **Build the view** at `frontend/src/features/Practice/views/CardMeditationView.tsx`:
   - Props: `{ config: CardMeditationConfig; state: RitualState; controls: RitualControls; onSave?: () => void }`
   - On mount, pick a card (via `pickCard`); store in local state
   - Layout:
     - **Reveal flow** (when `reveal_after_meditation = true`):
       - `status === "running"`: hide the card, show a centered placeholder ("Sit. The card will be revealed when the timer ends.") + timer (or hidden timer per `hide_timer_during_meditation`)
       - `status === "complete"`: reveal the card image full-screen + name + symbolism
     - **Immediate flow** (when `reveal_after_meditation = false`):
       - Show the card image full-screen + name from the start
       - Hide the timer if `hide_timer_during_meditation = true` until complete
   - Image source resolution:
     - `card.image_asset_key` → `resolveCardImage(asset_key)` (from sub-issue 04)
     - `card.image_uri` → `{ uri: card.image_uri }` directly (device path or remote URL)
     - Neither → render the card name + symbolism in the existing tarot-style stylized frame as a fallback
   - On save, emit `CardMeditationMetadata` with the picked card's name, deck_id, and (if available) its index in the deck.

4. **Build the form** at `frontend/src/features/Practice/configurator/forms/CardMeditationForm.tsx`:
   - Section 1 — Deck:
     - Radio: `Major Arcana (text)` / `Rider-Waite-Smith` / `Custom` (driven by `BUNDLED_DECKS` for the first two)
   - Section 2 — When `deck_id !== "custom"`:
     - Display deck summary (cover image thumbnail + card count + description)
   - Section 2 — When `deck_id === "custom"`:
     - Repeating card editor: each row has `name` text input, `Choose photo` button (opens `expo-image-picker`), `symbolism` text input (optional, collapsed by default)
     - Add Card / Remove Card buttons; max 200 cards
     - Empty state: "Add at least one card to use this deck."
   - Section 3 — Behavior (Advanced toggle, collapsed by default):
     - `per_card_minutes` (number, default 5)
     - `shuffle` (toggle, default on)
     - `reveal_after_meditation` (toggle, default off)
     - `hide_timer_during_meditation` (toggle, default on)
   - Client-side validation mirrors backend (e.g. custom requires non-empty `cards`)

5. **Image picker integration**:
   - Wrap `expo-image-picker` in a helper `frontend/src/features/Practice/utils/pickCardPhoto.ts` so the form imports a single function
   - Request media-library permission on first use
   - Return `{ uri: string }` for the resulting asset
   - V1 does not persist the image to backend storage — the `uri` is stored as-is in `mode_config_override`. Add an inline note in the form: "Photos are kept on this device. If you delete the photo, the card falls back to its name."

6. **Wire dispatcher** in `ActiveRitualSession.tsx` for `mode === "card_meditation"`.

7. **Wire configurator** in `RitualConfiguratorSheet.tsx` for `mode === "card_meditation"`.

8. **Tests**:
   - `__tests__/CardMeditationView.test.tsx`: renders bundled deck card with image, renders custom-deck card with `image_uri`, falls back to text when both image sources are missing, hides card during reveal flow, emits metadata on save
   - `__tests__/CardMeditationForm.test.tsx`: renders three deck options, switching to Custom reveals the card-list editor, "Choose photo" calls the picker helper, validation rejects empty custom deck
   - `__tests__/resolveCard.test.ts`: shuffle is deterministic with seed, picks from `cards` override, picks from bundled deck when override is null

## Acceptance Criteria

- [ ] `npm test` green
- [ ] `npx tsc --noEmit` passes
- [ ] `ActiveRitualSession` dispatches `card_meditation` to the new view
- [ ] `RitualConfiguratorSheet` routes the mode to the new form
- [ ] Manual smoke: start a session with `deck_id="rws"` → placeholder card image displays full-screen → timer counts → save → session row has `mode_metadata.mode = "card_meditation"` with `deck_id` and `card_drawn_name`
- [ ] Manual smoke (custom): create a custom practice with `deck_id="custom"`, attach 2 phone photos via picker → save → start session → photo displays full-screen
- [ ] `TarotMeditationView` behavior unchanged

## Files

| File | Action |
|------|--------|
| `frontend/src/features/Practice/engine/types.ts` | Modify |
| `frontend/src/features/Practice/views/CardMeditationView.tsx` | **Create** |
| `frontend/src/features/Practice/views/__tests__/CardMeditationView.test.tsx` | **Create** |
| `frontend/src/features/Practice/configurator/forms/CardMeditationForm.tsx` | **Create** |
| `frontend/src/features/Practice/configurator/forms/__tests__/CardMeditationForm.test.tsx` | **Create** |
| `frontend/src/features/Practice/data/resolveCard.ts` | **Create** |
| `frontend/src/features/Practice/data/__tests__/resolveCard.test.ts` | **Create** |
| `frontend/src/features/Practice/utils/pickCardPhoto.ts` | **Create** |
| `frontend/src/features/Practice/components/ActiveRitualSession.tsx` | Modify |
| `frontend/src/features/Practice/configurator/RitualConfiguratorSheet.tsx` | Modify |
| `frontend/package.json` | Possibly modify (add `expo-image-picker` if absent) |

## Constraints

- V1 does not upload images to backend storage — `image_uri` is a device path stored in JSON
- If a stored device path no longer resolves (user deleted the photo), fall back gracefully to text display; do not crash
- The picked card for a session is fixed at mount; don't reshuffle on re-render
- Mode dispatch in `ActiveRitualSession.tsx` only
- Progressive disclosure for the form (Advanced section collapsed) — prevents bloat
- Match `@/design/tokens`; the card image fills the screen with a generous black/dark border to reduce visual noise during meditation
- Accessibility: card name announced via `accessibilityLabel`, image has descriptive alt text from `symbolism`
