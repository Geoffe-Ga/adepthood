# audit-destub-01: Ship real tarot artwork + a real resolver

**Labels:** `audit-destub`, `frontend`, `aspirational`, `priority-critical`
**Epic:** De-Stub: Make Aspirational Features Real
**Estimated LoC:** ~650  (hard cap 700)

## Problem
`frontend/src/features/Practice/data/assetResolver.ts:9-16` maps **all 78** Rider–Waite–Smith
cards to a single `_placeholder.png`: `buildRwsImageMap()` builds a `Map` whose every value is
the one `PLACEHOLDER` require. The entire visual payoff of the Tarot and Card-Meditation
practice modes is therefore a stub — every draw shows the same grey card.
**Current state:** §5.1 class **fake** (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md` §6, row 1; §2 item 4).
This feature is **supposed to be real for ship** — it is the centrepiece of two practice modes.

## Scope
**Covers:** sourcing public-domain RWS artwork, adding a versioned asset folder + a generated
manifest, rewriting the resolver to map each `asset_key` to its own bundled image, and wiring a
**representative slice** (the 22 Major Arcana) end-to-end as the proof the pipeline works.
**Does NOT cover:** hand-retouching art, the custom-deck photo-upload path (`pickCardPhoto.ts`,
tracked separately), or any backend change — `asset_key` already flows from the deck data.

If bundling all 78 images plus the manifest would breach the 700-LoC cap, this issue ships the
resolver + the 22-card Major Arcana slice and the manifest generator, and files a thin follow-up
(`audit-destub-01b`) to add the 56 Minor Arcana images using the now-proven pipeline. Either way
the resolver must already handle the full 78-key space with a documented placeholder fallback for
any key whose art has not yet landed.

## Asset sourcing approach
- Use the **1909 Pamela Colman Smith RWS deck**, which is public domain in the US (published
  pre-1928). Bundle the images directly in-repo under
  `frontend/assets/cards/rws/<asset_key>.png` (one PNG per `asset_key`, e.g.
  `rws/the_fool.png`), so Metro statically bundles them and there is no network dependency.
- Add `frontend/assets/cards/rws/MANIFEST.md` recording the source, the public-domain
  rationale, and a per-file checksum, so the provenance is auditable in-tree.
- Keep `_placeholder.png` as the documented fallback for any unmapped key.

## Tasks
1. **Add the artwork + manifest** — create `frontend/assets/cards/rws/*.png` (Major Arcana for
   this issue; full deck if within cap) and `frontend/assets/cards/rws/MANIFEST.md` with source +
   provenance + checksums.
2. **Generate a static require map** — add `frontend/src/features/Practice/data/decks/rwsImages.ts`
   exporting a `Record<string, ImageSourcePropType>` of `asset_key → require(...)`. Metro requires
   string-literal `require` paths, so this map is generated/maintained explicitly (one entry per
   bundled image), not built from a loop.
3. **Rewrite the resolver** — `assetResolver.ts`: `resolveCardImage(asset_key)` looks up
   `rwsImages.ts` first, falls back to `PLACEHOLDER` for known-but-unshipped keys, returns `null`
   for `null` / unknown keys. Keep the existing signature so callers are untouched. TDD: a test
   asserts a real (non-placeholder) `ImageSourcePropType` resolves for every shipped key, `null`
   for `null`, and the placeholder fallback for a known-but-unshipped key.
4. **Coverage** — extend `assetResolver` tests to assert the resolver no longer returns one shared
   reference for every RWS key (the regression that this issue fixes).

## Acceptance Criteria
- [ ] `resolveCardImage` returns a distinct, real bundled image for every shipped `asset_key`
      (Major Arcana minimum), and never the same reference for two different shipped keys.
- [ ] `resolveCardImage(null)` returns `null`; an unknown key returns `null`; a known-but-unshipped
      key returns the documented placeholder.
- [ ] `frontend/assets/cards/rws/MANIFEST.md` records source, public-domain rationale, and per-file
      checksums.
- [ ] A follow-up issue is filed if the Minor Arcana are deferred; the resolver already covers the
      full 78-key space.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on --all-files.

## Files to Create/Modify
| File | Action |
|------|--------|
| `frontend/assets/cards/rws/*.png` | Create (per-card public-domain artwork) |
| `frontend/assets/cards/rws/MANIFEST.md` | Create (provenance + checksums) |
| `frontend/src/features/Practice/data/decks/rwsImages.ts` | Create (asset_key → require map) |
| `frontend/src/features/Practice/data/assetResolver.ts` | Modify (real lookup + fallback) |
| `frontend/src/features/Practice/data/__tests__/assetResolver.test.ts` | Create/Modify (distinct-image + fallback tests) |
