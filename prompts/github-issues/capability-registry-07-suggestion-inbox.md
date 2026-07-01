# capability-registry-07: Capability-agnostic suggestion inbox UI

**Labels:** `enhancement`, `frontend`, `capability-registry`
**Epic:** [The Capability Registry](capability-registry-epic.md)
**Depends on:** 03, 05, 06
**Estimated LoC:** ~250

## Role

You are a React Native engineer generalizing the journal's completion-suggestion
surface into a capability-agnostic **proposals inbox**: the place where every
"you wrote about doing X — log it?" moment lands, regardless of which feature X
belongs to.

## Goal

Render any `ActionSuggestion` (03) with its anchored quote, capability label, and
verb, and wire Accept/Dismiss to the generic endpoints (05). The habit and
practice suggestions that render today keep rendering — now through this generic
component — and new capabilities (e.g. a wheel/wavelength note) appear with no UI
changes.

## Context

The current UI reads completion suggestions per entry and calls the
completion-specific accept route. With 03/05 the data + endpoints are generic;
this issue makes the presentation generic too, driven by the frontend manifest
(06) for per-capability label/icon.

## Tasks

1. **API client:** add a `suggestions` client (list for an entry, accept,
   dismiss) against the generic endpoints, with Zod schemas mirroring
   `ActionSuggestion` (`frontend/src/api/schemas.ts` + `index.ts`). Keep the
   existing completion-suggestion client working as a thin wrapper for one release.
2. **Component `features/Journal/components/SuggestionInbox.tsx`:** renders a list
   of proposals; each row shows the anchored `anchor_text`, the capability's
   `title`/`icon` (looked up from the manifest by `capability_key`), a
   human verb label, and Accept/Dismiss. Optimistic dismiss; accept shows the
   handler's result (e.g. "streak 4"). Empty state is quiet (no nagging), per the
   invitation ethos.
3. **Integrate** into the journal entry view where completion suggestions render
   today, replacing the completion-specific list.
4. **Verb-label map** derived from the manifest/capability metadata so a new verb
   renders a sensible label without a code change (fallback to the raw verb).
5. **Tests:** renders a habit `complete` and a `wheel` `note` proposal from one
   list; accept calls the generic endpoint and reflects the result; dismiss
   removes the row and is not re-shown.

## Acceptance Criteria

- [ ] One inbox renders proposals for any capability; habit/practice proposals look and behave as before.
- [ ] A new capability's proposals render with label/icon from the manifest, no inbox edits.
- [ ] Accept/Dismiss hit the generic endpoints; dismissed proposals never reappear.
- [ ] Empty/quiet state honours "default to quiet" — no pressure copy.
- [ ] `cd frontend && npm test && npm run lint && npx tsc --noEmit` green.

## Files

| File | Action |
|------|--------|
| `frontend/src/api/index.ts` | Modify (suggestions client) |
| `frontend/src/api/schemas.ts` | Modify (ActionSuggestion zod) |
| `frontend/src/features/Journal/components/SuggestionInbox.tsx` | **Create** |
| `frontend/src/features/Journal/...` | Modify (integrate) |
| `frontend/src/features/Journal/__tests__/SuggestionInbox.test.tsx` | **Create** |

## Constraints

- No `any`; Zod-validate every response (repo convention).
- Presentation is data-driven from the manifest — no per-capability `switch` in the inbox.
- Preserve the anchor-highlight UX that completion suggestions have today.
