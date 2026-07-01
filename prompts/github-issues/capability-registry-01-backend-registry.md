# capability-registry-01: Capability descriptor + backend registry

**Labels:** `enhancement`, `architecture`, `backend`, `capability-registry`
**Epic:** [The Capability Registry](capability-registry-epic.md)
**Depends on:** none
**Estimated LoC:** ~250

## Role

You are a FastAPI/SQLModel engineer introducing the seam the rest of the epic
hangs off. You follow the two registry precedents already in the repo:
`botmason.PROVIDER_REGISTRY` (`backend/src/services/botmason.py:99-123`) and the
frontend `store/registry.ts` self-registration pattern.

## Goal

Define a `Capability` descriptor and an in-process `CapabilityRegistry`, then
register the **existing** `habit` and `practice` capabilities into it. No
behaviour changes yet — this issue only stands up the registry and proves the
two current features can describe themselves through it. Later issues route
detection (04), accept (05), nav (06), and MCP (08) through this registry.

## Context

Habits and practices are today addressed by ad-hoc string literals
(`_HABIT_TARGET`, `_PRACTICE_TARGET` in `services/completion_candidates.py:30-31`)
and hand-written accept branches (`routers/journal.py:819-843`). The registry
turns "which targets exist and how do I act on them" into data.

## Tasks

1. **New module `backend/src/domain/capabilities.py`:**
   - `@dataclass(frozen=True) class VerbSpec`: `name: str`, `params_model: type[BaseModel]`
     (a Pydantic model with `extra="forbid"`; use an empty model for verbs with no params).
   - `@dataclass(frozen=True) class Capability`:
     - `key: str` (e.g. `"habit"`, `"practice"`)
     - `label: str`
     - `feature_flag: str | None` (the opt-in key; `None` = always on)
     - `verbs: tuple[VerbSpec, ...]`
     - `candidate_source: str` — dotted reference resolved lazily (avoid import
       cycles), OR accept a callable; keep it a Protocol so 04/05 can inject.
   - `class CapabilityRegistry`: `register(cap)`, `get(key)`, `all()`,
     `verb(key, verb_name)`. Registering a duplicate `key` raises (fail-fast,
     mirrors provider registry). Module-level singleton `REGISTRY`.
2. **Register existing capabilities** in a new
   `backend/src/domain/capability_defs.py` (imported for side effects, like
   `models/__init__.py`): a `habit` capability (`feature_flag="habits"`,
   verb `complete`) and a `practice` capability (`feature_flag="practices"`,
   verb `complete`). Params models are empty for now.
3. **Wire the import** so registration happens at startup: import
   `domain.capability_defs` from the lifespan alongside `import models`
   (`backend/src/main.py:340`).
4. **Guard against drift:** a test that asserts every registered capability
   `key` is a member of `CompletionTargetType` today (so 03/04 can rely on it),
   and that `ALL` registered flags exist in the depth-preference flag set.

## Acceptance Criteria

- [ ] `REGISTRY.get("habit")` / `REGISTRY.get("practice")` return descriptors with the `complete` verb.
- [ ] Duplicate registration raises at import time.
- [ ] No behaviour change: existing detection/accept still use their current code paths (this issue does not rewire them).
- [ ] `pytest backend/` + `pre-commit run --all-files` green; coverage unchanged.

## Files

| File | Action |
|------|--------|
| `backend/src/domain/capabilities.py` | **Create** |
| `backend/src/domain/capability_defs.py` | **Create** |
| `backend/src/main.py` | Modify (import for side effects) |
| `backend/tests/test_capability_registry.py` | **Create** |

## Constraints

- Pure domain module: `capabilities.py` imports no DB/model code (mirror
  `detection.py`/`resonance.py` purity). Capability *defs* may reference enums.
- `params_model` must be `extra="forbid"`; this is the schema the LLM's proposed
  params are validated against in 04.
- Keep the registry synchronous and import-time; no async discovery.
