# Deploying Adepthood on Railway (Web App)

This guide walks you through deploying Adepthood as a **web application** on
[Railway](https://railway.com). You will end up with two Railway services (API
+ frontend) and a managed PostgreSQL database, all inside one Railway project.

> **Mobile deployment** (Expo EAS for iOS/Android) is covered in a
> [separate section](#mobile-deployment-expo-eas) at the end of this doc.

---

## Architecture

```
                 ┌──────────────────────────────────────────────┐
                 │            Railway Project                    │
                 │                                              │
 Browser ──────▶│  Frontend Service          Backend Service    │
                 │  (nginx, static files)     (FastAPI, Docker) │
                 │  https://app.adepthood.com  https://api.adepthood.com
                 │        │                       │             │
                 │        │   fetch /api/*         │             │
                 │        └──────────────────────▶│             │
                 │                                 │             │
                 │                          ┌──────▼──────┐     │
                 │                          │  PostgreSQL  │     │
                 │                          │  (managed)   │     │
                 │                          └─────────────┘     │
                 └──────────────────────────────────────────────┘
```

**Frontend service** — Expo web build (`npx expo export --platform web`)
served by nginx. Produces a static `dist/` folder with HTML/JS/CSS.

**Backend service** — FastAPI running on Uvicorn inside Docker. Handles all
API requests, JWT auth, and database access.

**PostgreSQL** — Railway's managed PostgreSQL add-on. Connection string is
auto-injected as `DATABASE_URL`.

---

## Prerequisites

- A [Railway](https://railway.com) account (Hobby plan recommended — $5/mo,
  includes enough resources for a production web app)
- Railway CLI installed (optional but helpful):
  ```bash
  npm i -g @railway/cli
  railway login
  ```
- Your repo pushed to GitHub (Railway deploys from GitHub)

---

## Step 1: Create the Railway Project

1. Go to [railway.com/new](https://railway.com/new)
2. Click **"Empty Project"**
3. Name it `adepthood` (or whatever you prefer)

You'll add three things to this project: a PostgreSQL database, the backend
service, and the frontend service.

---

## Step 2: Add PostgreSQL

1. Inside your Railway project, click **"+ New"** → **"Database"** → **"PostgreSQL"**
2. That's it. Railway provisions the database and makes `DATABASE_URL`
   available to any service you link.

**Important:** Keep the PostgreSQL service in the same project. Railway
automatically injects `DATABASE_URL` as an environment variable into linked
services — you never need to copy/paste connection strings.

### Connecting locally (optional)

To inspect the production database:
```bash
# Via Railway CLI
railway connect postgres

# Or copy the connection string from the Railway dashboard:
# PostgreSQL service → Variables → DATABASE_URL
```

---

## Step 3: Deploy the Backend

### 3a. How it works

The backend deploys via the existing `backend/Dockerfile` and `railway.toml`:

- **`railway.toml`** tells Railway to use the Dockerfile at
  `backend/Dockerfile` and to health-check `/health`
- **`backend/Dockerfile`** is a multi-stage build: installs Python
  dependencies, copies source code, runs migrations (if Alembic is configured),
  and starts Uvicorn
- **On every deploy**, the container runs
  `alembic upgrade head` (if `alembic.ini` exists) then starts the server

### 3b. Create the backend service

1. In your Railway project, click **"+ New"** → **"GitHub Repo"**
2. Select your `adepthood` repository
3. Railway detects `railway.toml` and uses it automatically
4. The service name will default to your repo name — rename it to
   **`backend`** for clarity

> **Root directory:** Since `railway.toml` already points to
> `backend/Dockerfile`, you do **not** need to set a custom root directory.
> Railway reads `railway.toml` from the repo root.

### 3c. Link PostgreSQL to the backend

1. Click on the **backend** service → **Variables**
2. Click **"+ Add Variable"** → **"Add Reference"** → select the PostgreSQL
   service
3. This injects `DATABASE_URL` (among others) into the backend automatically

### 3d. Set environment variables

In the backend service's **Variables** tab, add:

| Variable | Value | Required? |
|----------|-------|-----------|
| `ENV` | `production` | Yes |
| `SECRET_KEY` | *(see below)* | Yes |
| `PROD_DOMAIN` | `https://your-frontend-domain.com` | Yes |
| `BOTMASON_PROVIDER` | `stub` | Yes (use `stub` to start) |
| `LLM_API_KEY` | *(your API key)* | Only if provider is `openai` or `anthropic` |
| `LLM_MODEL` | *(model name)* | No (sensible defaults built in) |
| `WEB_CONCURRENCY` | `2` | No (default: 2) |

**Generate a SECRET_KEY:**
```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```
Copy the output and paste it as the `SECRET_KEY` value. This is used to sign
JWT tokens — keep it secret, keep it safe.

**About PROD_DOMAIN:**
This controls CORS (which origins can call your API). Set it to the URL where
your frontend will live. Comma-separated if you have multiple:
```
https://app.adepthood.com,https://www.adepthood.com
```
All entries **must** use `https://`. The backend will refuse to start if they
don't — this is intentional.

> You can come back and update `PROD_DOMAIN` after you deploy the frontend and
> know its URL. The backend will need a redeploy to pick up the change.

**Variables you should NOT set manually:**
- `DATABASE_URL` — auto-injected by Railway from the linked PostgreSQL
- `PORT` — auto-injected by Railway
- `RAILWAY_*` — auto-injected by Railway

### 3e. Deploy and verify

Railway auto-deploys when you push to `main`. To trigger a manual deploy:
- Railway dashboard: backend service → **"Deploy"** button
- Or CLI: `railway up`

**Verify the deploy:**
```bash
curl https://your-backend.up.railway.app/health
# Expected: {"status":"healthy","database":"connected"}
```

If you get `{"detail":"Database unavailable"}` (503), the PostgreSQL service
isn't linked — go back to step 3c.

---

## Step 4: Deploy the Frontend (Web)

The frontend is an Expo/React Native app that compiles to a static website
via `npx expo export --platform web`. The static files are served by nginx
in a Docker container.

The following files are already in the repo:

- **`frontend/Dockerfile`** — Multi-stage build: installs npm deps, runs the
  Expo web export, copies the resulting `dist/` into an nginx image
- **`frontend/nginx.conf`** — SPA routing (all routes fall back to
  `index.html`), gzip compression, aggressive caching for fingerprinted assets
- **`frontend/metro.config.js`** — Enables Node package exports resolution
  (required for `react-native-web` to resolve `styleq` subpath imports)
- **`frontend/.dockerignore`** — Excludes `node_modules`, tests, etc. from
  the Docker build context

You can test the web build locally:
```bash
cd frontend
npm run web:build    # outputs to dist/
```

### 4a. Create the frontend service on Railway

1. In your Railway project, click **"+ New"** → **"GitHub Repo"**
2. Select the same `adepthood` repository
3. Rename the service to **`frontend`**
4. Go to the **Settings** tab for this service:
   - **Build Command:** Leave blank (Dockerfile handles it)
   - **Dockerfile Path:** `frontend/Dockerfile`
   - **Watch Paths:** `frontend/**`

### 4b. Set frontend environment variables

In the frontend service's **Variables** tab, add:

| Variable | Value | Notes |
|----------|-------|-------|
| `EXPO_PUBLIC_API_BASE_URL` | `https://your-backend.up.railway.app` | The backend service URL |
| `PORT` | `80` | nginx listens on 80 |

> **Important:** `EXPO_PUBLIC_API_BASE_URL` is baked into the JavaScript
> bundle at **build time** (not runtime). If you change the backend URL, you
> must **redeploy** the frontend for it to take effect.

### 4c. Deploy and verify

Push to `main` or trigger a manual deploy. Once Railway shows the deploy as
healthy, visit the frontend URL in your browser. You should see the app.

---

## Step 5: Connect the Services (CORS)

Now that both services are deployed, you need to tell the backend to accept
requests from the frontend's URL.

1. Copy the frontend service's public URL from Railway (e.g.,
   `https://adepthood-frontend.up.railway.app`)
2. Go to the backend service → **Variables**
3. Set `PROD_DOMAIN` to the frontend URL:
   ```
   https://adepthood-frontend.up.railway.app
   ```
4. The backend will redeploy automatically and start accepting requests from
   the frontend

**If you add a custom domain later**, update `PROD_DOMAIN` to include it:
```
https://app.adepthood.com,https://adepthood-frontend.up.railway.app
```

---

## Step 6: Custom Domains (Optional)

For each service in the Railway dashboard:

1. Go to **Settings** → **Networking** → **Custom Domain**
2. Add your domain (e.g., `api.adepthood.com` for the backend,
   `app.adepthood.com` for the frontend)
3. Railway shows you the DNS records to add (usually a CNAME)
4. Add the DNS records in your domain registrar
5. Railway auto-provisions HTTPS via Let's Encrypt

**Remember to update `PROD_DOMAIN`** on the backend to include any custom
domains you add for the frontend.

---

## Database Migrations (Alembic)

### Current status

Alembic is **not yet configured**. The `migrations/` directory exists but is
empty. The Dockerfile is already set up to run `alembic upgrade head` on
deploy — once you create `alembic.ini`, migrations will run automatically.

### Initial setup

```bash
source .venv/bin/activate
cd backend

# Initialize Alembic
pip install alembic   # Already in requirements.txt
alembic init migrations

# Edit alembic.ini: set sqlalchemy.url to empty string (we'll use env.py)
# Edit migrations/env.py: import your models and configure the async engine
```

In `migrations/env.py`, you'll want to:
1. Import your SQLModel metadata (`from models import *`)
2. Read `DATABASE_URL` from the environment
3. Use the async engine for migrations

### Creating migrations

```bash
cd backend
source ../.venv/bin/activate
alembic revision --autogenerate -m "initial schema"
```

### Running migrations manually against Railway

```bash
railway run alembic upgrade head
```

### On deploy

The Dockerfile CMD checks for `alembic.ini`:
```bash
if [ -f alembic.ini ]; then python -m alembic upgrade head; fi
```
Once you commit `alembic.ini` and your migration files, they run automatically
on every deploy.

### Before Alembic is set up

Without Alembic, tables are **not** auto-created in production. You have two
options:
1. Set up Alembic (recommended)
2. Add a startup event in `main.py` that calls
   `SQLModel.metadata.create_all()` — quick and dirty, not recommended for
   production

---

## Environment Variables Reference

### Backend

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ENV` | Yes | `development` | `development`, `staging`, or `production` |
| `SECRET_KEY` | Yes | `replace-me` | JWT signing key. Generate with `python -c "import secrets; print(secrets.token_urlsafe(32))"` |
| `PROD_DOMAIN` | In prod/staging | — | Comma-separated HTTPS origins for CORS (e.g., `https://app.adepthood.com`) |
| `BOTMASON_PROVIDER` | No | `stub` | AI backend: `stub`, `openai`, or `anthropic` |
| `LLM_API_KEY` | If not stub | — | API key for the chosen LLM provider |
| `LLM_MODEL` | No | Provider default | `gpt-4o-mini` (OpenAI) or `claude-sonnet-4-20250514` (Anthropic) |
| `WEB_CONCURRENCY` | No | `2` | Number of Uvicorn worker processes |
| `BOTMASON_SYSTEM_PROMPT` | No | Built-in | Path to prompt file or inline text |

**Auto-injected by Railway (do not set manually):**

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (from linked database) |
| `PORT` | Port the container should listen on |
| `RAILWAY_ENVIRONMENT` | Railway environment name |
| `RAILWAY_PUBLIC_DOMAIN` | Public domain assigned by Railway |

### Frontend

| Variable | Required | Description |
|----------|----------|-------------|
| `EXPO_PUBLIC_API_BASE_URL` | Yes | Full URL of the backend API (e.g., `https://api.adepthood.com`). Baked in at build time. |

---

## Web Compatibility Notes

The frontend is built with React Native + Expo, which compiles to web via
`react-native-web`. A few things to be aware of:

### Token storage
`expo-secure-store` falls back to **localStorage** on web. This is fine for
a web app — tokens are stored in the browser. On native (iOS/Android), it
uses the platform's secure keychain.

### Push notifications
`expo-notifications` and `react-native-push-notification` do **not** work on
web. If you need web push notifications later, you'll need to add a web-specific
implementation using the Web Push API. For now, notification features will
simply be unavailable in the web version.

### Navigation
React Navigation works on web out of the box. URLs map to screens
automatically. Deep links work as expected.

### Gestures and animations
`react-native-gesture-handler` and `react-native-reanimated` have web support.
Drag-and-drop (`react-native-draggable-flatlist`) may behave differently on
web — test these interactions.

---

## Monitoring and Operations

### Health check

Railway pings `GET /health` every 30 seconds. A healthy response:
```json
{"status": "healthy", "database": "connected"}
```

A 503 means the database is unreachable.

### Logs

```bash
# Via CLI
railway logs

# Or: Railway dashboard → Service → Deployments → click a deploy → Logs
```

### Database access

```bash
railway connect postgres   # Opens a psql shell
```

### Restarting a service

Railway dashboard → Service → **"Restart"** button. Or push a new commit.

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Backend deploy fails immediately | Missing `SECRET_KEY` or invalid `ENV` | Check logs. The app fails fast on bad config — set all required env vars |
| `503` on `/health` | Database not connected | Verify PostgreSQL is linked (step 3c). Check `DATABASE_URL` is in the service's variables |
| CORS errors in browser console | `PROD_DOMAIN` doesn't match frontend URL | Set `PROD_DOMAIN` to the exact frontend URL (with `https://`). Redeploy backend |
| Frontend shows blank page | `EXPO_PUBLIC_API_BASE_URL` not set or wrong | Check the variable is set on the frontend service. Redeploy (it's baked at build time) |
| Frontend routes return 404 | nginx not configured for SPA | Make sure `nginx.conf` has the `try_files` fallback to `index.html` |
| `alembic upgrade head` fails on deploy | Migration files missing or DB schema mismatch | Run `railway logs` to see the error. You may need to create an initial migration |
| Slow cold starts | Free tier or single worker | Upgrade Railway plan and/or increase `WEB_CONCURRENCY` |
| Rate limit errors (429) | Too many requests from one IP | Rate limits reset on container restart. In-memory by design — not persistent across deploys |

---

## Pre-deploy Checklist

Run the automated checks before deploying:

```bash
./scripts/pre-deploy-check.sh
```

This runs:
1. Backend tests (90% coverage minimum)
2. Frontend tests
3. All pre-commit hooks
4. Docker image build

**Manual checklist:**
- [ ] `SECRET_KEY` is a cryptographically random string (not `replace-me`)
- [ ] `ENV=production` on the backend
- [ ] `PROD_DOMAIN` matches your frontend URL(s) exactly, with `https://`
- [ ] `EXPO_PUBLIC_API_BASE_URL` on the frontend matches your backend URL
- [ ] PostgreSQL is linked to the backend service
- [ ] Health check returns `{"status":"healthy","database":"connected"}`
- [ ] Alembic migrations are up to date (if configured)
- [ ] `BOTMASON_PROVIDER` is set (`stub` is fine to start)

---

## Cost Estimate (Railway)

Railway's Hobby plan ($5/month) includes:
- 8 GB RAM, 8 vCPU shared across services
- 100 GB outbound bandwidth
- PostgreSQL included

For a low-traffic web app, this is more than sufficient. You only pay for
actual resource usage beyond the $5 credit.

---

## Mobile Deployment (Expo EAS)

Once the web app is running, you can also ship native iOS/Android builds via
Expo Application Services (EAS). The same backend serves both web and mobile.

### Prerequisites

- An [Expo](https://expo.dev) account
- EAS CLI: `npm install -g eas-cli && eas login`

### Set the API URL

```bash
eas secret:create --name EXPO_PUBLIC_API_BASE_URL \
  --value https://your-backend.up.railway.app
```

### Build

```bash
cd frontend
eas build --platform all --profile production
```

### Submit to app stores

```bash
eas submit --platform all
```

The mobile app connects to the same Railway backend. CORS is not relevant for
native apps (only browsers enforce CORS), but the backend's rate limiting and
JWT auth apply to all clients equally.
