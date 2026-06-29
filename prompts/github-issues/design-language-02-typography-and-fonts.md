# design-language-02: Editorial type system on free/system fonts (no proprietary fonts)

**Labels:** `frontend`, `design`, `ux`, `priority-high`
**Epic:** [Adopt a warm-editorial design language app-wide](design-language-warm-editorial-epic.md)
**Estimated LoC:** ~160
**Depends on:** 01 (semantic tokens).

## Problem

Editorial serif type (`editorialType`) is used only on the journal surface. The
rest of the app uses the bare system sans via the responsive `typography(width)`
helper with no display face and no deliberate ramp. We want a cohesive
**serif-display + clean-sans-body** system app-wide — without shipping any
**proprietary** font (Anthropic's site uses commercial faces we may not embed).

## IP constraint (the point of this issue)

- **No proprietary or commercial font files may be bundled, self-hosted, or
  embedded.** Use **only**:
  - **Platform-system fonts** (zero files: Georgia/serif already used; SF/Roboto
    for sans), **and/or**
  - **OFL/Apache-licensed** open fonts if a bundled face is wanted — e.g.
    editorial serif: *Newsreader*, *Source Serif 4*, *Lora*, or *Spectral*
    (all OFL); sans: *Inter* (OFL). Pick **one** serif + at most one sans.
- For any bundled font, add the font's **license file** under the assets dir and
  record it in `frontend/src/design/ATTRIBUTION.md` (created in issue 01).
- Naming a commercial face in a CSS fallback stack is **not** permitted as a
  way to pull it from the user's machine for brand parity — keep stacks to
  free/system faces only.

## Scope

Define an app-wide editorial type ramp in tokens, wire font loading (if a
bundled face is chosen), and expose ramp roles the chrome issues (03–05) and
screens consume. Keep the journal's `editorialType` intact (it may re-export
from the new ramp, but its asserted keys must not change).

## Tasks

1. **Decide the font strategy** and record it in `DESIGN.md`:
   - Default recommendation: **system serif (Georgia/serif) for display +
     system sans for body** — zero bundled files, zero license risk. Only add a
     bundled OFL face if the design needs a specific display character.
2. **Add an app type ramp** to `tokens.ts` (e.g. `type.display`, `type.title`,
   `type.heading`, `type.body`, `type.label`, `type.caption`) with family,
   size, line-height, weight, letter-spacing — serif for display/headings,
   sans for body/labels. Keep it responsive-aware (compose with `breakpoints`).
3. **If bundling an OFL face:** add the font under the Expo assets dir, load via
   `expo-font` / `useFonts`, add the `.ttf`/`.otf` **and its OFL license** to
   the repo, and gate first render on load (with a system fallback).
4. **Re-base `editorialType`** to draw from the shared serif so the journal and
   the app share one face — without changing `editorialType`'s exported keys
   (preserve `editorialTokens.test.ts`).
5. **Document** every font + license in `ATTRIBUTION.md`.

## Acceptance Criteria

- [ ] An app-wide editorial type ramp exists in `tokens.ts` and is consumed by
      headings/body across the app (chrome issues import it).
- [ ] **No proprietary font files** are in the repo; any bundled face is OFL/
      Apache with its license committed and listed in `ATTRIBUTION.md`.
- [ ] If a face is bundled, it loads via `expo-font` with a graceful system
      fallback; no flash-of-unstyled-crash if loading fails.
- [ ] The journal's `editorialType` keys are unchanged; `editorialTokens.test.ts`
      stays green.
- [ ] Type sizes keep AA legibility; touch targets unaffected.
- [ ] `cd frontend && npm test && npm run lint && npx tsc --noEmit` green;
      `pre-commit run --all-files` green.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/design/tokens.ts` | Modify (app type ramp; re-base editorialType) |
| `frontend/src/design/__tests__/tokens.test.ts` | Modify (ramp tests) |
| `frontend/src/design/DESIGN.md` / `ATTRIBUTION.md` | Modify (font strategy + licenses) |
| `frontend/assets/fonts/*` + license | **Create** (only if bundling an OFL face) |
| `frontend/src/App.tsx` | Modify (font loading gate — only if bundling) |
