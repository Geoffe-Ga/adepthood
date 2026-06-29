# design-language-01: Promote warm-editorial tokens app-wide + record IP provenance

**Labels:** `frontend`, `design`, `ux`, `priority-high`
**Epic:** [Adopt a warm-editorial design language app-wide](design-language-warm-editorial-epic.md)
**Estimated LoC:** ~180
**Critical path:** every other sub-issue depends on this one.

## Problem

The warm-editorial language is fenced to the journal — `colors.paper`,
`editorialType`, and `paperShadow` are commented *"additive — journal surface
only."* The rest of the app reaches for the flat grey chrome palette
(`colors.background.primary #f8f8f8`, `colors.text.primary #333`, neutral-black
`shadows`). There is no **semantic, app-wide** surface/ink/accent layer that
the whole app can adopt, and there is no in-repo record of where the design
language came from or why it's IP-clean.

## Scope

Add a **semantic token layer** in `frontend/src/design/tokens.ts` that
generalises the journal's paper language into app-wide roles, derive an
**original terracotta accent** from the existing "Candle & Ink" arc (do **not**
introduce Anthropic's exact swatch), and record the design-language provenance
+ IP stance in-repo. No component is restyled here — that's issues 03–05; this
issue only establishes the vocabulary they import.

## Tasks

1. **Add semantic surface/ink/accent tokens** (new exported object, e.g.
   `theme` or `surface`/`ink`/`accent`), built from existing values so the
   journal contracts are untouched:
   - `surface.canvas` (warm app ground — paper-class, replaces `#f8f8f8`),
     `surface.raised` (cards), `surface.sunken`, `surface.hairline`.
   - `ink.primary` / `ink.secondary` / `ink.muted` (warm-neutral text on the
     warm ground; every value must clear WCAG 2.1 AA on `surface.canvas`).
   - `accent.default` / `accent.pressed` / `accent.subtle` — an **original**
     terracotta derived from `colors.tier.clear` (`#be6e46`) family, **not**
     copied from any brand. Confirm `accent` text/icon on `surface.canvas`
     clears AA (≥ 4.5:1 text, ≥ 3:1 graphical SC 1.4.11).
2. **Keep the grey chrome palette as legacy** but stop treating it as the
   default — leave existing `colors.background.*`/`colors.text.*` in place
   (other code still imports them until issues 03–05 migrate), and document
   that new code uses the semantic layer.
3. **Generalise warm elevation:** add an app-level `elevation`/`surfaceShadow`
   derived from `paperShadow` (ink-tinted, warm) for cards/sheets outside the
   journal. Specify iOS/web shadow props **and** Android `elevation`.
4. **Provenance + IP record:**
   - Create `frontend/src/design/DESIGN.md` — a short doc describing
     Adepthood's "Candle & Ink" warm-editorial language (palette roles, type
     intent, elevation, motion principles) as the canonical reference.
   - Add an `ATTRIBUTION` section (in that doc, or `frontend/src/design/ATTRIBUTION.md`)
     recording: inspiration = VoltAgent/awesome-design-md *Claude* entry (MIT,
     reference only); the clean-room stance; "no Anthropic marks / no
     proprietary fonts / original palette"; and a placeholder for the font
     licenses issue 02 will add.

## Acceptance Criteria

- [ ] A semantic `surface`/`ink`/`accent` token layer exists and is exported
      from `tokens.ts`; values are derived from the existing warm palette.
- [ ] New tests assert every `ink.*` and `accent.*` value clears its target
      WCAG ratio on `surface.canvas` (mirror the style of
      `editorialTokens.test.ts`).
- [ ] An app-wide warm `elevation`/`surfaceShadow` exists with both iOS/web and
      Android props, covered by a `StyleSheet.flatten` test.
- [ ] `frontend/src/design/DESIGN.md` documents the language; `ATTRIBUTION`
      records the MIT source + IP stance. **No Anthropic/Claude name or swatch
      is presented as Adepthood's own brand value.**
- [ ] All existing journal token contracts (`colors.paper`, `editorialType`,
      `journalLayout` `toEqual`) remain green — **add** keys, never mutate
      asserted ones.
- [ ] `cd frontend && npm test && npm run lint && npx tsc --noEmit` green;
      `pre-commit run --all-files` green.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/design/tokens.ts` | Modify (add semantic layer + warm elevation) |
| `frontend/src/design/__tests__/tokens.test.ts` | Modify (new contrast/shadow tests) |
| `frontend/src/design/DESIGN.md` | **Create** |
| `frontend/src/design/ATTRIBUTION.md` | **Create** (or fold into DESIGN.md) |
