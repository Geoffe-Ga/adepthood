# scripts/

Quality-gate shell scripts ported from
[`adepthood-linters`](https://github.com/Geoffe-Ga/adepthood-linters). The
original scripts assume a flat repo; these have been adapted for the
`backend/` + `frontend/` monorepo layout.

## Layout

```
scripts/
├── backend/           # Python quality gates — runs against backend/
│   ├── check-all.sh   # Run lint + format + typecheck + security + complexity + tests
│   ├── fix-all.sh     # Auto-fix linting and formatting
│   ├── lint.sh        # ruff
│   ├── format.sh      # black + isort
│   ├── typecheck.sh   # mypy
│   ├── test.sh        # pytest (--unit / --integration / --e2e / --all)
│   ├── coverage.sh    # pytest with coverage (≥90%)
│   ├── security.sh    # bandit + pip-audit
│   ├── complexity.sh  # radon + xenon
│   ├── mutation.sh    # mutmut (≥80% mutation score)
│   ├── analyze_mutations.py  # detailed mutmut cache analysis
│   └── pr-status.sh   # gh CLI workflow monitor for PRs
├── frontend/          # TypeScript quality gates — runs against frontend/
│   ├── check-all.sh
│   ├── fix-all.sh
│   ├── lint.sh        # eslint
│   ├── format.sh      # prettier
│   ├── typecheck.sh   # tsc --noEmit
│   ├── test.sh        # jest
│   └── pr-status.sh
├── dev-setup.sh       # Pre-existing: idempotent dev env bootstrap
└── pre-deploy-check.sh # Pre-existing: deployment readiness check
```

## Adaptations from source

- `PROJECT_ROOT` in each script is resolved to `backend/` or `frontend/`
  (not the repo root) so invocations like `ruff check .` operate on the
  correct subtree.
- The Python package name `adepthood_linters` has been replaced with
  `src` (Adepthood's actual backend package).
- Frontend and backend pairs are intentionally duplicated rather than
  unified so each subsection remains independently runnable and can
  evolve separately.

## Usage

```bash
source .venv/bin/activate                  # Python scripts need the venv
scripts/backend/check-all.sh --verbose     # Run every backend gate
scripts/backend/fix-all.sh                 # Auto-fix what can be fixed
scripts/frontend/check-all.sh              # Run every frontend gate
```

New tools that aren't yet installed (`mutmut`, `interrogate`, `xenon`) will
be added in the next tranche of the integration.
