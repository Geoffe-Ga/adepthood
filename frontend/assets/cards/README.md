# Card meditation — image assets

This folder holds the static card art bundled with the app for the
`card_meditation` practice mode. The frontend resolves each card's
`asset_key` to a local image via
[`assetResolver.ts`](../../src/features/Practice/data/assetResolver.ts).

> **Do not commit real Rider-Waite-Smith scans in the same PR that wires
> up the resolver.** Get the bundler green first with the placeholder,
> then drop real artwork in a follow-up content PR so the diff is easy
> to review and rollback is trivial.

## Folder layout

```
frontend/assets/cards/
├── _placeholder.png        # 800×1200 placeholder shipped by issue #349
├── README.md               # this file
└── rws/                    # Rider-Waite-Smith images go here (one per slug)
    └── .gitkeep
```

Future decks live as sibling folders: `frontend/assets/cards/thoth/`,
`frontend/assets/cards/marseille/`, etc. Each folder owns the artwork
for one deck; the asset_key (`<deck_id>/<slug>`) carries the routing.

## Image spec

| Property      | Value                                                         |
| ------------- | ------------------------------------------------------------- |
| Format        | JPEG (preferred) or PNG                                       |
| Dimensions    | 800 × 1200 px (2:3 portrait — standard tarot card aspect)     |
| Quality       | JPEG q85                                                      |
| Target weight | 100–250 KB per card (78 cards × 200 KB ≈ 15 MB bundle impact) |
| Color space   | sRGB                                                          |
| Background    | Opaque — the view renders cards on the active stage swatch    |

Large bundles slow cold start on mid-tier Android. If a deck exceeds
~20 MB total, move it behind a runtime download to S3/CDN before
shipping (see [Migration plan](#migration-plan-s3--cdn) below).

## Filenames

Use the card's `slug` (snake_case) with the chosen extension. Filenames
are mechanical — derive them straight from the slug list below.

### Major arcana (22 files)

```
the_fool.jpg
the_magician.jpg
the_high_priestess.jpg
the_empress.jpg
the_emperor.jpg
the_hierophant.jpg
the_lovers.jpg
the_chariot.jpg
strength.jpg
the_hermit.jpg
wheel_of_fortune.jpg
justice.jpg
the_hanged_man.jpg
death.jpg
temperance.jpg
the_devil.jpg
the_tower.jpg
the_star.jpg
the_moon.jpg
the_sun.jpg
judgement.jpg
the_world.jpg
```

### Minor arcana (56 files — 14 ranks × 4 suits)

For each suit in `{wands, cups, swords, pentacles}`, drop these 14
filenames:

```
ace_of_<suit>.jpg
two_of_<suit>.jpg
three_of_<suit>.jpg
four_of_<suit>.jpg
five_of_<suit>.jpg
six_of_<suit>.jpg
seven_of_<suit>.jpg
eight_of_<suit>.jpg
nine_of_<suit>.jpg
ten_of_<suit>.jpg
page_of_<suit>.jpg
knight_of_<suit>.jpg
queen_of_<suit>.jpg
king_of_<suit>.jpg
```

So the full RWS folder will eventually hold **78 image files** plus the
`.gitkeep` (which can stay or be deleted once a real image lands).

## Wiring real images

Until real art ships, every RWS `asset_key` in
[`assetResolver.ts`](../../src/features/Practice/data/assetResolver.ts)
resolves to `_placeholder.png`. Replacing the placeholder per card is a
two-line change:

1. Drop e.g. `the_fool.jpg` into `frontend/assets/cards/rws/`.
2. In `assetResolver.ts`, add (or update) the literal entry:

   ```ts
   'rws/the_fool': require('../../../../assets/cards/rws/the_fool.jpg'),
   ```

Metro requires the `require()` path to be a string literal — do not try
to compute it from the slug at runtime.

You can ship cards one at a time, suit by suit, or all 78 in one batch.
Tests in
[`data/decks/__tests__/rws.test.ts`](../../src/features/Practice/data/decks/__tests__/rws.test.ts)
verify that every defined card still resolves to _some_ image — they do
not require the placeholder specifically — so an incremental migration
keeps the suite green.

## Licensing reminder

The Rider-Waite-Smith deck (Pamela Colman Smith, 1909) is **public
domain in the United States** as of January 1 2025. Outside the US,
copyright duration varies — confirm before bundling derivative scans
or restored editions:

- Some restored editions (Smith Centennial, Universal Waite, etc.) carry
  fresh copyright on the new artwork. Use original 1909 scans, e.g. the
  Wikimedia Commons set, to stay safe.
- For decks beyond RWS, get explicit licensing from the publisher in
  writing and store the agreement in `docs/licensing/`.

## Adding a future deck

1. Pick a snake*case `deck_id` matching `^[a-z]a-z0-9*]\*$`(e.g.`thoth`, `marseille`, `wild_unknown`).
2. Create `frontend/src/features/Practice/data/decks/<deck_id>.ts`
   exporting `readonly CardMeta[]` with the same `slug`,`name`,
   `keyword`, `symbolism`, `asset_key: "<deck_id>/<slug>"` shape.
3. Append a `DeckMeta` entry to `BUNDLED_DECKS` in
   `data/decks/index.ts`.
4. Create `frontend/assets/cards/<deck_id>/` with a `.gitkeep` and the
   image files (or placeholders).
5. Extend the literal `require()` map in `assetResolver.ts` to cover
   the new deck's asset_keys.

The card-meditation backend never validates `deck_id` against an
allowlist (the manifest is purely a client-side concept), so adding a
deck is a frontend-only PR.

## Migration plan: S3 / CDN

We bundle decks today to keep v1 trivially offline. The plan once a
second deck (Thoth) ships and the bundle crosses ~25 MB:

1. **Switch storage** — upload artwork to a public S3 bucket fronted
   by CloudFront. Path schema: `s3://adepthood-decks/<deck_id>/<slug>.jpg`.
2. **Extend `assetResolver`** — when the resolver doesn't have a local
   `require()` for an `asset_key`, return a remote `{ uri }` source
   built from a `RemoteDeckSpec` registered in `BUNDLED_DECKS`.
3. **Cache locally** — wrap the remote source in
   `expo-image`'s persistent disk cache so cards load instantly on
   subsequent sits (and gracefully degrade to placeholder when offline).
4. **Pre-fetch on deck pick** — when the user selects a remote deck in
   the configurator, kick off a background pre-fetch of all 78 images
   so the first sit is offline-safe.

The `asset_key` contract (`<deck_id>/<slug>`) does not change across
the migration, so backend rows stay valid.
