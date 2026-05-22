# custom-practices-04: Ship Rider-Waite-Smith deck content + asset folder

**Labels:** `enhancement`, `ritual-practice`, `frontend`, `content`
**Epic:** [Customizable practices](custom-practices-epic.md)
**Depends on:** [custom-practices-02](custom-practices-02-card-meditation-backend.md) for the `card_meditation` mode reference
**Estimated LoC:** ~200

## Role

You are a frontend engineer + content curator establishing the deck content module and the asset-folder convention for bundled card decks. The dev (Geoffe-Ga) owns the RWS card images and will drop them into the folder you scaffold.

## Goal

Ship a frontend data module that lists all 78 Rider-Waite-Smith cards with name, keyword, symbolism, and an asset key. Scaffold the matching asset folder with a README that tells the dev exactly where to drop the image files. The bundled deck is consumed by `CardMeditationView` (sub-issue 06).

## Context

The existing major arcana data at `frontend/src/features/Practice/data/tarot.ts` is text-only — no images. This task adds a parallel module for the RWS deck with image references, organized so we can add more decks (Thoth, Marseille, oracle) later without re-engineering.

Card-meditation backend reads only `deck_id` and `image_asset_key` strings — the frontend resolves them against a deck manifest. Keeping the asset layout flat and predictable means the dev can drop images in without code changes.

## Tasks

1. **Create deck content module** `frontend/src/features/Practice/data/decks/rws.ts`:
   - Export `RWS_CARDS: readonly CardMeta[]` with all 78 cards
   - Each entry: `{ asset_key: string; name: string; arcana: "major" | "minor"; suit?: "wands" | "cups" | "swords" | "pentacles"; rank?: string; keyword: string; symbolism: string }`
   - `asset_key` format: `rws/<slug>` where slug uses `snake_case` (e.g. `the_fool`, `ace_of_cups`, `knight_of_swords`)
   - Cards: 22 major + 14 per suit × 4 suits

2. **Create deck manifest** `frontend/src/features/Practice/data/decks/index.ts`:
   - Export `BUNDLED_DECKS: readonly DeckMeta[]` where each entry is `{ id: string; name: string; description: string; cards: readonly CardMeta[]; cover_asset_key: string }`
   - For v1: include the existing 22-card text deck (id `major_arcana_text`) and the new RWS deck (id `rws`)
   - Helper `getDeck(id: string): DeckMeta | undefined`

3. **Asset resolver** `frontend/src/features/Practice/data/assetResolver.ts`:
   - Function `resolveCardImage(asset_key: string | null): ImageSourcePropType | null`
   - For v1 implementation: a hardcoded `require()` map keyed by `asset_key`. Metro's bundler requires static `require()` calls; dynamic strings won't resolve. Generate the map by enumerating the 78 RWS cards. Until the dev drops images in, every require points at a single placeholder file `assets/cards/_placeholder.png` so the build doesn't break.

4. **Scaffold asset folder** `frontend/assets/cards/`:
   - `frontend/assets/cards/_placeholder.png` — 800×1200 transparent or watermarked placeholder so the bundler has something to resolve
   - `frontend/assets/cards/rws/.gitkeep`
   - `frontend/assets/cards/README.md` — **Dev-facing instructions** covering:
     - Exact filenames expected (`the_fool.jpg`, `ace_of_cups.jpg`, etc. — full list of 78)
     - Recommended dimensions: 800×1200 px, JPEG quality 85, 100–250 KB per card
     - Where to drop them: `frontend/assets/cards/rws/`
     - Licensing reminder: RWS is public domain in the US; the dev must verify use in target jurisdictions
     - How to add a future deck: create `frontend/assets/cards/<deck_id>/`, add a content module `frontend/src/features/Practice/data/decks/<deck_id>.ts`, register in `BUNDLED_DECKS`
     - Future plan: S3 + CDN once more than two decks ship (cost vs. bundle size); the resolver will switch to an HTTP fetch with offline cache

5. **Tests** at `frontend/src/features/Practice/data/decks/__tests__/rws.test.ts`:
   - 78 cards total
   - 22 major + 14 × 4 minor arcana
   - All `asset_key` values are unique
   - All slugs match `^[a-z][a-z0-9_]*$`
   - `resolveCardImage` returns the placeholder for every defined card (until real images land)
   - `getDeck("rws")` returns the deck; `getDeck("nonexistent")` returns undefined

## Acceptance Criteria

- [ ] `npm test` green
- [ ] `npx tsc --noEmit` passes
- [ ] `frontend/assets/cards/README.md` exists and tells the dev exactly where to drop images and what to name them
- [ ] `BUNDLED_DECKS` includes `major_arcana_text` and `rws`
- [ ] Bundle builds with the placeholder image in place (no missing-require errors)

## Files

| File | Action |
|------|--------|
| `frontend/src/features/Practice/data/decks/rws.ts` | **Create** |
| `frontend/src/features/Practice/data/decks/index.ts` | **Create** |
| `frontend/src/features/Practice/data/assetResolver.ts` | **Create** |
| `frontend/src/features/Practice/data/decks/__tests__/rws.test.ts` | **Create** |
| `frontend/assets/cards/_placeholder.png` | **Create** |
| `frontend/assets/cards/rws/.gitkeep` | **Create** |
| `frontend/assets/cards/README.md` | **Create** |

## Constraints

- Card data is read-only at runtime; the modules export `as const` / `readonly` everywhere
- Don't commit the actual RWS images in this PR — they ship from the dev's local in a follow-up content drop. The placeholder makes the bundler happy in the meantime.
- Resolver uses static `require()` only — Metro can't bundle dynamic paths
- Keep slugs deterministic so the dev can name files mechanically
- Plan an S3/CDN migration as a follow-up issue once a second deck (Thoth) ships
