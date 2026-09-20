# Promotional flyers

Two formats of the same three pitches, for libraries, grocery and co-op
community boards, and yoga / movement studios.

## Posters — for a wall you walk past

The primary artefact. One idea readable across a room, proof only for whoever
stops, and a large QR. A deep umber field so the sheet reads as an object on a
corkboard otherwise covered in white paper.

| File | The one idea | Venue |
| --- | --- | --- |
| `out/poster-1-library.pdf` | "Your journal, answering back." | Libraries, bookshops, writing groups |
| `out/poster-2-grocery.pdf` | "Your moods have a shape." | Grocery / co-op community boards |
| `out/poster-3-studio.pdf` | "It starts with three minutes." | Yoga, meditation, movement studios |

## Handouts — for a table, a counter, or a hand

The longer editorial version of each pitch: too much text for a wall, right for
something somebody picks up and takes away.

| File | Venue |
| --- | --- |
| `out/handout-1-library.pdf` | Libraries, bookshops, writing groups |
| `out/handout-2-grocery.pdf` | Grocery / co-op community boards |
| `out/handout-3-studio.pdf` | Yoga, meditation, movement studios |

- **Size:** US Letter, 8.5 × 11 in, full colour.
- **Type:** Fraunces (display), Spectral (body), Inter (labels) — all SIL Open
  Font License, embedded in `assets/fonts/` with their licences.
- **Palette:** the app's own Candle & Ink tokens, from
  `frontend/src/design/tokens.ts` and `frontend/src/design/DESIGN.md`. The
  posters use the warm-dark `showcase` / `onShowcase` layer; the terracotta is
  lifted to `#d08558` so it clears WCAG AA on the umber.

## Which flyer did the scan come from

Every one of the six carries its own QR, so a scan is attributable to a
format and a venue. The URLs are standard UTM, which analytics platforms
parse into their own columns with no work on the site:

| Flyer | QR target |
| --- | --- |
| poster-1-library | `aptitude.guru/?utm_source=poster&utm_medium=print&utm_campaign=library` |
| poster-2-grocery | `aptitude.guru/?utm_source=poster&utm_medium=print&utm_campaign=grocery` |
| poster-3-studio | `aptitude.guru/?utm_source=poster&utm_medium=print&utm_campaign=studio` |
| handout-1-library | `aptitude.guru/?utm_source=handout&utm_medium=print&utm_campaign=library` |
| handout-2-grocery | `aptitude.guru/?utm_source=handout&utm_medium=print&utm_campaign=grocery` |
| handout-3-studio | `aptitude.guru/?utm_source=handout&utm_medium=print&utm_campaign=studio` |

`utm_campaign` is the venue, `utm_source` the format — so a dashboard answers
both "which venue pulls" and "do posters or handouts pull" without further
setup. The exact strings are in `assets/qr-targets.json`, which is also what
`verify-qr.py` checks the rendered output against.

This needs analytics on `aptitude.guru` that record UTM parameters (GA4,
Plausible and Fathom all do by default). If there is no analytics at all, the
parameters still appear in server request logs; a shorter `?ref=library` form
would work equally well there and produce a less dense QR.

## Rebuilding and checking

```bash
./build.sh          # every src/*.html -> out/*.pdf plus a 2x proof out/*.png
python3 verify-qr.py  # every rendered QR decoded back against its target URL
```

`build.sh` requires the Chromium that ships with Playwright; override with
`CHROME=/path/to/chrome`. The proof PNG is rendered into a viewport taller than
the page and then cropped, because headless Chromium's usable viewport is
~88 px shorter than `--window-size` asks for and silently clips the bottom of
an exactly-page-height screenshot.

`verify-qr.py` finds the white QR plate in each rendered page, samples its
module grid and compares it module-for-module with the symbol segno generates
for that flyer's URL. It also fails a symbol printing below 0.4 mm per module.
Current output: posters 0.69 mm per module, handouts 0.53 mm — both comfortably
scannable, the posters deliberately larger because they are read off a wall.

## Every claim, and where it comes from

Nothing on these flyers is asserted without a source in one of the five repos.

### The library pitch — the journal

| Claim | Source |
| --- | --- |
| "private, encrypted journal" / "Entries are stored encrypted" | `docs/your-data.md` ("Your entries are stored encrypted, and the export decrypts them"); `NORTH-STAR.md` §2 |
| Returns your own past writing as notes in the margin | `README.md` § Features — "Get Resonance: anchored margin notes (Marginalia) reflect your own past wisdom back to you" |
| "Not advice from a chatbot. Your words, handed back." | `NORTH-STAR.md` §9 — "the wisdom reflected back is the user's own, so the software cannot become a teacher-above" |
| Export as JSON + plain Markdown, or delete the account, from Settings | `docs/your-data.md` § "Taking a copy of your writing" — Settings → Export my data, two named files, no request form |
| "Nothing is gated, nothing is mandatory" | `NORTH-STAR.md` §3; `CLAUDE.md` § Project Overview |
| Habits, practices, a course and a community are optional depths | `README.md` § Features — "Optional depths — choose any, in any order" |
| "The stated goal is that you eventually stop needing it" / no lock-in | `NORTH-STAR.md` §8 — "The app's deepest success … is its own eventual obsolescence"; "Build nothing that punishes leaving" |

The journal entry and margin note are written examples, not a real person's
writing. Both the handout and the poster say so — the handout under its
illustration, the poster in the line beneath its URL ("Journal excerpt shown
is an example"). The poster's "you wrote that in November" is the product's
behaviour dramatised, in the way an advertisement shows a mocked-up screen;
if that reads as too strong a claim, the `cite` line in
`src/poster-1-library.html` is a one-line change.

### The community-board pitch — the Archetypal Wavelength

| Claim | Source |
| --- | --- |
| Six phases: Rising, Peaking, Withdrawal, Diminishing, Bottoming Out, Restoration | `aptitude-course/CLAUDE.md` § The Archetypal Wavelength; `aptitude-course/markdown/resources/archetypal-wavelength.md` |
| The medicine/overdose word pairs (Inspiration/Grandiosity, Joy/Ecstasy, Introspectivity/Anxiety, Tranquility/Self-Doubt, Convalescence/Self-Loathing, Recuperation/Selfishness) | `aptitude-course/google_docs/database_of_course_curriculum/The Archetypal Wavelength - Modes of the Wavelength.csv`, the `Medicine,Purple` and `Toxic,Purple` rows, verbatim |
| Each of the ten stages names all six phases in its own terms | Same CSV — one Medicine row and one Toxic row per stage |
| The Wavelength is the spine of the course and of the app | `README.md`; `NORTH-STAR.md` §5 |
| Entries are sorted by phase and by stage | `NORTH-STAR.md` §2 — the corpus is "tagged by Frequency and by Wavelength phase" |
| "There is no permanent peak on offer" | `aptitude-course/CLAUDE.md` § Core Principles — "Cyclical not climactic … no permanent enlightenment" |
| The mental-health care line | `NORTH-STAR.md` §10 — "Practices, reflections, and teachings complement professional mental-health care and never replace it" |

The flyer states that the phase pairs use the Purple stage's vocabulary, so the
specific words are not mistaken for the whole model.

### The studio pitch — the course

| Claim | Source |
| --- | --- |
| Ten stages, 36 weeks | `aptitude-course/markdown/ExtendedInvitation.md`; `README.md` |
| Eight stages of three weeks, the last two of six | `README.md`; corroborated by the week column in `APTITUDE Complete Map.csv` — stages start at weeks 1, 4, 7, 10, 13, 16, 19, 22, 25, 31 |
| The ten capacity names | `aptitude-course/markdown/resources/about.md`, the numbered list of ten |
| "One to three minutes a day" | `aptitude-course/markdown/01-beige/18-a-note-on-beige-practice.md` — "whichever you choose should take no more than 1-3 minutes" |
| The practice steps up every three weeks | Same file — "we'll be kicking it up a notch every three weeks" |
| "45 min a day" | Same file — "increasing by just a few minutes every few weeks, where you are meditating solidly for 45 minutes a day" |
| One new habit per stage | The `On-Going Habit` column of `APTITUDE Complete Map.csv`; `about.md` — "An Ongoing Habit" |
| Alternatives of the same length for every stage | `aptitude-course/CLAUDE.md` — "All must match stage duration"; `APTITUDE - Alternative Practices.csv` |
| "No guru" | `about.md` — "NO GURU: I am nothing special"; `ExtendedInvitation.md` — "I am no guru" |
| "Householder, not monastic" and the architecture/habits line | `about.md` § What Makes APTITUDE Different |
| "Stages organize the course. Capacities organize a life." | `aptitude-course/CLAUDE.md`, given there as the canonical line (issue #52) |

### On both

| Claim | Source |
| --- | --- |
| A seat you buy can be handed to someone else and is not tied to your email | `docs/adr/0008-giftable-single-active-license-claims.md` — possession of a valid key is sufficient claim proof; purchase email is not compared with account email |

## What these flyers deliberately do not say

- **No per-stage minute ladder.** `CLAUDE.md` lists a 1 → 5 → 10 → 15 → 20 → 30 →
  45 progression, but the Clear Light stage text discusses 75- and 90-minute
  sits, so the ladder is not safe to print. The flyer shows the *shape* of the
  climb and labels only the two figures the course states outright, and says so
  in its footnote.
- **No app-store availability.** `DEPLOYMENT.md` verifies only the web app at
  `app.aptitude.guru`; mobile via Expo EAS is documented but not asserted here.
- **No "free".** Account creation requires a verified APTITUDE licence
  (`backend/src/routers/auth.py`, `signup`), so no flyer implies free access.
- **No user counts, testimonials, outcomes or efficacy claims.** There is no
  source for any of these.
- **No screenshots.** The build environment's egress proxy blocks `aptitude.guru`,
  and a locally-run app would have an empty database, so the flyers use the real
  design tokens rather than a staged screenshot presented as the product.
- **No reference to the author's personal medical history**, which appears in the
  course text but does not belong on a public poster without his say-so.

## Two things to confirm before printing

1. **"Gift economy — pay what you can"** appears in the footer of all six.
   That framing came from the brief, and the giftability half is pinned by ADR
   0008 — but the pay-what-you-can half depends on the Gumroad listing actually
   being configured for pay-what-you-want pricing. If it isn't, edit the
   `.terms` paragraph in the footer of each `src/*.html` and re-run `./build.sh`.
2. **`aptitude.guru` is the QR target for all six.** Signup needs a licence
   key, so that page has to explain the offer and lead to purchase. It could not
   be checked from this environment.
