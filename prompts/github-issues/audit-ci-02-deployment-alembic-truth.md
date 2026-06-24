# audit-ci-02: Rewrite the false Alembic section in DEPLOYMENT.md

**Labels:** `audit-ci`, `ci`, `docs`, `priority-high`
**Epic:** CI, Infra & Docs Truth
**Estimated LoC:** ~70  (hard cap 700)

## Problem

`DEPLOYMENT.md:271-326` ("Database Migrations (Alembic)") tells an operator that
"Alembic is **not yet configured**. The `migrations/` directory exists but is empty"
and then walks them through `alembic init migrations`, hand-editing `env.py`, and — as a
fallback — adding a `SQLModel.metadata.create_all()` startup hook. **All of this is
false and dangerous.** `backend/alembic.ini` exists, `backend/migrations/versions/`
holds 35 migration files, and `backend-ci.yml` (the `migration-drift` job, lines
148-192) gates every push on `alembic upgrade head`, a downgrade/re-upgrade round-trip
through both merge parents, and `alembic check` for model/migration drift. An operator
following the current text would run `alembic init` over a configured tree or bolt on
`create_all()`, clobbering the real setup and bypassing the drift gate.

**Current state:** docs drift (dangerous). High per audit §9 (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:144`).

## Scope

**Covers:** Rewriting the `## Database Migrations (Alembic)` section (`DEPLOYMENT.md:269-327`)
to describe the real, env-driven setup and the CI guarantees around it.

**Does NOT:** Change any Alembic config, `env.py`, migrations, the Dockerfile, or
`backend-ci.yml`. This is a docs-only change describing the system as it already is.

## Tasks

1. **Delete the "not yet configured" framing and the `alembic init` / `create_all()` instructions** in `DEPLOYMENT.md:271-326`. Remove the "Before Alembic is set up" subsection entirely — there is no such state.
2. **Document the real setup** — `backend/alembic.ini` is present; `backend/migrations/versions/` contains the migration history; `migrations/env.py` reads `DATABASE_URL` from the environment and normalises the asyncpg scheme (cross-reference the behaviour described in `backend-ci.yml:128-130`). Verify these details against the live files before writing.
3. **Document the autogenerate + apply flow** — `alembic revision --autogenerate -m "<msg>"` to create a migration; `alembic upgrade head` to apply; `railway run alembic upgrade head` for a manual prod apply. Keep the existing accurate detail that the Dockerfile runs `alembic upgrade head` on deploy.
4. **Reference the CI safety net** — note that the `migration-drift` CI job (`backend-ci.yml`) runs `alembic upgrade head`, a downgrade/re-upgrade round-trip through both merge parents, and `alembic check`, so a model added without a matching migration fails CI. This tells operators the gate exists and not to hand-edit migrations.

## Acceptance Criteria

- [ ] `DEPLOYMENT.md` no longer contains the strings `not yet configured`, `alembic init`, or `metadata.create_all` in the migrations section — grep clean.
- [ ] The section states `alembic.ini` and the `migrations/versions/` history already exist, and describes the env-driven `DATABASE_URL` configuration.
- [ ] The section references the `migration-drift` CI gate and the `alembic check` drift guard.
- [ ] No existing tests break; coverage ≥ 90% where applicable.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `DEPLOYMENT.md` | Modify (rewrite lines 269-327) |
