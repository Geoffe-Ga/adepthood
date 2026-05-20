# Epic: Customizable practices, catalog browse, and share links

**Labels:** `enhancement`, `ritual-practice`, `backend`, `frontend`
**Scope:** Two new modes + asset bundle + create/browse UX + share-link feature
**Estimated total LoC:** ~2,000

## Role

You are a full-stack engineer extending Adepthood's existing customizable practice infrastructure. You build on top of what already exists — you do not duplicate it.

## Goal

Let users create custom practices in any of the supported modes, browse a global catalog, assign a custom practice to any stage, and share a practice with another user via a one-link import flow. Two new modes round out the engine: `random_interval_bell` and `card_meditation` (a deck-agnostic generalization of the existing `tarot` mode, with optional images).

After this epic, a user can:
- Open a global **Practice catalog** and browse presets, their own drafts, and imported practices
- Tap **+ Create** to assemble a custom practice in any of the 11 modes, with progressive-disclosure form UX
- **Use a custom for any stage** (active selection scoped per-stage as today)
- **Share a custom** by generating a link; another user opens the link and imports a copy into their own catalog
- **Meditate on a card** from a curated deck (Rider-Waite-Smith ships with the feature) or pick a photo from their phone

## Context — what already exists

The audit (2026-05-16) confirmed most of the infrastructure is already in place. **Do not rebuild any of this.**

| Capability | Status | Files |
|---|---|---|
| `Practice` table with `submitted_by_user_id` + `approved` | ✓ | `backend/src/models/practice.py:20-58` |
| `POST /practices` user-submission endpoint, rate-limited 5/min | ✓ | `backend/src/routers/practices.py:88-129` |
| Visibility filter (approved OR own draft) | ✓ | `backend/src/dependencies/ownership.py:155-168` |
| `UserPractice` with `stage_number` + `mode_config_override` | ✓ | `backend/src/models/user_practice.py:30-61` |
| `POST /user-practices` + active-resolution per stage | ✓ | `backend/src/routers/user_practices.py:80-130, 276-296` |
| `RitualConfiguratorSheet` with per-mode forms (all 7+2 modes) | ✓ | `frontend/src/features/Practice/configurator/RitualConfiguratorSheet.tsx` |
| Existing tarot mode with 22-card text data | ✓ | `frontend/src/features/Practice/data/tarot.ts` |
| `useActivePractice(stageNumber)` hook | ✓ | `frontend/src/features/Practice/hooks/useActivePractice.ts:156-191` |

## Context — what's missing

| Gap | Sub-issue |
|---|---|
| `random_interval_bell` mode (only deterministic intervals exist today) | 01 + 05 |
| Deck-agnostic `card_meditation` mode with per-card image references | 02 + 06 |
| Rider-Waite-Smith 78-card content module + image asset folder | 04 |
| Practice share-link table + token generate / redeem / import endpoints | 03 |
| Global catalog browse screen (today the picker is per-stage only) | 07 |
| Create-custom flow accessible outside the per-stage picker | 07 |
| Share-link UI + deep-link handler | 03 |

## Output format

Seven sub-issues, each shippable independently. Backend modes ship first; the catalog + create flow lands after the modes (so the mode picker is complete). Share-link is independent of both.

Dependency graph:

```
01 random-interval-bell-backend ── 05 random-interval-bell-frontend
02 card-meditation-backend     ──┬ 04 rws-deck-content
                                 └ 06 card-meditation-frontend
03 share-link-feature            (independent)
                                                          ┌── (uses every mode form, so lands last)
05, 06, 04, plus existing modes ─────────────────────────┴── 07 catalog-and-create-flow
```

## Sub-issues

| # | Title | Scope | LoC |
|---|-------|-------|-----|
| 01 | [Add `random_interval_bell` mode](custom-practices-01-random-interval-bell-backend.md) | Backend | ~200 |
| 02 | [Generalize `tarot` into `card_meditation` mode](custom-practices-02-card-meditation-backend.md) | Backend | ~250 |
| 03 | [Practice share-link feature](custom-practices-03-share-link-feature.md) | Full-stack | ~400 |
| 04 | [Ship Rider-Waite-Smith deck content + asset folder](custom-practices-04-rws-deck-content.md) | Frontend | ~200 |
| 05 | [Build `RandomIntervalBellView` + configurator form](custom-practices-05-random-interval-bell-frontend.md) | Frontend | ~250 |
| 06 | [Build `CardMeditationView` + image picker form](custom-practices-06-card-meditation-frontend.md) | Frontend | ~350 |
| 07 | [Catalog browse screen + Create-custom flow](custom-practices-07-catalog-and-create-flow.md) | Frontend | ~450 |

## UX guard-rails — preventing bloat

With 11 modes after this epic, the create flow is the bloat risk. The Create-custom screen (issue 07) **must** apply these:

- **Categorize modes:** `Timers` (meditation_timer, count_up), `Bells` (metronome, interval_bell, random_interval_bell), `Grounding` (sense_grounding, tallied_grounding, mindful_anchor), `Reflection` (card_meditation, tarot), `Movement` (rep_counter). Render as grouped cards, not a flat list.
- **Progressive disclosure:** every mode form opens with 2–3 core fields and an "Advanced" toggle for the rest.
- **Start-from-template:** the create flow's first action is "Start from a preset" — pick a preset, then customize. Empty-from-scratch is the secondary path.
- **One screen per phase:** Pick mode → configure → name + (optional) stage assign. No mega-form.
- **Smart defaults:** every field has a sensible default so the user can submit immediately after picking a mode.

## Acceptance Criteria (epic-level)

- [ ] User can open the catalog from a top-level nav entry
- [ ] User can create a custom practice in any of the 11 modes from the catalog
- [ ] User can assign any practice (preset, own draft, or imported) to any stage
- [ ] User can generate a share link for a practice and another user can import a copy
- [ ] `tarot` mode behavior is unchanged (`card_meditation` is additive, not a replacement)
- [ ] `pre-commit run --all-files` green on every sub-issue PR
- [ ] Coverage thresholds unchanged

## Constraints

- Build on existing endpoints (`POST /practices`, `POST /user-practices`, `PATCH /user-practices/{id}/customize`, `RitualConfiguratorSheet`) — do not duplicate.
- Keep all new `*Config` / `*Metadata` models as `_ConfigBase` / `_MetadataBase` discriminated subclasses with `extra="forbid"`.
- Each new mode value requires an Alembic migration that drops + recreates `ck_practice_mode_value`.
- For v1, **device-photo card meditation is not persisted** — the user keeps the image on their phone; if they delete it, the card display falls back to the card name + symbolism text. Curated deck images (RWS) ship bundled and always render.
- Share links do **not** auto-approve drafts. Imported practices land as `approved=False, submitted_by_user_id=<importer>`, scoped to that user via the existing visibility filter.
- No admin approval UI in this epic. (Sharing is private + link-based; the `approved` column stays for future community-submission work.)

## References

- `backend/src/domain/practice_modes.py:15-28` — `PracticeMode` enum
- `backend/src/schemas/practice_mode_config.py` — discriminated config union
- `backend/src/schemas/practice_session_metadata.py` — discriminated metadata union
- `backend/src/routers/practices.py:88-129` — user-submission endpoint
- `backend/src/routers/user_practices.py` — UserPractice CRUD + active-resolution
- `backend/src/dependencies/ownership.py:155-168` — visibility filter
- `frontend/src/features/Practice/configurator/RitualConfiguratorSheet.tsx` — existing configurator
- `frontend/src/features/Practice/configurator/forms/` — existing per-mode forms
- `frontend/src/features/Practice/data/tarot.ts` — existing 22-card data
- Sibling epic: [Generalize grounding techniques](grounding-techniques-epic.md) (#336)
