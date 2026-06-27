# practice-redesign-10: Make sharing real — wire the ShareSheet into the detail screen

**Labels:** `enhancement`, `frontend`, `ritual-practice`
**Epic:** [Practice frontend redesign](practice-redesign-epic.md)
**Depends on:** #05 (detail affordances settled), #07 (visual language).
**Estimated LoC:** ~200

## Problem

`frontend/src/features/Practice/components/ShareSheet.tsx` is fully built — it
mints and revokes share links via the existing `practiceShare` client
("Share this practice" header line 254, generate-link form 281-312, links list
384-429, Copy 349, Revoke 359) — but it is **not imported anywhere**. Sharing is
dead code with no entry point, so "share a practice" is not where a user would
expect it. An end-to-end redesign must make it real and discoverable.

Current state:
- `ShareSheet` has no caller (confirmed by repo grep).
- `PracticeDetailScreen.tsx` action row (lines 313-337) exposes "Use for stage…"
  and "Customize a copy"/"Duplicate & edit" (after #05) but no Share.

## Scope

Add a discoverable **Share** action on the practice detail screen that opens the
existing `ShareSheet`, and give the sheet the #07 minimalist treatment. Reuse the
`practiceShare` client as-is — no backend or API change. If, on inspection, the
share backend is genuinely unavailable on this branch, fall back to **removing**
the dead `ShareSheet` + its test and note it in the PR (do not leave dead code).

## Tasks

1. **Entry point** — add a **Share** action to `PracticeDetailScreen.tsx`'s
   action row that opens `ShareSheet` for the current practice (owner-mintable
   links). Place it as a clearly-labelled, distinct affordance alongside the
   existing actions (consistent with the #05 verb separation).
2. **Minimalist sheet** — apply the #07 visual language to `ShareSheet.tsx`:
   calm header, the generate-link form grouped, the links list with one quiet
   secondary action set (Copy / Revoke). Keep all behaviour and the
   `practiceShare.create` / `practiceShare.revoke` calls.
3. **Decision gate** — verify the `practiceShare` client + endpoints exist on
   this branch. If they do, wire it (primary path). If they do not, delete
   `ShareSheet.tsx` + `components/__tests__/ShareSheet.test.tsx` and document why
   in the PR (no dangling dead code either way).
4. **Tests** — `PracticeDetailScreen.test.tsx`: the Share action opens the sheet.
   Update `components/__tests__/ShareSheet.test.tsx` for the new layout (or remove
   it if the sheet is deleted per the decision gate). Every control keeps
   `accessibilityRole`/`accessibilityLabel`.

## Acceptance Criteria

- [ ] Either: a discoverable Share action on the detail screen opens a redesigned `ShareSheet` that mints/revokes links — OR the dead `ShareSheet` is removed with a documented reason.
- [ ] No dead, unreferenced share code remains after this issue.
- [ ] If wired: spacing/colour/radii come from `design/tokens.ts` and match #07; behaviour and `practiceShare` calls unchanged.
- [ ] `npm test`, `npx tsc --noEmit`, `npm run lint` green; coverage unchanged.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/screens/PracticeDetailScreen.tsx` | Modify |
| `frontend/src/features/Practice/components/ShareSheet.tsx` | Modify (or **Delete** per decision gate) |
| `frontend/src/features/Practice/screens/__tests__/PracticeDetailScreen.test.tsx` | Modify |
| `frontend/src/features/Practice/components/__tests__/ShareSheet.test.tsx` | Modify (or **Delete**) |

## Constraints

- Frontend only. Reuse the existing `practiceShare` client; no backend/API change.
- Do not invent a share backend — if it's absent, take the removal path.
- All design constants from `design/tokens.ts`; tap targets ≥44dp; a11y preserved.
