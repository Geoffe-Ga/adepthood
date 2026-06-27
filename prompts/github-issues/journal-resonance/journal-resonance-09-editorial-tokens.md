# journal-resonance-09: Editorial design tokens + typography

**Labels:** `frontend`, `enhancement`
**Epic:** [Journal Resonance](journal-resonance-epic.md)
**Depends on:** none
**Estimated LoC:** ~150

## Role

You are a React Native engineer extending Adepthood's design tokens to support a
warm, editorial/literary journal surface — without disturbing the rest of the app.

## Goal

Add a `journal` (editorial) token group to `frontend/src/design/tokens.ts`:
serif body typography, a warm "paper" palette, and margin-layout constants the
new writing surface and margin notes will consume. No screens change here — this
issue only ships tokens + a test.

## Context

- `frontend/src/design/tokens.ts` is the single source of truth (`colors`,
  `SPACING`, `radius`, `shadows`, `touchTarget`). Existing journal styling uses
  `colors.background.primary`, `colors.mystical.glowPurple`, etc.
- React Native font families: prefer platform-safe serif stacks (e.g. iOS
  `Georgia`/`Charter`, Android `serif`) selected via `Platform.select`. Do not
  add a custom font-loading dependency in this issue.

## Tasks

1. **Editorial typography** — add to tokens:
   - `typography.serif` (a `Platform.select` serif family) and a scale:
     `display`, `title`, `body`, `note`, `caption` with `fontSize`/`lineHeight`
     tuned for long-form reading (generous line height, ~17–18px body).
   - A `marginNote` text style (smaller, slightly muted, italic-friendly).
2. **Paper palette** — add `colors.paper`: warm off-white background(s), an "ink"
   text color, a faint rule/hairline color, and a soft highlight color for
   anchored spans. Keep within the existing accessibility posture (document
   contrast ratios for text-on-paper meeting WCAG AA).
3. **Layout constants** — add `journalLayout`: `marginColumnWidth`,
   `pageHorizontalPadding`, `pageMaxWidth` (tablet), and a `marginNoteGap`.
   These are referenced by issues 11 and 14.
4. **Kind accents** — add `colors.marginalia` mapping each kind to a subtle
   accent: `theme`, `connection`, `symbol` (used for the note's pin/label).
5. **Tests** — `frontend/src/design/__tests__/editorialTokens.test.ts`:
   - The new token groups exist with the expected keys.
   - Serif family resolves to a non-empty string on both platforms.
   - Paper text-on-background contrast meets AA (assert documented ratios via a
     small contrast helper or hardcoded expected values).

## Acceptance Criteria

- [ ] `tokens.ts` exports `typography` (serif scale), `colors.paper`,
      `colors.marginalia`, and `journalLayout`.
- [ ] No existing token is renamed or removed; nothing outside the journal feature
      changes visually.
- [ ] `npm run lint`, `npx tsc --noEmit`, `npm test` all green.

## Files to Create / Modify

| File | Action |
|------|--------|
| `frontend/src/design/tokens.ts` | Modify |
| `frontend/src/design/__tests__/editorialTokens.test.ts` | **Create** |

## Constraints

- Tokens only — no component or screen edits.
- No new font/asset dependency; use platform serif stacks.
- Preserve the existing token API; additive only.
