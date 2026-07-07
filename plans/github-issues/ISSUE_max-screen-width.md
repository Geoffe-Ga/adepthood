## Role

You are a senior React Native engineer working in the adepthood codebase,
following its existing conventions (TDD via `stay-green`, `check-all.sh`
gates, ≥90% Jest coverage, zero lint/type suppressions, Candle & Ink design
tokens).

## Goal

Introduce a single, shared "max usable content width" for large screens and
apply it universally across every tab (Today/Journal, Habits, Practice,
Course, Map, Settings), instead of each screen's content stretching edge-to-
edge and looking distended on tablets/desktop/web. Use the Journal screen's
existing floating writing sheet as the reference width — it is already
"about the right width" per the owner.

## Context

- The Journal writing surface already floats a centered "paper sheet" over a
  deeper "desk" background, capped at a comfortable reading width:
  `frontend/src/design/tokens.ts:418-423` (`journalLayout`) —
  `pageMaxWidth: 680` + `marginColumnWidth: 220` (sheet cap is
  `pageMaxWidth + marginColumnWidth` = 900, applied in
  `frontend/src/features/Journal/JournalEntry.styles.ts:45`). This
  desk/sheet pattern (from the `journal-depth` epic, see
  `prompts/github-issues/journal-depth-02-floating-writing-sheet.md`) is the
  visual reference the owner is pointing at — not necessarily the exact
  pixel value, which may need its own token once shared app-wide.
- No other screen currently caps its content width — Habits, Practice,
  Course, and Map all appear to render full window width, which reads as
  "stretched" on larger viewports (tablet landscape, browser/web,
  foldables).
- `frontend/src/design/useResponsive.ts` and `frontend/src/design/tokens.ts`
  (`breakpoints`) already give per-breakpoint scale (`xs`/`sm`/`md`/`lg`/
  `xl`) and are the natural home for a new shared `contentMaxWidth`-style
  token, rather than duplicating the Journal's `journalLayout` constant.
- **Map screen — handle with extra care, it has two known large-screen
  regressions already reproducible today:**
  1. **Forced hyphenation on "Understanding".** The right-column aspect
     label is pre-hyphenated as a hardcoded literal in
     `frontend/src/features/Map/mapLayout.ts:207`:
     `{ rightLabel: 'Understanding', rightLabelLines: ['Under-', 'standing'], stageNumbers: [6, 5] }`.
     Per the file's own doc comment (`mapLayout.ts:51`, "Pre-hyphenated
     right-column label lines (<= 2), avoiding shrink-to-fit"), this was a
     deliberate narrow-column workaround — but it forces the hyphen break
     even when the column is wide enough (big screens) for "Understanding"
     to fit on one line. Compare the neighboring un-split labels in the
     same `MAP_ROWS` array (`'Awareness'`, `'Wisdom'`, `'Love'`) —
     `Understanding` and `Yes-And-Ness` are the only two forced to wrap,
     and only `Understanding`'s wrap point is an invented hyphen rather
     than a natural word break.
  2. **Unwanted line-break inside "Awareness" on Android.** The owner
     reports "Awareness" (a single un-split `rightLabelLines: ['Awareness']`
     entry, `mapLayout.ts:204`) wraps mid-word on an Android phone despite
     not being pre-split — likely a text-shrink/column-width or
     `flexWrap`/font-scaling interaction specific to the Android renderer.
     Needs on-device (or Android emulator) verification, not just iOS/web.
  3. `GRID_COLUMN_FLEX` (`mapLayout.ts:21`) and `fittedTitleFontSize`
     (`mapLayout.ts:84-89`) size Map's columns/title relative to *measured
     cell width* — introducing a max content width on Map changes that
     measured width, so these must be re-validated (not just the two
     labels above) once Map's container width is capped.

## Problem Statement

The owner reviewed the app on a larger screen and found every screen except
Journal stretches its content to the full viewport width, which looks wrong
compared to Journal's floating, width-capped writing sheet. Fixing this
requires a shared, reusable max-width treatment (not a per-screen hack) so
new screens don't regress it, plus special care on Map, which already has
two live text-wrapping bugs that a naive width change could worsen or mask:
a hardcoded hyphen break on "Understanding" that shouldn't apply once there
is room to fit the whole word, and a spurious Android-only mid-word break on
"Awareness" that needs its own root-cause fix independent of the width work.

## What to build

1. Add a shared max-content-width token (e.g. `contentMaxWidth` or similar,
   named consistently with existing `journalLayout`/`breakpoints` patterns)
   to `frontend/src/design/tokens.ts`, sized off the Journal sheet's
   existing width so the visual language matches what the owner approved.
2. Apply it as a centered, capped container on every top-level screen
   (Today/Journal home, Habits, Practice, Course, Map, Settings) so content
   never stretches edge-to-edge on wide viewports, while remaining
   full-width (no visible cap) on phone-sized screens — reuse
   `useResponsive`'s breakpoints rather than a new ad hoc mechanism.
3. On Map specifically:
   - Re-derive `Understanding`'s `rightLabelLines` so it only breaks when
     the *actual measured column width* requires it, instead of being
     permanently pre-hyphenated — consistent with how `fittedTitleFontSize`
     already measures real layout width for the title watermark. If a
     static two-line fallback is still needed for narrow phones, make the
     break a natural word wrap, not an inserted hyphen, unless the width
     genuinely can't fit "Understanding" as one word.
   - Root-cause and fix the Android-only mid-word break inside "Awareness"
     (verify on an Android emulator/device) — likely a `flexShrink`/
     `numberOfLines`/font-scaling gap in the Map label rendering rather
     than the `rightLabelLines` data itself, since `Awareness` is not
     pre-split.
   - Re-validate `GRID_COLUMN_FLEX` and `fittedTitleFontSize` sizing against
     the new capped container width across breakpoints (phone, tablet,
     wide/web).

## Acceptance Criteria

- [ ] A single shared max-content-width token exists in
      `frontend/src/design/tokens.ts` and is documented (short comment,
      consistent with the existing `journalLayout` doc comment style).
- [ ] Today/Journal, Habits, Practice, Course, Map, and Settings all cap
      their content to that shared width and center it on viewports wider
      than the cap; on phone-width viewports content still fills the
      screen as it does today (no regression at small breakpoints).
- [ ] On a wide/tablet/web viewport, the Map's "Understanding" label renders
      on one line (no forced hyphen) when the column is wide enough to fit
      it; a narrow-viewport fallback wrap (if still needed) does not use an
      inserted hyphen.
- [ ] On Android, "Awareness" no longer breaks mid-word at any tested
      viewport width (verified on an Android emulator/device, not only
      iOS/web).
- [ ] `GRID_COLUMN_FLEX`-driven column proportions and
      `fittedTitleFontSize`'s title sizing still look correct (no
      truncation, no oversized/undersized watermark) at the new capped
      width across `xs`–`xl` breakpoints.
- [ ] `./scripts/frontend/check-all.sh` green; coverage thresholds
      unchanged; no new `# type: ignore`/`@ts-ignore`/lint suppressions.

## Constraints

- Introduce the max-width as one shared, reusable token/component — not a
  per-screen magic number copy-pasted six times.
- Do not change Journal's own sheet width/behavior in this issue (it is
  already correct) — only reuse it as the reference for the new shared
  token.
- Map's two text-wrapping bugs are functionally independent of each other
  (one is a hardcoded data literal, the other is Android-only rendering
  behavior) — fix both, but do not conflate their root causes or apply one
  fix to paper over the other.
- Conventional commits; one logical change per PR if this is split into
  sub-issues (token/shared container as one PR, Map fixes as another, is an
  acceptable split given the distinct risk profile called out above).
