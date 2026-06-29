# Epic: Adopt a warm-editorial design language app-wide ("Candle & Ink")

**Labels:** `epic`, `frontend`, `ux`, `design`
**Scope:** Frontend only (shared design tokens + app-wide chrome)
**Estimated total LoC:** ~900

## Why this, and why now

We surveyed [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md)
— an MIT-licensed catalogue of ~70 `DESIGN.md` files, each a plain-text
description of the publicly observable design language of a well-known product
(Claude, Notion, Linear, Stripe, Airbnb, Spotify, …). The task was to pick the
**one** whose design language best fits Adepthood, confirm we can adopt it
without infringing anyone's IP, and task up the implementation.

### First principles: what is Adepthood, and what should it feel like?

Adepthood is **not** a SaaS dashboard, a fintech app, or a developer tool. It
is a **36-week inner-development program** — habit-building, meditative
practice, long-form journaling with an AI companion (BotMason), and
stage-gated course content whose stages (Beige → Purple → … → Clear Light)
are drawn from developmental/integral psychology. The emotional job of the
interface is to make a person feel **calm, held, and serious about their own
growth** — closer to a well-made personal journal or a contemplative reader
than to a productivity tool. The right vibe is:

- **Warm, not clinical** — paper and ink, candlelight, earth tones; not cold
  grey chrome or neon-on-black.
- **Editorial, not dashboard** — generous whitespace, a comfortable reading
  measure, serif display type for gravitas, calm rhythm. Content is to be
  *read and dwelt on*, not scanned.
- **Quietly mystical / initiatory** — a thread of the numinous (the stage
  arc, the Map spiral, the `mystical` glow tokens) without tipping into kitsch.
- **AI-companion-native** — BotMason is a central, conversational presence, so
  the language should be one that reads well for an assistant that talks with
  you.

### The pick: **Claude** (warm terracotta + clean editorial layout)

Of the catalogue, the **Claude** `DESIGN.md` is the closest match on every
axis above: a warm terracotta accent over a paper-like ground, clean editorial
layout, restrained type, and — uniquely among the entries — a language
purpose-built for a *conversational AI assistant*, which is exactly BotMason's
role. Runners-up (Notion's warm-serif minimalism; Airbnb's warm rounded
coral) fit the warmth but read as "workspace" / "marketplace" rather than
"contemplative companion."

Decisively, **Adepthood already independently arrived at this aesthetic** — but
only in one corner of the app. The journal surface has a fully realised
"paper" language: `colors.paper` (`#faf6ef` ground, `#2b2620` ink), the
"Candle & Ink" terracotta goal-tier arc (`#b08d40 → #be6e46 → #8c3b2e`),
`editorialType` (serif scale), `paperShadow` (warm ink-tinted elevation), and
marginalia. Everything else — Habits, Practice, Course, Map, Auth — still
wears generic grey app-chrome (`colors.background.primary #f8f8f8`,
`text.primary #333`, system sans, neutral-black `shadows`). **This epic
promotes the warm-editorial language from "journal surface only" to the
app-wide design language.** We are not bolting on a foreign theme; we are
finishing one the codebase already started.

## IP / licensing analysis (read before implementing)

The user's explicit constraint was: *pick one and make sure we aren't
infringing IP.* Here is the cleared position. **Treat the Claude `DESIGN.md`
as inspiration for a design *language*, and build an original, clean-room
Adepthood token system — never a clone of Anthropic's brand.**

**What we may safely use**

- **The `DESIGN.md` document itself** is MIT-licensed — free to read, quote,
  and adapt the text. (Keep the attribution note required below.)
- **Ideas, layout patterns, and functional design conventions** — "warm
  editorial," generous whitespace, a serif-display + clean-sans pairing,
  type-scale *ratios*, spacing scales. Ideas and functional/utilitarian design
  are not protectable by copyright; individual color values and numeric scales
  are facts, not creative works.

**What we must NOT do (the real risks)**

1. **Trademark / trade dress.** Do **not** use Anthropic's or Claude's name,
   logo, or copy the *total* look-and-feel so closely that Adepthood could be
   mistaken for, or seem affiliated with, Claude. Trade dress protects the
   overall visual impression — so we deliberately keep Adepthood's own
   distinct identity (its name, the stage arc, the Map spiral, the
   mystical/initiatory motif, our own palette).
2. **Proprietary fonts.** Anthropic's site ships **commercial, licensed
   typefaces** (e.g. Styrene / Tiempos-class faces). We must **never** bundle,
   self-host, or embed those font *files*. (Naming a font in a CSS
   `font-family` fallback stack is fine; shipping the file is not.) Adepthood
   uses **only OFL/Apache-licensed or platform-system fonts** — see issue 02.
3. **Brand assets.** No Anthropic/Claude logos, icons, illustrations, or
   copyrighted imagery, anywhere.
4. **Exact signature color as our identity.** A single hex isn't protectable,
   but adopting Anthropic's *exact* signature terracotta as our primary brand
   color *together with* their fonts and layout would drift toward trade-dress
   imitation. We don't need to: Adepthood **already owns** an original warm
   palette (the "Candle & Ink" arc + `colors.paper`), and this epic builds on
   *that*, not on Anthropic's swatches.

**Net:** the adoption is clean because (a) the source document is MIT, (b) we
take only uncopyrightable ideas/conventions, (c) we use exclusively
free/system fonts, and (d) the concrete tokens, palette, and overall identity
are Adepthood's own. Issue 01 records this provenance in-repo
(`frontend/src/design/DESIGN.md` + an `ATTRIBUTION` note) so the decision is
auditable.

## Role

You are a senior React Native / front-end engineer with a strong visual design
sense, working inside Adepthood's existing **editorial / "paper"** design
language (`colors.paper.*`, `editorialType`, `paperShadow`, `journalLayout` in
`frontend/src/design/tokens.ts`). You make surfaces beautiful **through the
token system** — never with one-off magic numbers (CLAUDE.md guardrail) — and
you treat accessibility (WCAG 2.1 AA contrast, 44dp touch targets,
reduced-motion) as a non-negotiable part of "beautiful."

## Goal

After this epic ships, **every** primary surface — Habits, Practice, Course,
Map, Auth, and the journal — reads as one cohesive, warm, editorial space:
paper-like grounds instead of flat grey, an original terracotta accent, a
serif-display + clean-sans type system on free fonts, soft warm elevation, and
a matching warm dark mode. Zero behavioural regressions, zero contrast
regressions, all design values flowing from `tokens.ts`.

### What the app looks like today (the problem)

The warm-editorial language is explicitly fenced to the journal — the tokens
file labels it *"additive — journal surface only."* The rest of the app uses:

- `colors.background.primary` `#f8f8f8` / `colors.background.card` `#ffffff`
  flat grey grounds with no warmth and no paper feel.
- `colors.text.*` neutral greys on neutral white.
- system sans everywhere (no editorial serif outside the journal).
- `shadows` — neutral pure-black, tuned for grey chrome, not warm paper.

The result is a two-personality app: a beautiful, intentional journal sitting
inside an otherwise generic grey shell.

## Context — the raw materials already exist

| Token | Where | Reuse |
|-------|-------|-------|
| `colors.paper` (ground/ink/hairline) | `tokens.ts:131-145` | Generalise from journal-only → app surface tokens |
| `colors.tier` "Candle & Ink" arc | `tokens.ts:63-70` | Source of the original terracotta accent |
| `editorialType` (serif scale) | `tokens.ts:447-461` | Base of the app-wide type ramp |
| `paperShadow` (warm elevation) | `tokens.ts:482-497` | Generalise into app elevation |
| `darkColors` (neutral dark) | `tokens.ts:356-374` | Re-tone warm for dark mode (issue 06) |
| `touchTarget`, `breakpoints`, `spacing`, `radius` | `tokens.ts` | Unchanged — already shared |

**Source of inspiration (reference only):**
[awesome-design-md / Claude](https://github.com/VoltAgent/awesome-design-md)
(MIT). Used for design-language ideas only — see the IP analysis above.

## Output Format

Six independently-shippable sub-issues. **Issue 01 (tokens + provenance) is
the critical path** — every other issue consumes the semantic surface/ink/
accent tokens and the IP/attribution record it adds. After 01 lands, 02–05 can
proceed in parallel; 06 (dark mode) lands last because it re-tones the palette
01–05 establish.

```
                 ┌── 03 buttons-controls-inputs ──┐
                 │                                 │
01 tokens + ─────┼── 04 cards-surfaces-elevation ──┼── 06 warm-dark-mode
   provenance    │                                 │
   (+ 02 fonts)  ├── 05 navigation-headers-tabbar ─┤
                 │                                 │
                 └─────────────────────────────────┘
   02 typography-&-fonts depends on 01; 03/04/05 depend on 01 (+ 02 for type)
```

## Sub-issues

| # | Title | Scope | Est. LoC |
|---|-------|-------|----------|
| 01 | [Promote warm-editorial tokens app-wide + record IP provenance](design-language-01-tokens-and-provenance.md) | Frontend | ~180 |
| 02 | [Editorial type system on free/system fonts (no proprietary fonts)](design-language-02-typography-and-fonts.md) | Frontend | ~160 |
| 03 | [Restyle shared buttons, controls & inputs](design-language-03-buttons-controls-inputs.md) | Frontend | ~150 |
| 04 | [Warm grounds & soft elevation for cards/surfaces](design-language-04-cards-surfaces-elevation.md) | Frontend | ~150 |
| 05 | [Editorial navigation: headers & bottom tab bar](design-language-05-navigation-headers-tabbar.md) | Frontend | ~120 |
| 06 | [Warm dark mode to match the light language](design-language-06-warm-dark-mode.md) | Frontend | ~140 |

## Acceptance Criteria (epic-level)

- [ ] Habits, Practice, Course, Map, and Auth all read on **warm paper-like
      grounds** with the original terracotta accent — no flat `#f8f8f8` grey
      chrome remains on primary surfaces.
- [ ] An **editorial type system** (serif display + clean sans body) is used
      app-wide, loaded from **OFL/Apache or platform-system fonts only** —
      **no proprietary font files are bundled** (verifiable in the repo).
- [ ] `frontend/src/design/DESIGN.md` documents the Adepthood design language,
      and an `ATTRIBUTION` note records the MIT source + the clean-room/IP
      stance. **No Anthropic/Claude name, logo, or asset ships in the app.**
- [ ] A matching **warm dark mode** exists (warm-toned, not neutral `#121212`).
- [ ] **No regressions:** every existing test passes; all testIDs preserved;
      the journal's `colors.paper`/`editorialType`/contrast contracts stay green.
- [ ] **No contrast regressions:** all text keeps WCAG 2.1 AA (≥ 4.5:1) on its
      ground; existing token-contrast tests stay green and new tokens add tests.
- [ ] All styling flows from `tokens.ts` — no inline hex / bare pixel constants.
- [ ] `cd frontend && npm test && npm run lint && npx tsc --noEmit` green;
      backend untouched; `pre-commit run --all-files` green on each PR.

## Constraints

- **Tokens only.** Every colour, radius, shadow, font, and spacing value comes
  from `tokens.ts`. No inline hex, no bare pixel constants in components.
- **Clean-room / IP-safe.** Inspiration from the Claude `DESIGN.md` (MIT) is
  fine; **no Anthropic marks, no proprietary fonts, no exact-brand cloning.**
  Build on Adepthood's own "Candle & Ink" + `colors.paper` palette.
- **Free fonts only** — OFL/Apache-licensed or platform-system. Document each
  font's license in `ATTRIBUTION`.
- **Preserve every testID and behavioural contract.** This is a re-skin, not a
  re-architecture; no screen logic or navigation behaviour changes.
- **Accessibility is part of the deliverable:** AA contrast, 44dp touch
  targets (`touchTarget.minimum`), and `prefers-reduced-motion` honoured.
- **React Native shadow portability:** specify both iOS/web shadow props and
  Android `elevation`; assert via `StyleSheet.flatten` in tests.
- **TDD:** write/extend the failing test first, then implement. Keep coverage
  at or above repo thresholds (90% line / 80% branch).
- One logical change per PR; conventional commits
  (`feat(frontend): …`, `style(frontend): …`, `test(frontend): …`).

## References

- `frontend/src/design/tokens.ts` — single source of truth for design tokens
- `frontend/src/design/tokens.ts:131-145` — `colors.paper` (journal-only today)
- `frontend/src/design/tokens.ts:63-70` — `colors.tier` "Candle & Ink" arc
- `frontend/src/design/tokens.ts:447-461` — `editorialType` serif scale
- `frontend/src/design/tokens.ts:482-497` — `paperShadow` warm elevation
- `frontend/src/design/tokens.ts:356-374` — `darkColors` (neutral; to re-tone)
- `frontend/src/design/__tests__/tokens.test.ts`,
  `frontend/src/design/__tests__/editorialTokens.test.ts` — token contracts
- `prompts/github-issues/phase-2-05-unify-design-constants.md` — prior token
  consolidation (the foundation this builds on)
- `prompts/github-issues/journal-depth-epic.md` — the editorial language this
  epic generalises from the journal to the whole app
- Inspiration (MIT, reference only):
  https://github.com/VoltAgent/awesome-design-md
