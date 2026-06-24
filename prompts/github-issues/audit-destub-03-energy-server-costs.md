# audit-destub-03: Load energy costs server-side (close BUG-PRACTICE-010)

**Labels:** `audit-destub`, `backend`, `authz`, `priority-high`
**Epic:** De-Stub: Make Aspirational Features Real
**Estimated LoC:** ~300  (hard cap 700)

## Problem
`backend/src/routers/energy.py:34-45` documents (in its own docstring) that the energy planner is
still **steered by client-supplied** `energy_cost` / `energy_return` per habit: an authenticated
user can POST any habit id with arbitrary costs and bias the resulting plan. `services/energy.py`
feeds `payload.habits` straight into `domain.energy.generate_plan` with no server-side lookup.
**Current state:** §5.1 class **fake** / authz gap (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md` §6, row 3;
§2 item 10) — the open remainder of **BUG-PRACTICE-010**. The planner is **supposed to be real for
ship**, so the trusted inputs must come from the server, not the client.

## Scope
**Covers:** loading `energy_cost` / `energy_return` for each requested habit from the `Habit` rows
**owned by `current_user`**, rejecting or ignoring any client-sent costs, and returning a clear
error when a requested habit id is not owned by the caller. **Does NOT cover:** persisting the
resulting plan (that is `audit-destub-04`, which depends on this issue) or the CPU-offload
behaviour (already handled via `asyncio.to_thread`).

## Tasks
1. **Thread the session in** — pass an `AsyncSession` (and `current_user`) from `routers/energy.py`
   into `services.energy.get_or_generate_plan` so the service can look up habits server-side.
2. **Load trusted costs** — in `services/energy.py`, fetch the requested habit ids scoped to
   `user_id`, and build the `domain.energy.Habit` list from the **stored** `energy_cost` /
   `energy_return`, ignoring any costs present in the request payload. Reject a request that
   references a habit id the user does not own (404→403 split per `dependencies/ownership.py`
   convention). TDD: a test that submits a **forged** client `energy_cost`/`energy_return` and
   asserts the generated plan reflects the **stored** habit values, not the forged ones.
3. **Tighten the request schema** — make `energy_cost` / `energy_return` optional/ignored on the
   request DTO (or drop them) so the contract no longer advertises a client-controllable cost.
   TDD: a test that a payload omitting costs still produces a plan, and one that supplies costs has
   them ignored.
4. **Update the docstring** — remove the `.. warning::` block in `routers/energy.py` once the
   remainder of BUG-PRACTICE-010 is closed.

## Acceptance Criteria
- [ ] The planner derives `energy_cost`/`energy_return` solely from `Habit` rows owned by
      `current_user`; client-sent values are ignored.
- [ ] A forged client cost does not change the generated plan (covered by a regression test).
- [ ] A request referencing a habit not owned by the caller returns 403/404, not a plan.
- [ ] The BUG-PRACTICE-010 warning docstring is removed.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on --all-files.

## Files to Create/Modify
| File | Action |
|------|--------|
| `backend/src/routers/energy.py` | Modify (thread session/user; drop warning) |
| `backend/src/services/energy.py` | Modify (load costs from owned habits, ignore client costs) |
| `backend/src/schemas/energy.py` (or equivalent) | Modify (make costs optional/ignored) |
| `backend/tests/services/test_energy.py` | Modify (forged-cost-ignored + ownership tests) |
| `backend/tests/routers/test_energy.py` | Modify (403/404 ownership path) |
