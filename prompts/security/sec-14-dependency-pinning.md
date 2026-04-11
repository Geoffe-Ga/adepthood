# sec-14: Dependency versions not pinned for production

**Labels:** `security`, `full-stack`, `priority-low`
**Severity:** LOW
**OWASP:** A08:2021 — Software and Data Integrity Failures
**Estimated LoC:** ~50

## Problem

### Backend

`backend/requirements.txt` lists dependencies without version pins:

```
cachetools
fastapi
uvicorn[standard]
pydantic
sqlalchemy
sqlmodel
asyncpg
aiosqlite
bcrypt
PyJWT
slowapi
pytest
pytest-asyncio
httpx
```

Without pinned versions, `pip install -r requirements.txt` resolves to the
latest version at install time. This means:

- **Non-reproducible builds** — two developers may have different versions
- **Supply chain risk** — a compromised package update is automatically pulled
- **Silent breaking changes** — a major version bump could break the app
  without any code changes

### Frontend

`frontend/package.json` uses caret ranges (`^`) for many dependencies, which
allows minor and patch updates:

```json
"zustand": "^5.0.5"
"@react-navigation/bottom-tabs": "^7.3.10"
```

The `package-lock.json` mitigates this in practice, but fresh installs with
`npm install` (vs `npm ci`) will resolve to newer versions.

## Tasks

### Backend

1. **Generate a pinned requirements file**
   ```bash
   pip freeze > backend/requirements-lock.txt
   ```
   Or use `uv pip compile`:
   ```bash
   uv pip compile backend/requirements.txt -o backend/requirements-lock.txt
   ```

2. **Use the lock file in CI and Docker**
   ```dockerfile
   COPY requirements-lock.txt .
   RUN pip install --no-cache-dir -r requirements-lock.txt
   ```

3. **Keep `requirements.txt` as the unpinned input file** for humans to edit

4. **Add Dependabot for pip**
   ```yaml
   # .github/dependabot.yml
   - package-ecosystem: "pip"
     directory: "/backend"
     schedule:
       interval: "weekly"
   ```

### Frontend

5. **Enforce `npm ci` in all CI and deployment contexts**
   - `npm ci` respects `package-lock.json` exactly
   - Already documented in CLAUDE.md but verify CI uses it

6. **Add Dependabot for npm**
   ```yaml
   - package-ecosystem: "npm"
     directory: "/frontend"
     schedule:
       interval: "weekly"
   ```

## Acceptance Criteria

- Backend has a pinned lock file used in CI and Docker
- Frontend CI uses `npm ci` exclusively
- Dependabot configured for both pip and npm ecosystems
- Development workflow is not impacted (developers can still use unpinned file)

## Files to Modify

| File | Action |
|------|--------|
| `backend/requirements-lock.txt` | Create (generated lock file) |
| `backend/Dockerfile` | Use requirements-lock.txt |
| `.github/workflows/backend-ci.yml` | Use requirements-lock.txt |
| `.github/dependabot.yml` | Create or update (add pip + npm) |
