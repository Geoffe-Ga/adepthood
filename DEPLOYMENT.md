# Deployment Guide

Adepthood uses **Railway** for the backend API and **Expo EAS** for the
React Native mobile app. This guide covers both.

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
                         │ Railway PostgreSQL │
                         │ (auto-provisioned) │
                         └──────────────────┘
```

---

## Backend Deployment (Railway)

### Prerequisites

- A [Railway](https://railway.com) account (free tier works for initial setup)
- Railway CLI installed (`npm i -g @railway/cli`) or use the web dashboard

### 1. Create a Railway Project

```bash
railway login
railway init
```

Or create a project via the Railway web dashboard.

### 2. Add PostgreSQL

- In the Railway dashboard: click **New** > **Database** > **PostgreSQL**
- Railway automatically sets `DATABASE_URL` for linked services

### 3. Set Environment Variables

In the Railway dashboard, configure:

| Variable | Value | Notes |
|----------|-------|-------|
| `ENV` | `production` | Required |
| `PROD_DOMAIN` | `https://your-domain.com` | Comma-separated HTTPS URLs for CORS |
| `SECRET_KEY` | *(generate below)* | JWT signing key |
| `BOTMASON_PROVIDER` | `stub` or `openai` or `anthropic` | AI chat backend |
| `LLM_API_KEY` | *(your key)* | Only if using openai/anthropic |

Generate a secure `SECRET_KEY`:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

> `DATABASE_URL`, `PORT`, and `RAILWAY_*` variables are auto-injected by
> Railway. Do not set them manually.

### 4. Deploy

Connect your GitHub repo to Railway. It auto-detects `railway.toml` and uses
the Dockerfile at `backend/Dockerfile`.

Or deploy via CLI:

```bash
railway up
```

### 5. Verify

```bash
curl https://your-app.up.railway.app/health
# Expected: {"status": "healthy", "database": "connected"}
```

### 6. Custom Domain (Optional)

In Railway dashboard: **Settings** > **Domains** > add your domain and
configure DNS.

---

## Frontend Deployment (Expo EAS)

The frontend is a React Native Expo app. It does **not** deploy to Railway.

### Prerequisites

- An [Expo](https://expo.dev) account
- EAS CLI: `npm install -g eas-cli`

### 1. Log In

```bash
eas login
```

### 2. Configure API URL

Set the production API URL as an EAS secret:

```bash
eas secret:create --name EXPO_PUBLIC_API_BASE_URL \
  --value https://your-app.up.railway.app
```

The frontend reads this via `process.env.EXPO_PUBLIC_API_BASE_URL` in
`frontend/src/config.ts`.

### 3. Build for Production

```bash
cd frontend
eas build --platform all --profile production
```

### 4. Submit to App Stores

```bash
eas submit --platform all
```

---

## Database Migrations

Migrations run automatically on each deploy via the Dockerfile `CMD`. When
Alembic is configured (`alembic.ini` exists), the container runs
`alembic upgrade head` before starting the server.

To run migrations manually against the Railway database:

```bash
railway run alembic upgrade head
```

To create a new migration locally:

```bash
cd backend
source ../.venv/bin/activate
alembic revision --autogenerate -m "description of change"
```

---

## Monitoring

- **Health check:** Railway pings `/health` every 30 seconds
- **Logs:** `railway logs` or Railway dashboard > Deployments > Logs
- **Database:** `railway connect postgres` for direct psql access

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Deploy fails on migrations | Check `DATABASE_URL` is set; run `railway logs` |
| 503 on `/health` | Database not connected — verify PostgreSQL plugin is linked |
| CORS errors | Verify `PROD_DOMAIN` matches your frontend URL exactly (must use HTTPS) |
| Slow cold starts | Increase `WEB_CONCURRENCY` or upgrade Railway plan |

---

## Pre-deploy Checklist

Run the automated check script before deploying:

```bash
./scripts/pre-deploy-check.sh
```

This runs backend tests (90% coverage minimum), frontend tests, all pre-commit
hooks, and builds the Docker image locally.
