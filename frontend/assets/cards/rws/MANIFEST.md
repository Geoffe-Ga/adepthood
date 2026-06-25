# Rider–Waite–Smith Tarot Artwork — Provenance Manifest

These PNGs back the Tarot and Card-Meditation practice modes (issue #467).
Each file is named by its card **slug**; the resolver maps the deck
`asset_key` (`rws/<slug>`) to the file in
`src/features/Practice/data/decks/rwsImages.ts`.

## Source & public-domain rationale

- **Deck:** the 1909 Rider–Waite–Smith Tarot, illustrated by Pamela Colman
  Smith, published by William Rider & Son (London).
- **Public-domain status (US):** the deck was published in **1909**, before
  the 1928 cutoff, so it is in the public domain in the United States. The
  scans below are the standard high-resolution reproductions hosted on
  Wikimedia Commons, tagged `PD-US` / `PD-1923` (now `PD-US-expired`).
- **Retrieved from:** Wikimedia Commons via
  `https://commons.wikimedia.org/wiki/Special:FilePath/RWS_Tarot_<NN>_<Name>.jpg`
  (e.g. `RWS_Tarot_00_Fool.jpg`).
- **Processing:** each source JPEG was resized to 500px wide, stripped of
  metadata, and quantized to an 8-bit palette PNG (ImageMagick) so every file
  stays under the repository's 250 KB asset budget while remaining crisp at
  card display sizes. No artwork was altered, retouched, or recomposed.

## Scope

This issue ships the **22 Major Arcana**. The 56 Minor Arcana are deferred to
the follow-up (`audit-destub-01b`); the resolver already covers the full
78-key space, returning the documented `_placeholder.png` for any
known-but-unshipped key.

## Files (SHA-256, bytes)

| File                     | SHA-256                                                            | Size (bytes) |
| ------------------------ | ------------------------------------------------------------------ | ------------ |
| `death.png`              | `d399277448cb1a6b2d75540418f45d87db0103d01ab6e2087bfe9b421c22305f` | 240844       |
| `judgement.png`          | `e7c3684064a7c2b97cf2348d2c2148d0e525250c57037dd21b2a7bac42eb292f` | 240903       |
| `justice.png`            | `137bff5efb89e4e380382b7c0bd99b55716992a7ed75617a40f017e8f08e7205` | 235823       |
| `strength.png`           | `106607015cebc1fcab851a90b88b537816e5ca0f88cd2fb4408374c257d76e28` | 208312       |
| `temperance.png`         | `87581497c447410123df75f33be971d23372866ae5ead6db6314262a54654485` | 238783       |
| `the_chariot.png`        | `111577a31c5aeb102efce44e0527cead3e12ad3c5a98d3acb2b706b63f5f234d` | 234027       |
| `the_devil.png`          | `aa495e57833c47c969b475147059a8547f9a57bd08e05c1506d89929069ed3d9` | 214485       |
| `the_emperor.png`        | `b7b96af645659d350f563eb6132260e6fffc18b957b919442df98982c4ecee80` | 244363       |
| `the_empress.png`        | `401191645c6b3c428e260501aa7001fb8056ef1a7e57ecb449b852b041a35442` | 234451       |
| `the_fool.png`           | `9670f5d663745263c1ff25a60522917b74296bf5b19c9abe6da46bc776aa358e` | 207745       |
| `the_hanged_man.png`     | `93caeca37fa3eeb6607af4c39d1efd5027af6e52802754019f6dc621882ec0c4` | 236686       |
| `the_hermit.png`         | `637999a43bafb6aacdbe1cdb0ccce07a2b93ab0bc7c97e5ac4078ef7d5e2616e` | 194571       |
| `the_hierophant.png`     | `e2910ab954165f9a5213557c3679dab85406d885c29ca5c56104b314881863d5` | 236218       |
| `the_high_priestess.png` | `f409a786b3949ef8496b84f5b4cc1337f9dc3eb5d5bbddb0cdc4bf5de138dcc3` | 240251       |
| `the_lovers.png`         | `95ff479ed6d56690f6d6ddc3d3258a57ab987e82da9256de651b6e8c0c7370b4` | 242700       |
| `the_magician.png`       | `89d018fe6b3b9796c133d44513bded053981a9f72af08b60996c5cbdac2a2a00` | 209969       |
| `the_moon.png`           | `ab1b72b8cdf64fcde6236162367d7696cf6396cc983a741b2b6fb9f22a3799ab` | 222655       |
| `the_star.png`           | `83a1e7d3f76096a1548d966fbf1d8070c7bc56b87476ac8cc7ed7fdee59a4798` | 220742       |
| `the_sun.png`            | `0bab63f9f9065148cafd90c3d691ed500cda3a111710b46a31444c8c8273b3db` | 230833       |
| `the_tower.png`          | `91a8817b3699e825529003b0c986ffff56b7b82efafb8196fe0de2f3e7841fcd` | 200022       |
| `the_world.png`          | `a7ba0deb5bf4e67f157c959b07ebbad1ba61ee4427fd8c14d8f06329e9196af9` | 235050       |
| `wheel_of_fortune.png`   | `38a5a89451ce0da93959feaaac3432e1baf34d8c9b2b1b630c64cd3b7825c41f` | 233799       |
