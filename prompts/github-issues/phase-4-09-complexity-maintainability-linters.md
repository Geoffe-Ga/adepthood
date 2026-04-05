# phase-4-09: Add complexity and maintainability linters to backend and frontend

**Labels:** `phase-4`, `full-stack`, `quality`, `priority-medium`
**Epic:** Phase 4 — Polish & Harden
**Depends on:** None (independent of other issues)
**Estimated LoC:** ~150–200

## Problem

The codebase enforces formatting (Black, Prettier), import sorting (isort), static analysis (Ruff, ESLint), type safety (MyPy, TypeScript strict), and security (Bandit, pip-audit). However, there are **no tools measuring code complexity or maintainability**:

- No cyclomatic complexity checks — a function with 15 nested `if/else` branches passes all current gates
- No cognitive complexity tracking — deeply nested or hard-to-follow logic is invisible to CI
- No maintainability index — there's no aggregate score indicating whether modules are getting harder to maintain over time
- No frontend complexity enforcement beyond ESLint's default rules (the `complexity` rule is not enabled in `frontend/eslint.config.cjs`)

**Current quality stack gaps:**

| Metric | Backend | Frontend |
|--------|---------|----------|
| Cyclomatic complexity | Not measured | Not measured |
| Cognitive complexity | Not measured | Not measured |
| Maintainability index | Not measured | Not measured |
| Halstead metrics | Not measured | Not measured |

## Scope

Add Radon + Xenon to the backend and ESLint complexity rules + `eslint-plugin-sonarjs` to the frontend. Configure thresholds to achieve **outstanding grades** (Radon A-rank across the board, Xenon absolute A, low ESLint complexity ceilings). Wire everything into pre-commit so complexity regressions are caught before code ever reaches a PR.

## Tasks

### Backend: Radon + Xenon

1. **Install Radon and Xenon**
   - Add `radon>=6.0` and `xenon>=0.9` to `backend/requirements-dev.txt`
   - Radon computes cyclomatic complexity (CC), maintainability index (MI), and Halstead metrics
   - Xenon is the threshold-enforcing wrapper that fails CI when complexity exceeds limits

2. **Configure Xenon thresholds for A-rank**
   Xenon uses letter grades (A is simplest, F is most complex):
   - `--max-absolute A` — no single function may exceed CC of 5 (A-rank)
   - `--max-modules A` — average complexity per module must be A-rank
   - `--max-average A` — overall project average must be A-rank

   If any existing code exceeds A-rank, refactor it (extract helpers, simplify branching) rather than weakening the threshold. Run an initial audit first:
   ```bash
   source .venv/bin/activate
   cd backend
   radon cc src/ -s -a          # Show per-function CC with grades
   radon mi src/ -s             # Show maintainability index per module
   xenon src/ --max-absolute A --max-modules A --max-average A
   ```

3. **Add Radon MI check**
   - Run `radon mi src/ -n B` to list any module scoring below A-rank on maintainability index
   - MI scale: A (20–100) is maintainable, B (10–19) is moderate, C (0–9) is unmaintainable
   - Target: all modules must score **A** (MI ≥ 20)
   - If any modules score below A, refactor them: break up long functions, reduce nesting, extract constants

4. **Add Radon Halstead metrics reporting (informational)**
   - `radon hal src/` provides effort, difficulty, and volume metrics
   - Not enforced as a gate, but included as a reporting step for visibility
   - Add as an informational pre-commit hook (non-blocking) or CI step

5. **Add pre-commit hooks for Radon/Xenon**
   Add to `.pre-commit-config.yaml`:
   ```yaml
   - repo: local
     hooks:
       - id: xenon-complexity
         name: xenon complexity check
         entry: bash -c 'cd backend && xenon src/ --max-absolute A --max-modules A --max-average A'
         language: system
         pass_filenames: false
         files: ^backend/.*\.py$
         stages: [pre-commit]

       - id: radon-maintainability
         name: radon maintainability index
         entry: bash -c 'cd backend && radon mi src/ -n B -s'
         language: system
         pass_filenames: false
         files: ^backend/.*\.py$
         stages: [pre-commit]
   ```
   Note: `radon mi -n B` exits non-zero if any module scores below A, which will fail the hook.

6. **Add pyproject.toml configuration for Radon**
   Add to `backend/pyproject.toml`:
   ```toml
   [tool.radon]
   cc_min = "A"
   mi_min = "A"
   exclude = "migrations,alembic,.venv,venv,tests"
   show_complexity = true
   average = true
   ```

### Frontend: ESLint Complexity Rules + SonarJS

7. **Install `eslint-plugin-sonarjs`**
   ```bash
   cd frontend && npm ci  # if needed
   cd frontend && npm install --save-dev eslint-plugin-sonarjs
   ```
   This plugin provides cognitive complexity and code-smell detection rules.

8. **Enable complexity rules in `frontend/eslint.config.cjs`**
   Add `sonarjs` plugin and enable these rules:
   ```javascript
   const sonarjs = require('eslint-plugin-sonarjs');

   // In the rules section:
   rules: {
     // Built-in ESLint complexity rules
     'complexity': ['error', { max: 10 }],           // Cyclomatic complexity per function
     'max-depth': ['error', { max: 3 }],              // Max nesting depth
     'max-nested-callbacks': ['error', { max: 2 }],   // Max callback nesting
     'max-lines-per-function': ['error', {
       max: 50,
       skipBlankLines: true,
       skipComments: true,
     }],

     // SonarJS cognitive complexity and code smells
     'sonarjs/cognitive-complexity': ['error', 10],    // Cognitive complexity per function
     'sonarjs/no-duplicate-string': ['error', { threshold: 3 }],
     'sonarjs/no-identical-functions': 'error',
     'sonarjs/no-collapsible-if': 'error',
     'sonarjs/prefer-single-boolean-return': 'error',
     'sonarjs/no-redundant-jump': 'error',
     'sonarjs/no-small-switch': 'error',
   }
   ```

   **Threshold rationale for "outstanding" grades:**
   - `complexity: 10` — standard "simple" threshold; most style guides use 10–15, we use the stricter end
   - `max-depth: 3` — prevents deeply nested pyramids of doom
   - `cognitive-complexity: 10` — SonarQube considers ≤15 as "A-grade"; 10 is stricter
   - `max-lines-per-function: 50` — forces decomposition into small, testable units

9. **Audit existing frontend code and fix violations**
   ```bash
   cd frontend && npx eslint . --max-warnings=0
   ```
   - If functions exceed complexity limits, refactor: extract sub-functions, use early returns, simplify conditionals
   - If components exceed line limits, extract sub-components or custom hooks
   - Do NOT add `// eslint-disable` comments — fix the code

10. **Add a frontend complexity reporting script**
    Add to `frontend/package.json` scripts:
    ```json
    {
      "scripts": {
        "complexity": "eslint . --format json | node -e \"const r=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));const msgs=r.flatMap(f=>f.messages.filter(m=>['complexity','sonarjs/cognitive-complexity'].includes(m.ruleId)).map(m=>({file:f.filePath,line:m.line,rule:m.ruleId,msg:m.message})));console.table(msgs);console.log('Total complexity warnings:',msgs.length)\""
      }
    }
    ```
    This provides a quick summary view of all complexity-related findings.

### Verification & Documentation

11. **Run full audit and verify outstanding grades**
    ```bash
    # Backend
    source .venv/bin/activate
    cd backend
    radon cc src/ -s -a -n C    # Should show NO functions rated C or below
    radon mi src/ -s            # All modules should show "A" grade
    xenon src/ --max-absolute A --max-modules A --max-average A  # Must exit 0

    # Frontend
    cd ../frontend
    npx eslint . --max-warnings=0   # Must exit 0 with new rules enabled

    # Full pre-commit
    cd ..
    pre-commit run --all-files      # All hooks green
    ```

12. **Update CI workflows if they exist**
    - If `.github/workflows/backend-ci.yml` exists, add Radon/Xenon steps
    - If `.github/workflows/frontend-ci.yml` exists, verify ESLint step already catches new rules (it should, since they're in the config)

## Acceptance Criteria

- `xenon backend/src/ --max-absolute A --max-modules A --max-average A` exits 0
- `radon mi backend/src/ -n B` reports zero modules below A-rank (MI ≥ 20)
- `radon cc backend/src/ -a -n C` reports zero functions at C-rank or below
- ESLint with `complexity`, `max-depth`, `max-nested-callbacks`, `max-lines-per-function`, and `sonarjs/cognitive-complexity` rules enabled passes with zero warnings
- Pre-commit hooks for Xenon and Radon MI are green on `pre-commit run --all-files`
- Any existing code that violated thresholds has been refactored (not suppressed)
- `eslint-plugin-sonarjs` is in `frontend/package.json` devDependencies
- `radon` and `xenon` are in `backend/requirements-dev.txt`

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/requirements-dev.txt` | Modify (add radon, xenon) |
| `backend/pyproject.toml` | Modify (add [tool.radon] config) |
| `.pre-commit-config.yaml` | Modify (add xenon + radon MI hooks) |
| `frontend/package.json` | Modify (add eslint-plugin-sonarjs, complexity script) |
| `frontend/eslint.config.cjs` | Modify (add sonarjs plugin, complexity rules) |
| `backend/src/**/*.py` | Modify (refactor any functions exceeding A-rank) |
| `frontend/src/**/*.ts{,x}` | Modify (refactor any functions exceeding complexity limits) |
| `.github/workflows/backend-ci.yml` | Modify (add radon/xenon CI steps) |
