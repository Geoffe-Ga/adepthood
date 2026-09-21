# Promotional flyers

Four wall posters — one per user story in
[`NORTH-STAR.md` §7](../../NORTH-STAR.md) — plus three long-form handouts.

## Posters — one per user story

Each poster is built in five zones, in the order a passer-by takes them:

1. **Hook** — huge; names their private experience. Buys two seconds.
2. **Turn** — one line; says *there is a name for this*. Buys twenty more.
3. **Pitch** — what the thing actually is, in one sentence.
4. **Points** — three specifics that make the pitch believable.
5. **Ask** — QR, URL, terms.

About ninety words each. A product claim does not stop this audience;
recognition does, so every hook is a line of recognition rather than a
benefit statement.

| Poster | User story | Hook | Suits |
| --- | --- | --- | --- |
| `poster-1-initiation` | The Householder Shaman — insight integration | "Something opened. Nobody helped you close it." | Yoga and meditation studios, metaphysical and occult shops, herbalists |
| `poster-2-moods` | The Neurospicy User Manual | "Three good weeks. Then the floor. Every time." | Grocery and co-op boards, libraries, clinic and therapy waiting rooms |
| `poster-3-sangha` | The Chronically Online Liminal Trickster Mystic | "You have a whole community. You've never met any of them." | Coffee shops, co-working spaces, game and record shops, comic stores |
| `poster-4-agency` | The Liminal Creep becoming a Whole Adept — polycrisis | "You can name every crisis. You still can't start the dishes." | Libraries, bookshops, community organising and mutual-aid boards |

Venues are a recommendation, not a constraint — the QR reports which poster
pulled, so a week of data beats the guess.

## Handouts — for a table, a counter, or a hand

The three topics at editorial length. Too much text for a wall; right for
something somebody picks up and takes away.

| File | Topic |
| --- | --- |
| `out/handout-1-journal.pdf` | The journal and its margin notes |
| `out/handout-2-wavelength.pdf` | The Archetypal Wavelength, with each phase's medicine and overdose |
| `out/handout-3-course.pdf` | The course: ten stages, the practice ramp, the 36-week cadence |

- **Size:** US Letter, 8.5 × 11 in, full colour.
- **Type:** Fraunces (display), Spectral (body), Inter (labels) — all SIL Open
  Font License, embedded in `assets/fonts/` with their licences.
- **Palette:** the app's own Candle & Ink tokens, from
  `frontend/src/design/tokens.ts`. The posters use the warm-dark `showcase` /
  `onShowcase` layer, with the terracotta lifted to `#d08558` so it clears
  WCAG AA on the umber.

## Which flyer did the scan come from

Every one of the seven carries its own QR. The URLs are standard UTM, which
analytics platforms parse into their own columns with no work on the site:
`utm_source` is the format, `utm_campaign` the poster or topic.

| Flyer | `utm_source` | `utm_campaign` |
| --- | --- | --- |
| poster-1-initiation | `poster` | `initiation` |
| poster-2-moods | `poster` | `moods` |
| poster-3-sangha | `poster` | `sangha` |
| poster-4-agency | `poster` | `agency` |
| handout-1-journal | `handout` | `journal` |
| handout-2-wavelength | `handout` | `wavelength` |
| handout-3-course | `handout` | `course` |

`utm_medium` is `print` throughout. The exact strings live in
`assets/qr-targets.json`, which is also what `verify-qr.py` checks the
rendered output against.

This needs analytics on `aptitude.guru` that record UTM parameters (GA4,
Plausible and Fathom all do by default). With no analytics at all the
parameters still appear in server request logs, where a shorter
`?ref=initiation` form would work equally well and give a less dense QR.

## Rebuilding and checking

```bash
./build.sh            # every src/*.html -> out/*.pdf plus a 2x proof out/*.png
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
Current output: posters 0.65 mm per module, handouts 0.53 mm.

## Every claim, and where it comes from

Nothing on these flyers is asserted without a source in one of the five repos.

### The posters

The hooks are advertising copy addressed to a reader, not assertions of
fact — "Three good weeks. Then the floor." makes no claim about the product.
Everything below the hook does, and each line traces to a source.

| Claim | Source |
| --- | --- |
| **1.** "an initiation you entered and were never brought out of" | `NORTH-STAR.md` §7, the Householder Shaman — "initiations and Dark Nights they entered but were never supported through" |
| **1.** "a 36-week container … ten stages, one practice and one habit at a time" | `README.md`; the `On-Going Habit` and practice columns of `APTITUDE Complete Map.csv` |
| **1.** "Integration, not transcendence" | `aptitude-course/markdown/resources/about.md` — "INTEGRATIVE, NOT ESCAPIST" |
| **1.** "one to three minutes a day, stepping up every three weeks" | `aptitude-course/markdown/01-beige/18-a-note-on-beige-practice.md` |
| **1.** "You get the blueprints; you choose the materials" | `about.md` — "APTITUDE gives you the blueprints for a staircase, but you choose what materials" |
| **2.** "a wave with six phases, and it keeps its order" | `The Archetypal Wavelength - Modes of the Wavelength.csv`; `archetypal-wavelength.md` |
| **2.** "Every phase has a medicine and an overdose" | The same CSV's `Medicine` and `Toxic` sections |
| **2.** "The bottom has its own medicine, and it isn't 'try harder'" | That CSV's bottoming-out column — Beige *Planning*, Purple *Convalescence*, Green *Repose* |
| **2.** "encrypted, exportable, deletable" | `docs/your-data.md` |
| **3.** "its stated job is to give you back to the one where you actually live" | `NORTH-STAR.md` §4 — the Sangha as "springboard back to embodied community"; §7, persona 3 |
| **3.** "A private journal, a 36-week course, and a Discord" | `README.md` § Features |
| **3.** "Keep the journal, never open the course — that counts as using it right" | `NORTH-STAR.md` §3 — "A user who stays at the journal floor for years … has used Adepthood exactly correctly" |
| **3.** "Nothing here punishes you for leaving" | `NORTH-STAR.md` §8 — "Build nothing that punishes leaving" |
| **4.** "a 36-week rite of passage from Liminal Creep to Whole Adept" | `ExtendedInvitation.md`; `markdown/resources/liminal-creep.md` |
| **4.** "scaffolded so the stack never outruns the energy you actually have" | `about.md` — "scaffolding energy so that growth is sustainable, not overwhelming" |
| **4.** "From insight to action, from alienation to belonging" | `about.md` — "From alienation to deep belonging. From insight to action" |
| **4.** "Built to hand you back to your own town" | `NORTH-STAR.md` §4 telos and §7, persona 4 |

One editorial judgement worth naming: poster 4's hook ("You can name every
crisis. You still can't start the dishes.") is deliberately close to the
bone. It is the gap this user story is *about* — systemic insight alongside
stalled agency — but it is the one line on any of the four that a reader
could take as mockery rather than recognition. It is a one-line change in
`src/poster-4-agency.html` if it reads wrong.

### Handout 1 — the journal

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

### Handout 2 — the Archetypal Wavelength

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

### Handout 3 — the course

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

1. **"Gift economy — pay what you can"** appears in the footer of all seven.
   That framing came from the brief, and the giftability half is pinned by ADR
   0008 — but the pay-what-you-can half depends on the Gumroad listing actually
   being configured for pay-what-you-want pricing. If it isn't, edit the
   `.terms` paragraph in the footer of each `src/*.html` and re-run `./build.sh`.
2. **`aptitude.guru` is the QR target for all seven.** Signup needs a licence
   key, so that page has to explain the offer and lead to purchase. It could not
   be checked from this environment.
