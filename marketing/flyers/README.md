# Promotional flyers

Three single-page, print-ready flyers for public noticeboards — libraries,
co-op and grocery community boards, yoga and movement studios.

| File | Angle | Meant for |
| --- | --- | --- |
| `out/flyer-1-journal.pdf` | The journal that returns your own past writing to you | Libraries, bookshops, writing groups |
| `out/flyer-2-wavelength.pdf` | The Archetypal Wavelength as a readable shape for your cycles | Grocery / co-op community boards |
| `out/flyer-3-course.pdf` | APTITUDE as a 36-week practice ramp that starts at 1–3 minutes | Yoga, meditation and movement studios |

- **Size:** US Letter, 8.5 × 11 in, full colour, full-bleed footer band.
- **QR:** all three encode `https://aptitude.guru`, version 3, error correction
  level H (≈30% recoverable), printing at 1.02 in — a 0.72 mm module, comfortably
  above the ~0.4 mm floor for phone cameras, with margin for scuffing on a corkboard.
- **Type:** Fraunces (display), Spectral (body), Inter (labels) — all SIL Open
  Font License, embedded in `assets/fonts/`.
- **Palette:** the app's own Candle & Ink tokens, taken from
  `frontend/src/design/tokens.ts` and `frontend/src/design/DESIGN.md`.

## Rebuilding

```bash
./build.sh          # renders every src/*.html to out/*.pdf and a 2x proof out/*.png
```

Requires the Chromium that ships with Playwright; override with
`CHROME=/path/to/chrome ./build.sh`. The proof PNG is rendered into a viewport
taller than the page and then cropped, because headless Chromium's usable
viewport is ~88 px shorter than `--window-size` asks for and silently clips the
bottom of an exactly-page-height screenshot.

## Every claim, and where it comes from

Nothing on these flyers is asserted without a source in one of the five repos.

### Flyer 1 — the journal

| Claim | Source |
| --- | --- |
| "private, encrypted journal" / "Entries are stored encrypted" | `docs/your-data.md` ("Your entries are stored encrypted, and the export decrypts them"); `NORTH-STAR.md` §2 |
| Returns your own past writing as notes in the margin | `README.md` § Features — "Get Resonance: anchored margin notes (Marginalia) reflect your own past wisdom back to you" |
| "Not advice from a chatbot. Your words, handed back." | `NORTH-STAR.md` §9 — "the wisdom reflected back is the user's own, so the software cannot become a teacher-above" |
| Export as JSON + plain Markdown, or delete the account, from Settings | `docs/your-data.md` § "Taking a copy of your writing" — Settings → Export my data, two named files, no request form |
| "Nothing is gated, nothing is mandatory" | `NORTH-STAR.md` §3; `CLAUDE.md` § Project Overview |
| Habits, practices, a course and a community are optional depths | `README.md` § Features — "Optional depths — choose any, in any order" |
| "The stated goal is that you eventually stop needing it" / no lock-in | `NORTH-STAR.md` §8 — "The app's deepest success … is its own eventual obsolescence"; "Build nothing that punishes leaving" |

The journal entry and margin note in the illustration are written examples, not
a real person's writing. The flyer says so in its footnote.

### Flyer 2 — the Archetypal Wavelength

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

### Flyer 3 — the course

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

1. **"Gift economy — pay what you can"** appears in the footer of all three.
   That framing came from the brief, and the giftability half is pinned by ADR
   0008 — but the pay-what-you-can half depends on the Gumroad listing actually
   being configured for pay-what-you-want pricing. If it isn't, edit the
   `.terms` paragraph in the footer of each `src/*.html` and re-run `./build.sh`.
2. **`aptitude.guru` is the QR target for all three.** Signup needs a licence
   key, so that page has to explain the offer and lead to purchase. It could not
   be checked from this environment.
