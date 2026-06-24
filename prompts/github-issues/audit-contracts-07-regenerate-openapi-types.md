# audit-contracts-07: Regenerate or delete stale OpenAPI `types.ts`

**Labels:** `audit-contracts`, `frontend`, `chore`, `priority-medium`
**Epic:** Data-Layer Contracts & Schema Drift
**Estimated LoC:** ~200  (hard cap 700)

## Problem

`frontend/src/api/types.ts` is an `openapi-typescript`-generated file
("Do not make direct changes", `types.ts:1-4`) whose `paths` block knows only a
handful of endpoints — practice-sessions create / week_count and the energy
plan — i.e. roughly **5 of the API's surfaces**, with a `Habit` schema reduced
to a four-field subset. Deprecated exports derive from this stale spec:
`Habit = components['schemas']['Habit']` (`index.ts:826-827`, already marked
`@deprecated`) and the `EnergyPlanRequest` / `EnergyPlanResponse` aliases.
Because the file is frozen-by-comment but never regenerated, those exports
silently describe a contract the backend outgrew. **Current state:** stale
codegen feeding deprecated derived types — §5.4 class: schema drift (audit §7).

## Scope

Covers: either (a) regenerating `types.ts` from the live backend OpenAPI schema
so the generated spec is accurate, **or** (b) deleting the stale derived
exports (`Habit`, `EnergyPlanRequest`, `EnergyPlanResponse`) and migrating their
few consumers to the hand-written `ApiHabit` / energy interfaces in `index.ts`.
Pick whichever the codebase can sustain; (b) is lower-risk if no tooling exists
to keep regen in CI.

Does NOT cover: adding an OpenAPI-drift CI gate (note as a follow-up), or
changing the runtime Zod schemas (issues 01-06).

## Tasks

1. **Inventory consumers** — grep for `components['schemas']`, the deprecated
   `Habit` type, `EnergyPlanRequest`, and `EnergyPlanResponse` across
   `frontend/src`. Confirm whether anything outside `index.ts` still imports
   them.
2. **Choose a path:**
   - **Regenerate** — run `openapi-typescript` against the live schema
     (`backend/src` FastAPI `/openapi.json`) and overwrite `types.ts`; verify
     `tsc --noEmit` passes against the fuller spec. Document the regen command
     in the file header / a script so it stays reproducible.
   - **Delete** — remove the stale derived exports and repoint the (few)
     consumers at `ApiHabit` and the hand-written energy interfaces; drop
     `types.ts` if nothing else references it.
3. **TDD / guard** — if regenerating, add a check (test or script assertion)
   that the generated `Habit` carries the fields `ApiHabit` expects; if
   deleting, a `tsc --noEmit` green run is the gate plus a grep proving the
   deprecated symbols are gone.

## Acceptance Criteria

- [ ] Either `types.ts` is regenerated from the live OpenAPI schema and matches
      the current backend, **or** the deprecated `Habit` /
      `EnergyPlanRequest` / `EnergyPlanResponse` exports are deleted and their
      consumers repointed.
- [ ] No `@deprecated` export in `index.ts` still derives from a stale
      `components['schemas']` entry.
- [ ] `tsc --noEmit` passes; a grep confirms no orphaned references to the
      removed/regenerated symbols.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/api/types.ts` | Regenerate or delete |
| `frontend/src/api/index.ts` | Modify — drop/repoint deprecated derived exports |
| Energy / habit consumers of the deprecated types | Modify — repoint to hand-written interfaces |
</content>
