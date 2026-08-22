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
| `JOURNAL_ENCRYPTION_KEYS` | *(see below)* | Yes — the backend refuses to boot in production without it |
| `PROD_DOMAIN` | `https://your-frontend-domain.com` | Yes |
| `BOTMASON_PROVIDER` | `stub` | Yes (use `stub` to start) |
| `LLM_API_KEY` | *(your API key)* | Only if provider is `openai` or `anthropic` |
| `LLM_MODEL` | *(model name)* | No (sensible defaults built in) |
| `WEB_CONCURRENCY` | `2` | No (default: 2) |
| `TRUSTED_PROXY_CIDRS` | *(Railway's ingress range)* | Recommended — without it every client shares one rate-limit bucket and https redirects break |
| `GOOGLE_OAUTH_CLIENT_IDS` | *(comma-separated Google client IDs)* | Only for Google sign-in — unset means every Google token is rejected |
| `APPLE_OAUTH_CLIENT_IDS` | *(the iOS bundle identifier)* | Only for Apple sign-in — unset means every Apple token is rejected |

**Generate a SECRET_KEY:**
```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```
Copy the output and paste it as the `SECRET_KEY` value. This is used to sign
JWT tokens — keep it secret, keep it safe.

**Generate a JOURNAL_ENCRYPTION_KEYS value:**
```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```
This encrypts journal entry text at rest. A production boot without it **fails**
— see [Journal Encryption at Rest](#journal-encryption-at-rest) below for what
that protects and how rotation works.

**About PROD_DOMAIN:**
This controls CORS (which origins can call your API). Set it to the URL where
your frontend will live. Comma-separated if you have multiple:
```
https://app.aptitude.guru
```
All entries **must** use `https://`. The backend will refuse to start if they
don't — this is intentional. **Every** live frontend origin must be listed: a
missing one makes the browser block all responses and the app falsely report
"offline" (#765).

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
| `EXPO_PUBLIC_GUMROAD_PRODUCT_URL` | `https://adepthood.gumroad.com/l/aptitude` | Optional. Product page the Get Started CTA opens; defaults to this value |
| `EXPO_PUBLIC_GUMROAD_HELP_URL` | `https://help.gumroad.com/article/76-license-keys` | Optional. License-key help article linked from signup; defaults to this value |
| `EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB` | *(the Google **Web** client ID)* | Only for Google sign-in on web. Baked in at build time — see the note below |
| `EXPO_PUBLIC_SANGHA_INVITE_URL` | `https://discord.gg/<your-permanent-invite>` | Optional. Digital Sangha invite; unset means Settings shows no Sangha door |
| `PORT` | `80` | nginx listens on 80 |

> **Important:** every `EXPO_PUBLIC_*` variable is baked into the JavaScript
> bundle at **build time** (not runtime). If you change one, you must
> **redeploy** the frontend for it to take effect.
>
> Each one must also be declared as an `ARG`/`ENV` pair in `frontend/Dockerfile`.
> A Docker build sees none of Railway's service variables unless the Dockerfile
> names them, so an undeclared variable produces a **green deploy with the
> feature silently missing** and nothing in any log — the value simply never
> reaches `expo export`.

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
https://app.aptitude.guru,https://adepthood-frontend.up.railway.app
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

### Setup (already in place)

Alembic is fully configured — there is nothing to initialise:

- `backend/alembic.ini` is committed.
- `backend/migrations/versions/` holds the migration history (the live schema is
  the sum of these revisions).
- `backend/migrations/env.py` reads `DATABASE_URL` from the environment and
  normalises the scheme via `normalize_database_url` (`backend/src/database.py`):
  a `postgres://` or `postgresql://` URL is rewritten to the
  `postgresql+asyncpg://` form SQLAlchemy's async engine requires. There is no
  hardcoded URL in `alembic.ini`.

> **Do not** re-initialise Alembic from scratch, hand-edit a fresh `env.py`, or
> bolt on an auto-`create_all` startup hook. The tree is already wired, and
> auto-creating tables at startup would bypass the migration history and the CI
> drift gate below.

### Creating a migration

```bash
cd backend
source ../.venv/bin/activate
alembic revision --autogenerate -m "<describe the change>"
```

Review the generated file in `migrations/versions/` (autogenerate is a starting
point, not a guarantee), then apply it locally:

```bash
alembic upgrade head
```

### Applying migrations

- **On deploy:** the Dockerfile `CMD` runs `python -m alembic upgrade head`
  before starting uvicorn, so every deploy applies any pending migrations
  automatically.
- **Manually against Railway:** `railway run alembic upgrade head`.

### CI safety net

The `migration-drift` job in `.github/workflows/backend-ci.yml` gates every push:

- runs `alembic upgrade head` against a real Postgres service, then a
  downgrade → re-upgrade **round-trip through both parents of a merge head**
  (so a broken `downgrade()` fails CI);
- runs `alembic check`, which fails if a model changed without a matching
  migration (model ↔ migration drift).

Because of this gate, never hand-edit an applied migration or add a model
without generating its migration — CI will reject it.

---

## Backups and Restore

The database holds every user's journal. A journal-first product that loses a
user's journal has destroyed the only thing it asked them to trust it with, so
this section is written to be followed by someone who did not set the system up,
on the worst day of the project.

### Read this first: a backup without the keys is not a backup

Journal text is stored as ciphertext (see
[Journal Encryption at Rest](#journal-encryption-at-rest)). The keys that
decrypt it are **not in the database and not in any database backup** — they
live in the `JOURNAL_ENCRYPTION_KEYS` service variable, which is part of the
Railway service configuration, not part of the Postgres volume.

**A database backup restored without those keys is unrecoverable.** Not "hard to
read", not "needs a specialist" — the ciphertext is the only copy of the user's
writing and Fernet has no recovery path. A restore that reaches this state fails
loudly rather than handing back garbage:

```
encrypted journal content found but JOURNAL_ENCRYPTION_KEYS is not configured
```

So key custody is part of backup custody, and it cuts both ways:

- **Keys must survive whatever kills the database.** The Railway variable store
  dies with the Railway account. There must be a second copy of every key ever
  used — current *and* rotated-out — held somewhere the platform outage cannot
  reach: a password manager entry or an offline escrow. `[HUMAN ACTION]` —
  establishing that escrow is not something a deploy can do for you, and it is
  tracked in issue #2319 until it is.
- **Keys must never be stored with the backup.** A dump and its keys in the same
  bucket, archive, or download folder is one compromise away from being
  plaintext, which defeats the encryption entirely. Different system, different
  credentials.
- **Keep retired keys.** Rows re-encrypt lazily, so a restored backup can carry
  rows written under a key that production stopped using months ago. Discarding
  a key discards every un-rewritten row that needed it.

`SECRET_KEY` is in the same category, with a smaller blast radius: losing it
invalidates every issued JWT (everyone is logged out) but destroys no data.

### What is backed up, on what schedule, and where it lands

Two independent legs, because each one fails in a way the other survives.

| Leg | Mechanism | Schedule | Retention | Survives |
| --- | --- | --- | --- | --- |
| Platform | Railway volume backup, configured per-database in the service's **Backups** tab | Daily | 6 days | Dropped table, bad migration, accidental delete |
| Off-host | `pg_dump -Fc`, encrypted, copied off Railway | Weekly | 90 days | Railway account loss, project deletion, region loss |

**Railway's own backups are not off-host in the sense that matters.** They are
copy-on-write volume backups restorable only **into the same project and
environment**, with no documented export path. That makes them excellent for the
mistakes you make and useless for the platform going away — which is exactly why
the second leg exists. Railway's own schedule choices are Daily (kept 6 days),
Weekly (kept 1 month), and Monthly (kept 3 months); pick Daily.

`[HUMAN ACTION]` to enable the platform leg: Railway dashboard → Postgres
service → **Backups** → set schedule to Daily → confirm a backup appears within
24 hours. Nothing in this repository can turn it on for you; issue #2319 tracks
it until someone does.

**Recovery point objective (RPO): 24 hours.** Up to a day of writing can be lost
in a total-loss scenario. **Recovery time objective (RTO): 1 hour** — the time
from deciding to restore to the app serving reads again. Both are modest on
purpose; a smaller RPO means continuous archiving (WAL shipping), which is not
configured and should not be claimed.

### Taking an off-host dump

**Use the public connection string, not the injected one.** The `DATABASE_URL`
Railway injects into the backend service points at `postgres.railway.internal`,
which resolves only from inside the project's private network — a laptop cannot
reach it, and neither can `railway run`. For an external dump, take
`DATABASE_PUBLIC_URL` (the TCP-proxy address, `…proxy.rlwy.net:<port>`) from the
Railway dashboard → PostgreSQL service → **Variables**. Paste it into the shell
rather than committing it anywhere.

`umask 077` first, so the dump is never world-readable — not even for the
seconds before it is encrypted.

```bash
umask 077
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

# Paste DATABASE_PUBLIC_URL here; do not persist it in a dotfile or history.
read -rs PGURL && export PGURL

pg_dump "$PGURL" -Fc -f "adepthood-$STAMP.dump"

# Encrypt before it leaves the machine. Passphrase lives in the password
# manager, NOT beside the file and NOT with JOURNAL_ENCRYPTION_KEYS.
gpg --symmetric --cipher-algo AES256 "adepthood-$STAMP.dump"
shred -u "adepthood-$STAMP.dump" 2>/dev/null || rm -P "adepthood-$STAMP.dump"
```

Then copy `adepthood-$STAMP.dump.gpg` to storage that is not Railway. The
custom format (`-Fc`) is required: it is what `pg_restore` reads, it compresses,
and it lets you restore selectively.

> This leg is **manual today**. It is written down honestly rather than
> described as automated: a weekly calendar reminder is the current mechanism,
> and automating it needs a credential store and a destination bucket that do
> not yet exist.

### Restoring, step by step

The single most important rule: **restore into a fresh, empty database.** Never
into one that already has tables. See the failure table below for what that
costs.

1. **Stop writes.** Take the backend service down from the Railway dashboard
   (removing the active deployment is enough) before touching the data.
   Restoring under live traffic produces a database that disagrees with itself.
2. **Provision an empty target**, and name it once so every later step reaches
   the same database. For a new Railway Postgres these come from its
   `DATABASE_PUBLIC_URL`; locally they are your own cluster's.
   ```bash
   HOST=localhost; PORT=5432; USER="$(whoami)"; TARGET_DB=adepthood_restored

   createdb -h "$HOST" -p "$PORT" -U "$USER" "$TARGET_DB"
   ```
3. **Decrypt the dump** (off-host leg only): `gpg --decrypt adepthood-<stamp>.dump.gpg > restore.dump`
4. **Restore.** `--exit-on-error` is not optional: without it `pg_restore`
   reports success-ish while skipping objects it could not create.
   ```bash
   pg_restore -h "$HOST" -p "$PORT" -U "$USER" -d "$TARGET_DB" \
     --no-owner --no-privileges --exit-on-error restore.dump
   ```
5. **Check the schema revision the dump carried.** The `alembic_version` table
   travels inside the dump, so a restored database announces its own revision:
   ```bash
   psql -h "$HOST" -p "$PORT" -U "$USER" -d "$TARGET_DB" \
     -c "SELECT version_num FROM alembic_version;"
   ```
   Compare it to the deployed code's head (`alembic heads` in `backend/`).
6. **Reconcile the revision** — see "When the backup and the code disagree".
7. **Supply the keys.** Set `JOURNAL_ENCRYPTION_KEYS` on the service that will
   read this database, listing **every key that could have encrypted a row in
   this dump**, newest first. The current production key alone is not enough if
   the dump predates a rotation.
8. **Verify before cutting over** (next section). A restore is not finished when
   `pg_restore` exits; it is finished when a journal entry decrypts.
9. **Point the app at it** and bring the backend service back up. Watch the boot
   log for `journal_encryption_enabled=True` and `/health` for
   `{"status": "healthy", "database": "connected"}`.

### Verifying a restore

Three questions SQL can answer, and a fourth it cannot. The fourth is the only
one that actually proves the restore.

```sql
-- 1. Did the rows arrive?
SELECT count(*) FROM "user";
SELECT count(*) FROM journalentry;

-- 2. Is the journal text still encrypted (not silently blanked or mangled)?
--    Encrypted values carry the marker `enc::v1::`; anything else is a
--    pre-encryption legacy row.
SELECT count(*) FILTER (WHERE message LIKE 'enc::v1::%') AS encrypted,
       count(*) FILTER (WHERE message NOT LIKE 'enc::v1::%') AS plaintext
FROM journalentry;

-- 3. What revision does this database think it is at?
SELECT version_num FROM alembic_version;
```

The fourth question — *did the writing survive?* — cannot be answered in SQL,
because SQL only ever sees the ciphertext. **Read one entry back through the
application with the keys configured**: the `EncryptedString` column type
decrypts on read, so an entry
that comes back as prose is proof that the dump, the restore, and the key list
all agree. An entry that raises is proof they do not.

### When the backup and the code disagree

| Situation | What you see | What to do |
| --- | --- | --- |
| Backup **older** than the deployed code | `column "display_name" of relation "user" does not exist` (or any `UndefinedColumnError`) the moment the app writes | Run `alembic upgrade head` against the restored database *before* pointing the app at it. Forward migration of restored data is the supported path and was exercised in the drill below. |
| Backup **newer** than the deployed code | `alembic_version` names a revision absent from `migrations/versions/` | Deploy the commit that contains that revision first. Do **not** `alembic downgrade` to make it fit — that discards columns, and the data in them. |
| Restored into a **non-empty** database | `relation "…" already exists`, then `pg_restore: warning: errors ignored on restore: N`, exit code 1 | Do not try to salvage it. Drop the database, create an empty one, restore again. A partially-merged restore can look plausible and be wrong. |
| Keys missing | `encrypted journal content found but JOURNAL_ENCRYPTION_KEYS is not configured` | Set the variable and restart. The data is fine; the reader is not. |
| Keys wrong or incomplete | `journal ciphertext failed to decrypt (key rotated out?)` | A key that encrypted some rows is missing from the list. Add the retired key. There is no other fix. |

### The proven restore (drill record)

- **Date performed:** 2026-08-21
- **Schema at drill time:** `c2d3e4f5a6b8`
- **Performed against:** a scratch PostgreSQL 16.15 cluster on a developer
  laptop — *not* production, and not Railway.

What was run, and what was observed:

1. `alembic upgrade head` against an empty Postgres 16 database — the whole
   migration history applied cleanly, ending at `c2d3e4f5a6b8`.
2. Seeded one user and one journal entry through the application's own models,
   with `JOURNAL_ENCRYPTION_KEYS` set to a throwaway Fernet key. The entry
   carried a tz-aware timestamp and a `vault_tags` JSON array containing
   non-ASCII text (`✨ éñ`).
3. Read the row with raw SQL, bypassing the ORM: `message` was
   `enc::v1::gAAAAAB…` — genuinely ciphertext at rest, not a flag.
4. `pg_dump -Fc` → a 143,900-byte custom-format dump.
5. `createdb` + `pg_restore --no-owner --no-privileges --exit-on-error` into a
   fresh database — **exit 0, no warnings**.
6. In the restored database: the raw `message` ciphertext was **byte-identical**
   to the source, `vault_tags` came back as a JSON array with its non-ASCII text
   intact, the timestamp kept its UTC offset, and `alembic_version` read
   `c2d3e4f5a6b8` — the revision travelled inside the dump.
7. Read back through the ORM **with the key**: the plaintext matched the seeded
   string exactly.
8. Read back **with no key**: raised `encrypted journal content found but
   JOURNAL_ENCRYPTION_KEYS is not configured`.
9. Read back **with a different valid key**: raised `journal ciphertext failed
   to decrypt (key rotated out?)`. Steps 8 and 9 are the empirical basis for the
   warning at the top of this section.
10. Older-backup drill: seeded a second database at revision `c7d8e9f0a1b3`,
    dumped it, restored into a fresh database (exit 0), ran `alembic upgrade
    head` (9 revisions applied), and confirmed the entry written under the old
    schema still decrypted correctly at head.
11. Non-empty-target drill: re-ran `pg_restore` into the already-restored
    database. Exit 1, 249 errors ignored, 210 of them `already exists`. Row
    counts happened to survive intact, which is precisely why this state is
    dangerous — it looks fine and is not trustworthy.

**What this drill did not prove.** It ran against a local cluster, so the
Railway-side restore path (steps 1 and 2 of the procedure), the encrypted
off-host copy, and the platform Backups tab are documented from Railway's
reference and from the local drill's logic — not from a production rehearsal.
The next drill should be run against a Railway staging database restored from a
real platform backup, and this record updated with its date.

---

## Wallet Audit Hardening (Post-Deploy)

The `walletaudit` table is the forensic record for every wallet mutation
(spends, grants, monthly resets). The schema migration deliberately does
**not** include a role-specific `GRANT`/`REVOKE` — role names differ
between CI (`aptitude`) and production (`adepthood`) and a hardcoded name
would break one of them. Apply the append-only lock manually once per
environment, immediately after the first deploy that creates the table:

```sql
-- Run as the database owner / superuser, substituting your app role:
REVOKE UPDATE, DELETE ON walletaudit FROM adepthood;
```

After this, a compromised application credential can still *insert* audit
rows (normal operation) but cannot rewrite or erase history. Verify with:

```sql
SELECT privilege_type
FROM information_schema.role_table_grants
WHERE table_name = 'walletaudit' AND grantee = 'adepthood';
-- Expect INSERT and SELECT only — no UPDATE, no DELETE.
```

Issue #272 tracks the decision to keep this as a deploy-time recipe rather
than a migration.

## Journal Encryption at Rest

Journal entry text is encrypted in the database column with Fernet keys read
from `JOURNAL_ENCRYPTION_KEYS`. **Key presence is the switch**: with no key
configured the column is plaintext, which is the right default on a laptop and
unacceptable on a server. So a boot with `ENV=production` and no key **fails**,
naming the variable — the deploy never goes live rather than quietly storing
every user's writing in the clear.

Outside production an empty value is normal and silent: requiring a key to run a
local server or the test suite would be friction with no security benefit.

**Generate a key:**
```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Paste the output as the value. Treat it exactly like `SECRET_KEY`: it is held
only in the platform's variable store, never committed, never logged (the
startup failure names the variable and never its contents), and never shared
across environments — a staging key that reaches production means one leak
compromises both.

**Rotation.** The variable is plural because rotation is comma-separated:

```
JOURNAL_ENCRYPTION_KEYS=<new-key>,<previous-key>
```

The **first** key encrypts every new write; **every** listed key can decrypt. So
a rotation is: generate a new key, prepend it, redeploy. The registry is cached
per worker, so the change takes effect on restart — rotation is a deploy-time
operation, not a runtime one.

Rows re-encrypt lazily, on their next write. Nothing rewrites the corpus for
you, so **keep the previous key listed** until you are willing to lose whatever
has not been rewritten under the new one. Dropping a key that some row still
needs does not degrade to plaintext and does not return the ciphertext as if it
were the user's text — the read raises. There is no recovery from a discarded
key: the ciphertext is the only copy.

**A malformed key fails fast in every environment**, production or not. A typo
is never re-read as "encryption is off".

**Verify after deploy.** The boot log carries one line per worker:

```
journal_encryption_enabled=True
```

`False` in a production log means the deploy predates this check or `ENV` is not
`production` — either way, journals are being written in the clear.

## Environment Variables Reference

### Backend

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ENV` | Yes | `development` | `development`, `staging`, or `production` |
| `SECRET_KEY` | Yes | `replace-me` | JWT signing key. Generate with `python -c "import secrets; print(secrets.token_urlsafe(32))"` |
| `JOURNAL_ENCRYPTION_KEYS` | Yes in prod | *(empty)* | Comma-separated urlsafe-base64 Fernet keys encrypting journal text at rest. The first encrypts, every listed key can decrypt. Empty means plaintext columns, so `ENV=production` without it refuses to boot; outside production empty is the normal local state. An invalid key fails fast in every environment. See [Journal Encryption at Rest](#journal-encryption-at-rest). |
| `PROD_DOMAIN` | In prod/staging | — | Comma-separated HTTPS origins for CORS (e.g., `https://app.adepthood.com`) |
| `BOTMASON_PROVIDER` | No | `stub` | AI backend: `stub`, `openai`, or `anthropic` |
| `LLM_API_KEY` | If not stub | — | API key for the chosen LLM provider |
| `LLM_MODEL` | No | Provider default | `gpt-4o-mini` (OpenAI) or `claude-sonnet-4-20250514` (Anthropic) |
| `WEB_CONCURRENCY` | No | `2` | Number of Uvicorn worker processes |
| `TRUSTED_PROXY_CIDRS` | Recommended in prod | *(empty)* | Comma-separated IPs/CIDRs of the reverse proxies you operate, e.g. the platform ingress range. Until it is set, `X-Forwarded-For` is ignored (every client behind the ingress shares one rate-limit bucket and one audited IP) and `X-Forwarded-Proto` is untrusted, so redirects and absolute URLs stay `http://`. Never list a public range you do not control. |
| `GOOGLE_OAUTH_CLIENT_IDS` | For Google sign-in | *(empty)* | Comma-separated Google OAuth client IDs the backend will accept ID tokens for (web + iOS + Android). Empty means every Google token is rejected, which is why the buttons appear to do nothing. |
| `APPLE_OAUTH_CLIENT_IDS` | For Apple sign-in | *(empty)* | Comma-separated audiences accepted on Apple identity tokens — for this app the iOS bundle identifier, since Apple sign-in is offered only on iOS. Empty means every Apple token is rejected. |
| `IPV6_THROTTLE_PREFIX_LEN` | No | `64` | Bit length of the IPv6 prefix that throttle keys (the rate limiter and the invalid-license throttle) group on, so one subscriber's delegated address range can't mint one bucket per address. Audit rows always keep the full address regardless. Valid range `1`-`128`; anything else falls back to the default rather than being clamped. A smaller number covers a larger delegation: lower it to `56`/`48` if you see IPv6 abuse, raise it to `128` to restore per-address keying (which reopens the bypass). |
| `BOTMASON_SYSTEM_PROMPT` | No | Built-in | Path to prompt file or inline text |
| `EMAIL_BACKEND` | No | `console` | `console` (logs the email locally) or `smtp` (delivers via SMTP). Required: `smtp` in production. |
| `SMTP_HOST` | If `EMAIL_BACKEND=smtp` | — | SMTP relay hostname, e.g. `smtp.sendgrid.net` |
| `SMTP_PORT` | If `EMAIL_BACKEND=smtp` | — | SMTP port. **Only STARTTLS-on-587 is supported** -- the adapter calls `starttls()` unconditionally. Implicit-TLS port 465 (SMTPS) will silently fail to deliver because the connection negotiation skips the STARTTLS step. Use port 587. |
| `SMTP_USERNAME` | If `EMAIL_BACKEND=smtp` | — | SMTP relay username |
| `SMTP_PASSWORD` | If `EMAIL_BACKEND=smtp` | — | SMTP relay password / API key |
| `EMAIL_FROM` | If `EMAIL_BACKEND=smtp` | — | RFC-5322 "From" address (e.g. `noreply@adepthood.example`). Must be a **monitored** mailbox -- the change-notification "this wasn't me" replies route here, and bounce-handling for invalid recipient addresses also lands here. |
| `SECURITY_CONTACT_ADDRESS` | No (recommended in prod) | `security@adepthood.example` | Address printed inside the change-notification email body so users with a compromised account have somewhere to escalate. Set this to a real, monitored mailbox before launching publicly. |
| `SENTRY_DSN` | No (recommended in prod) | *(empty)* | Sentry DSN unhandled exceptions are reported to. Empty means no vendor: crashes are still caught, still answered with the sanitised 500 envelope, and still logged in full — only the operator inbox is lost. A value that will not parse degrades the same way with one boot warning; it never fails the deploy. See "Error monitoring" below for what a report does and does not contain. |
| `SENTRY_RELEASE` | No | `RAILWAY_GIT_COMMIT_SHA`, else `unknown` | Version string every event is tagged with, so a regression can be pinned to a deploy. `ENV` is sent as the Sentry environment, which is what keeps a production alert distinguishable from a staging one. |

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
| `EXPO_PUBLIC_GUMROAD_PRODUCT_URL` | No | Gumroad product page opened by the Get Started CTA. Defaults to `https://adepthood.gumroad.com/l/aptitude`. |
| `EXPO_PUBLIC_GUMROAD_HELP_URL` | No | Gumroad help article linked from the signup form's "Where's my key?" link. Defaults to `https://help.gumroad.com/article/76-license-keys`. |
| `EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB` | For Google sign-in on web | Google **Web application** client ID. Baked in at build time and declared as an `ARG` in `frontend/Dockerfile`; unset means "Continue with Google" never renders. |
| `EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS` | For Google sign-in on iOS | Google **iOS** client ID. Consumed by EAS native builds, not the web Dockerfile. |
| `EXPO_PUBLIC_GOOGLE_CLIENT_ID_ANDROID` | For Google sign-in on Android | Google **Android** client ID. Consumed by EAS native builds, not the web Dockerfile. |
| `EXPO_PUBLIC_SANGHA_INVITE_URL` | No | Permanent, never-expiring Discord invite for the Digital Sangha, opened from Settings in the platform browser. Must be `https`; anything else resolves to nothing. There is deliberately no default — unset means the app never mentions the Sangha, which is an absent invitation rather than a dead link inside a shipped binary. |
| `EXPO_PUBLIC_SENTRY_DSN` | No (recommended in prod) | Sentry DSN that crashes caught by the error boundaries are reported to. Baked in at build time like every other `EXPO_PUBLIC_*` value, so it is public — use a client DSN, never a server one. Unset means crashes go to the console only. |
| `EXPO_PUBLIC_SENTRY_ENVIRONMENT` | No | Sentry environment for client reports. Defaults to `development` in dev builds and `production` otherwise. |
| `EXPO_PUBLIC_SENTRY_RELEASE` | No | Version string client reports are tagged with. Defaults to `unknown`. |

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

## Password Recovery

The forgotten-password flow needs an email path to ship reset links.
The backend defaults to a console adapter that simply logs the rendered
email -- safe in dev / test, useless in production. Set
`EMAIL_BACKEND=smtp` plus the five `SMTP_*` / `EMAIL_FROM` variables
above to switch on real delivery.

Recommended setup with SendGrid:

```bash
EMAIL_BACKEND=smtp
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USERNAME=apikey                # literal string "apikey"
SMTP_PASSWORD=<sendgrid_api_key>    # the API key itself
EMAIL_FROM=noreply@yourdomain.example
SECURITY_CONTACT_ADDRESS=security@yourdomain.example
```

The `EMAIL_FROM` address must be:

1. **DKIM/SPF-verified** with the provider. Without verification,
   deliverability collapses for any address the recipient's spam
   filter has not seen before -- which for password recovery means
   the user never gets the link.
2. **Monitored**. Bounce notifications for invalid recipient addresses
   route back to this mailbox, and a user replying to the
   change-notification email lands here too. An unmonitored "noreply"
   address loses both signals.

`SECURITY_CONTACT_ADDRESS` is the inbox printed inside the
change-notification email body so a user whose account was reset
without their consent has an escalation path. Set it to a real,
monitored security inbox before launching to real users; the default
(`security@adepthood.example`) is a placeholder for dev / first-deploy.

Verify the wiring after deploy by hitting `/auth/password-reset/request`
with a known-registered address and confirming the link lands in the
inbox.  The corresponding runbook lives at `RECOVERY-RUNBOOK.md`
(operator-facing: how to investigate a reset that did not arrive).

### Trusted Proxy / X-Forwarded-For

`X-Forwarded-For` is honored only when the socket peer is inside
`TRUSTED_PROXY_CIDRS` (see the variable reference above for the
exact format).  The default is empty, and the resolver **fails
closed**: with nothing configured the header is ignored entirely,
and rate limiting, the invalid-license throttle, and the login /
password-reset audit rows (`LoginAttempt.ip_address`,
`PasswordResetToken.requested_ip`) all key on the raw socket peer
instead -- which behind any real ingress means every client shares
one rate-limit bucket and one audited address.

The same variable governs whether `X-Forwarded-Proto` is trusted.
Until it is set, the app believes it is serving `http`, so the
trailing-slash redirect and any absolute URL it builds stay
`http://` -- which browsers refuse to follow cross-origin.  A
production boot without it set logs a `trusted_proxies_unconfigured`
warning at startup.

Both decisions are taken inside the application, against this one
variable: the forwarded-proto middleware for the scheme, `client_ip`
for the address.  The runtime image starts uvicorn with
`--no-proxy-headers` on purpose.  The explicit negative is required:
that switch is the flag pair `--proxy-headers/--no-proxy-headers`
and it defaults to **enabled**, so merely omitting it leaves
uvicorn's own layer mounted and trusting loopback.  While that layer
is mounted it rewrites the socket peer from the left-most,
caller-chosen `X-Forwarded-For` entry as well as the scheme, before
any application code runs and under a second trust set the app never
sees.

Do **not** set `FORWARDED_ALLOW_IPS`.  It is an environment variable
uvicorn reads directly (a common PaaS copy-paste), and it is the way
that server-side layer gets widened without any flag appearing in
the image's `CMD`.  `--no-proxy-headers` disarms it, and the
application ignores it entirely: `TRUSTED_PROXY_CIDRS` is the only
forwarding trust set that has any effect here.

The innermost trusted proxy must still **set** (replace)
`X-Forwarded-Proto` to the client-facing scheme as a single value
(`proxy_set_header X-Forwarded-Proto $scheme;` in nginx) rather than
pass the caller's through.  The middleware takes the *last* field
line, which is the proxy's only if the proxy actually writes one; a
trusted proxy -- or an L4 hop -- that forwards the caller's header
unmodified hands the caller the scheme, because the caller's line is
then the only line.  `proxy_set_header` replaces, which is why it is
the safe form.  A proxy that appends to an existing header instead
produces a comma-joined value, which is ignored, and the redirect
then falls back to `http://`.  When several field lines arrive, the
last one wins, and only `http`, `https`, `ws`, and `wss` are
accepted.

For self-managed deployments, terminate TLS at a proxy (nginx,
Caddy, Cloudflare) that strips inbound `X-Forwarded-For` and appends
the real peer address, then list only that proxy in
`TRUSTED_PROXY_CIDRS`.  That variable accepts only IP addresses and
CIDR blocks, so the proxy has to reach the app over TCP: a proxy
connected over a unix socket has no IP peer, can never be trusted,
and its `X-Forwarded-Proto` is ignored (redirects stay `http://`).
Operators investigating an abuse report should treat the audit
`ip_address` as authoritative only to the extent the ingress chain,
and this configuration, are trusted.

Once a peer address is resolved, the rate limiter and the
invalid-license throttle key on it a little differently than the
audit rows do: an IPv6 address is grouped onto its delegated prefix
(`IPV6_THROTTLE_PREFIX_LEN`, default `64`) rather than kept exact,
because a residential or cloud subscriber owns an entire delegated
prefix and could otherwise rotate through it to mint one throttle
bucket per address and never trip the cap.  IPv4 is never affected
-- one client, one address.  This changes throttle keys only: the
audit rows (`LoginAttempt.ip_address`,
`PasswordResetToken.requested_ip`) always record the exact address,
never the prefix, so an operator tracing an abusive IP in the audit
log will not find it truncated.  The value IS the prefix length, so
a *smaller* number covers a *larger* delegation.  An integer outside
`1`-`128`, or a non-integer, falls back to the default of `64`
rather than being clamped, since silently disabling the grouping is
worse than ignoring a typo.

`64` is the *smallest* delegation a subscriber receives, not the
typical one.  A customer handed a `/56` still holds 256 `/64`s and a
`/48` holds 65,536, so the hourly caps are divided by that much for
them and the same rotation works one level up.  If you see licence
grinding or signup abuse from IPv6, `IPV6_THROTTLE_PREFIX_LEN=56`
(or `48`) is the lever.  The default stays at `64` because widening
it for everyone would merge unrelated customers on any ISP that does
delegate a `/64` each -- the collateral this setting is deliberately
avoiding on the IPv4 side.

The grouping cuts the other way too, and it is worth knowing before
you debug a support ticket.  A `/64` is exactly one LAN, so an
office or campus on SLAAC, a VPN exit pool, or a NAT64/CGN pool is a
single throttle bucket for all of its users -- against the 60/minute
global default, 5/minute login, and 3/hour password reset.  That is
the same treatment those users would already get behind a NATted
IPv4 address, but it is a change from per-address keying.  If such a
site is your traffic and you see spurious `429`s, setting `128`
restores exact per-address keying, at the cost of reopening the
address-rotation bypass this setting exists to close.

---

## Monitoring and Operations

### Health check

Railway pings `GET /health` every 30 seconds. A healthy response:
```json
{"status": "healthy", "database": "connected"}
```

A 503 means the database is unreachable.

### Error monitoring

Both sides report unhandled errors to **Sentry** when a DSN is configured
(`SENTRY_DSN` on the backend, `EXPO_PUBLIC_SENTRY_DSN` on the frontend), and
run normally with one startup line when it is not. Grep the boot log for
`error_monitoring_enabled` / `error_monitoring_disabled` to see which state a
deployment is in.

Sentry is therefore a **third-party recipient of adepthood error reports**, and
the privacy policy has to say so. What a report carries is deliberately narrow:

- **Backend** — exception type, a credential-redacted and length-capped
  message, the stack (file, function, line, source context), and the request
  id / path / method. Every automatic capture channel is switched off:
  no ASGI, logging, or HTTP instrumentation is installed at all, local
  variables are not captured, request bodies are never captured, and the
  breadcrumb buffer is sized to zero. A `before_send` scrubber then deletes
  `request`, `extra`, `breadcrumbs` and frame `vars` wherever they appear.
- **Frontend** — exception type, a credential-redacted and length-capped
  message, the React component stack, and which error boundary caught it. The
  payload is built field by field, so there is no channel for anything else;
  there are no breadcrumbs anywhere in the design.
- **Neither** — no journal, transcription or reflection content, no request
  bodies, no credentials, and no user identity (not even an opaque id today).

The one field neither side can close by configuration is an exception message,
because it is authored at the throw site. Keep raised messages static and
capability-named, the way `backend/src/dependencies/creek_vault.py` does; the
length cap is a bound on that discipline slipping, not a substitute for it.

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
- [ ] `JOURNAL_ENCRYPTION_KEYS` holds a freshly generated Fernet key, unique to this environment
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
