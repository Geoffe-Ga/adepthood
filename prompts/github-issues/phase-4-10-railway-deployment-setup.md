# phase-4-10: Railway deployment setup with production configuration

**Labels:** `phase-4`, `full-stack`, `infrastructure`, `devops`, `priority-medium`
**Epic:** Phase 4 — Polish & Harden
**Depends on:** phase-4-08 (CORS production fix)
**Estimated LoC:** ~300–400

## Problem

The app has no deployment configuration. There is no Dockerfile, no `railway.toml`, no Procfile, and no production-ready setup for hosting. The backend runs on `uvicorn` in dev mode and the frontend is an Expo React Native app that needs specific build/deploy considerations. Railway is the target platform.

**Current state:**
- `backend/src/main.py` creates a FastAPI app with dev CORS settings
- Database URL is read from environment but no production database is configured
- No health check endpoint suitable for Railway's health monitoring (the `/health` check may not exist yet or may not validate DB)
- No Dockerfile for containerized deployment
- No `railway.toml` for Railway-specific configuration
- No migration strategy for production deploys (Alembic exists but no automated run)
- No static asset or build pipeline for the React Native frontend
- No environment variable documentation for production
- No README section explaining deployment

## Scope

Create a complete Railway deployment configuration for the backend API service, with production PostgreSQL, automated migrations, health checks, and a comprehensive README. The frontend (React Native/Expo) is deployed via EAS Build/Submit to app stores — document this process but focus Railway config on the backend.

## Tasks

### Backend Dockerfile

1. **Create `backend/Dockerfile`**
   ```dockerfile
   # --- Build stage ---
   FROM python:3.12-slim AS builder

   WORKDIR /app

   # Install system dependencies for asyncpg
   RUN apt-get update && \
       apt-get install -y --no-install-recommends gcc libpq-dev && \
       rm -rf /var/lib/apt/lists/*

   COPY requirements.txt .
   RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

   # --- Runtime stage ---
   FROM python:3.12-slim

   WORKDIR /app

   # Runtime dependency for asyncpg
   RUN apt-get update && \
       apt-get install -y --no-install-recommends libpq5 && \
       rm -rf /var/lib/apt/lists/*

   COPY --from=builder /install /usr/local
   COPY src/ src/
   COPY alembic.ini .
   COPY migrations/ migrations/

   # Create non-root user
   RUN useradd --create-home appuser
   USER appuser

   EXPOSE 8000

   # Run migrations then start server
   CMD ["sh", "-c", "python -m alembic upgrade head && python -m uvicorn src.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers ${WEB_CONCURRENCY:-2}"]
   ```

   Key decisions:
   - Multi-stage build to minimize image size
   - Non-root user for security
   - Alembic migrations run automatically on deploy
   - `PORT` and `WEB_CONCURRENCY` are Railway-injected env vars
   - No dev dependencies in production image

2. **Create `backend/.dockerignore`**
   ```
   __pycache__
   *.pyc
   .pytest_cache
   .mypy_cache
   .ruff_cache
   .venv
   venv
   tests/
   .env
   .env.*
   *.md
   .git
   .github
   htmlcov
   coverage.xml
   .coverage
   ```

### Railway Configuration

3. **Create `railway.toml` at project root**
   ```toml
   [build]
   builder = "dockerfile"
   dockerfilePath = "backend/Dockerfile"
   watchPatterns = ["backend/**"]

   [deploy]
   healthcheckPath = "/health"
   healthcheckTimeout = 30
   restartPolicyType = "on_failure"
   restartPolicyMaxRetries = 3

   [deploy.environmentVariables]
   # Railway auto-injects DATABASE_URL for linked PostgreSQL
   # These are documented but set via Railway dashboard
   ENV = "production"
   # PROD_DOMAIN = "https://api.adepthood.com"
   # JWT_SECRET_KEY = "<generated>"
   # JWT_ALGORITHM = "HS256"
   # JWT_ACCESS_TOKEN_EXPIRE_MINUTES = "30"
   ```

4. **Create `railway.json` for service configuration (optional, Railway reads this)**
   ```json
   {
     "$schema": "https://railway.com/railway.schema.json",
     "build": {
       "builder": "DOCKERFILE",
       "dockerfilePath": "backend/Dockerfile"
     },
     "deploy": {
       "restartPolicyType": "ON_FAILURE",
       "restartPolicyMaxRetries": 3,
       "healthcheckPath": "/health",
       "healthcheckTimeout": 30
     }
   }
   ```
   Note: Use `railway.toml` OR `railway.json`, not both. Prefer `railway.toml` as it's the more common convention. Only create `railway.json` if Railway tooling requires it. **Decision: use `railway.toml` only.**

### Backend Production Hardening

5. **Update `backend/src/main.py` for production readiness**
   - Ensure the `/health` endpoint exists and validates DB connectivity:
     ```python
     @app.get("/health")
     async def health_check(session: AsyncSession = Depends(get_session)) -> dict:
         try:
             await session.execute(text("SELECT 1"))
             return {"status": "healthy", "database": "connected"}
         except Exception:
             raise HTTPException(status_code=503, detail="Database unavailable")
     ```
   - Ensure CORS reads `PROD_DOMAIN` correctly (depends on phase-4-08)
   - Ensure `DATABASE_URL` works with Railway's PostgreSQL format (`postgresql://...`)
     - Railway provides `DATABASE_URL` in standard format
     - If using asyncpg, may need to replace `postgresql://` with `postgresql+asyncpg://` in `database.py`:
       ```python
       database_url = os.environ["DATABASE_URL"]
       if database_url.startswith("postgresql://"):
           database_url = database_url.replace("postgresql://", "postgresql+asyncpg://", 1)
       ```

6. **Create `backend/.env.example` updates**
   Ensure this documents all production env vars:
   ```env
   # Database (Railway auto-injects for linked PostgreSQL service)
   DATABASE_URL=postgresql+asyncpg://USER:PASSWORD@HOST:5432/DBNAME  # pragma: allowlist secret

   # Environment
   ENV=development  # development | staging | production

   # CORS (required in production, see phase-4-08)
   PROD_DOMAIN=https://api.adepthood.com

   # JWT Authentication
   JWT_SECRET_KEY=change-me-in-production
   JWT_ALGORITHM=HS256
   JWT_ACCESS_TOKEN_EXPIRE_MINUTES=30

   # Server
   PORT=8000
   WEB_CONCURRENCY=2

   # Railway auto-injected (do not set manually)
   # RAILWAY_ENVIRONMENT=production
   # RAILWAY_PUBLIC_DOMAIN=your-app.up.railway.app
   ```

### Frontend Deployment Documentation

7. **Document Expo/EAS deployment for frontend**
   The frontend is a React Native Expo app. It does NOT deploy to Railway. Document the correct deployment path:
   - **Development:** `npx expo start` (local dev server)
   - **Preview builds:** `eas build --platform all --profile preview`
   - **Production builds:** `eas build --platform all --profile production`
   - **App store submission:** `eas submit --platform all`

   Create `frontend/eas.json` if it doesn't exist:
   ```json
   {
     "cli": { "version": ">= 5.0.0" },
     "build": {
       "development": {
         "developmentClient": true,
         "distribution": "internal"
       },
       "preview": {
         "distribution": "internal"
       },
       "production": {}
     },
     "submit": {
       "production": {}
     }
   }
   ```

   Note: The frontend must be configured with the production API URL:
   - Create `frontend/src/api/config.ts` (or update existing) to read `EXPO_PUBLIC_API_URL` from environment
   - Default to local dev URL, override for production builds

### README: Deployment Setup Guide

8. **Create `DEPLOYMENT.md` at project root**
   This is the comprehensive deployment README. It must cover:

   **a. Prerequisites**
   - Railway account (free tier works for initial setup)
   - Railway CLI installed (`npm i -g @railway/cli`) or use the web dashboard
   - PostgreSQL plugin added to the Railway project
   - Expo account + EAS CLI for frontend builds

   **b. Railway Backend Setup (step-by-step)**
   ```markdown
   ## Backend Deployment (Railway)

   ### 1. Create a Railway Project
   - Go to railway.com and create a new project
   - Or use CLI: `railway init`

   ### 2. Add PostgreSQL
   - Click "New" → "Database" → "PostgreSQL"
   - Railway automatically sets `DATABASE_URL` for linked services

   ### 3. Deploy the Backend
   - Connect your GitHub repo to Railway
   - Railway auto-detects `railway.toml` and uses the Dockerfile
   - Or deploy via CLI: `railway up`

   ### 4. Set Environment Variables
   In the Railway dashboard, set:
   - `ENV=production`
   - `PROD_DOMAIN=https://your-domain.com`
   - `JWT_SECRET_KEY=<generate with: python -c "import secrets; print(secrets.token_urlsafe(32))">`
   - `JWT_ALGORITHM=HS256`
   - `JWT_ACCESS_TOKEN_EXPIRE_MINUTES=30`
   Note: `DATABASE_URL` and `PORT` are auto-injected by Railway.

   ### 5. Verify Deployment
   - Check the deploy logs in Railway dashboard
   - Hit the health endpoint: `curl https://your-app.up.railway.app/health`
   - Expected response: `{"status": "healthy", "database": "connected"}`

   ### 6. Custom Domain (optional)
   - In Railway dashboard → Settings → Domains
   - Add your custom domain and configure DNS
   ```

   **c. Frontend Deployment (EAS)**
   ```markdown
   ## Frontend Deployment (Expo EAS)

   ### 1. Install EAS CLI
   ```bash
   npm install -g eas-cli
   eas login
   ```

   ### 2. Configure API URL
   Set the production API URL in your EAS build profile:
   ```bash
   eas secret:create --name EXPO_PUBLIC_API_URL --value https://your-app.up.railway.app
   ```

   ### 3. Build for Production
   ```bash
   cd frontend
   eas build --platform all --profile production
   ```

   ### 4. Submit to App Stores
   ```bash
   eas submit --platform all
   ```
   ```

   **d. Database Migrations**
   ```markdown
   ## Database Migrations

   Migrations run automatically on each deploy (via the Dockerfile CMD).
   To run manually:
   ```bash
   railway run alembic upgrade head
   ```

   To create a new migration:
   ```bash
   cd backend
   source .venv/bin/activate
   alembic revision --autogenerate -m "description of change"
   ```
   ```

   **e. Monitoring & Troubleshooting**
   ```markdown
   ## Monitoring

   - **Health check:** Railway pings `/health` every 30s
   - **Logs:** `railway logs` or Railway dashboard → Deployments → Logs
   - **Database:** `railway connect postgres` for direct psql access

   ## Troubleshooting

   | Problem | Solution |
   |---------|----------|
   | Deploy fails on migrations | Check `DATABASE_URL` is set, run `railway logs` |
   | 503 on `/health` | Database not connected — verify PostgreSQL plugin is linked |
   | CORS errors | Verify `PROD_DOMAIN` matches your frontend URL exactly |
   | Slow cold starts | Increase `WEB_CONCURRENCY` or upgrade Railway plan |
   ```

   **f. Architecture Diagram**
   ```markdown
   ## Architecture

   ```
   ┌─────────────────┐     ┌──────────────────┐
   │  React Native    │────▶│  Railway Backend  │
   │  (Expo/EAS)      │     │  (FastAPI)        │
   │  iOS + Android   │     │  Port: $PORT      │
   └─────────────────┘     └────────┬─────────┘
                                     │
                                     ▼
                            ┌──────────────────┐
                            │  Railway PostgreSQL│
                            │  (auto-provisioned)│
                            └──────────────────┘
   ```
   ```

### Verification

9. **Local Docker verification**
   ```bash
   # Build and test the Docker image locally
   cd backend
   docker build -t adepthood-backend .
   docker run -e DATABASE_URL=sqlite+aiosqlite:///test.db -e ENV=development -p 8000:8000 adepthood-backend

   # In another terminal:
   curl http://localhost:8000/health
   ```

10. **Pre-deploy checklist script**
    Create `scripts/pre-deploy-check.sh`:
    ```bash
    #!/usr/bin/env bash
    set -euo pipefail

    echo "=== Pre-deploy Checklist ==="

    echo "1. Running backend tests..."
    cd backend && source ../.venv/bin/activate
    pytest --cov=. --cov-report=term-missing --cov-fail-under=90
    echo "✓ Backend tests pass with ≥90% coverage"

    echo "2. Running frontend tests..."
    cd ../frontend
    npm test -- --watchAll=false
    echo "✓ Frontend tests pass"

    echo "3. Running pre-commit hooks..."
    cd ..
    pre-commit run --all-files
    echo "✓ All pre-commit hooks pass"

    echo "4. Building Docker image..."
    cd backend
    docker build -t adepthood-backend-check .
    echo "✓ Docker image builds successfully"

    echo ""
    echo "=== All checks passed. Ready to deploy! ==="
    ```
    Make executable: `chmod +x scripts/pre-deploy-check.sh`

## Acceptance Criteria

- `docker build -t adepthood-backend backend/` succeeds and produces a working image
- Container starts and responds to `/health` with `{"status": "healthy", ...}`
- `railway.toml` exists and configures Dockerfile build, health checks, and restart policy
- `backend/.dockerignore` excludes tests, dev files, and secrets
- `backend/.env.example` documents all required and auto-injected environment variables
- `DEPLOYMENT.md` exists at project root with complete setup instructions for Railway backend and Expo frontend
- `scripts/pre-deploy-check.sh` runs all quality gates + Docker build
- Alembic migrations run automatically in the Docker CMD
- Non-root user is used in the Docker container
- No secrets are hardcoded anywhere — all sensitive values come from environment variables
- `DATABASE_URL` format is handled correctly for both Railway PostgreSQL and local development

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/Dockerfile` | **Create** |
| `backend/.dockerignore` | **Create** |
| `railway.toml` | **Create** |
| `DEPLOYMENT.md` | **Create** |
| `scripts/pre-deploy-check.sh` | **Create** |
| `backend/src/main.py` | Modify (ensure /health validates DB) |
| `backend/src/database.py` | Modify (handle Railway DATABASE_URL format) |
| `backend/.env.example` | Modify (document all production env vars) |
| `frontend/eas.json` | **Create** (if not exists) |
| `frontend/src/api/config.ts` | Modify (read EXPO_PUBLIC_API_URL) |
