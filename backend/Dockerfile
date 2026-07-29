# --- Build stage ---
FROM python:3.12-slim AS builder

WORKDIR /app

# Install system dependencies for asyncpg
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc libpq-dev && \
    rm -rf /var/lib/apt/lists/*

# NOTE: Railway's build context for this Dockerfile is the repo root (the
# `dockerfilePath` in backend/railway.toml is `backend/Dockerfile`, and
# Railway does not override the service root directory).  All COPY paths
# below are therefore rooted at the repo root and reference `backend/`
# explicitly.  See backend/Dockerfile.dockerignore for context exclusions.
COPY backend/requirements-lock.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements-lock.txt

# --- Runtime stage ---
FROM python:3.12-slim

WORKDIR /app

# Runtime dependency for asyncpg
RUN apt-get update && \
    apt-get install -y --no-install-recommends libpq5 && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /install /usr/local
COPY backend/src/ src/

# Source files use top-level absolute imports (`from database import ...`,
# `from routers.auth import ...`) — consistent with the test harness, which
# prepends `backend/src` to sys.path in conftest.py.  Mirror that for the
# container by exposing /app/src on PYTHONPATH so `python -m uvicorn main:app`
# can resolve those imports at runtime.
ENV PYTHONPATH=/app/src

# Alembic config + migration scripts.  ``alembic upgrade head`` is invoked in
# the CMD below and applies any pending schema changes on every deploy.
# migrations/env.py itself reads DATABASE_URL (normalized to the asyncpg
# driver) and sets ``sqlalchemy.url`` on the Alembic config.
COPY backend/alembic.ini ./
COPY backend/migrations/ migrations/

# Vendored course content (manifest + chapter markdown bodies + assets).  The
# content repository and the startup seeder resolve this at /app/content
# (``parents[2]/content`` from src/services); omitting it leaves the running
# image with no manifest, so ``/health`` reports ``content_version: none`` and
# every stage seeds empty (#773 — the prod symptom of #767).  The matching
# ``!backend/content`` negation in Dockerfile.dockerignore keeps the .md bodies
# from the blanket ``*.md`` exclusion.
COPY backend/content/ content/

# Create non-root user
RUN useradd --create-home appuser
USER appuser

EXPOSE 8000

# Run migrations then start the server.  We import `main:app` (not
# `src.main:app`) because PYTHONPATH is set to /app/src; this matches the
# module layout used in tests.
#
# --proxy-headers lets uvicorn believe X-Forwarded-Proto, which the app needs to
# know it is served over https: without it, redirects (e.g. the trailing-slash
# 307) and any absolute URL it builds downgrade to http://, which browsers
# refuse to follow cross-origin.  --forwarded-allow-ips names the peers allowed
# to assert that, and it reads the same TRUSTED_PROXY_CIDRS the application
# uses, so one setting governs both layers and they cannot drift apart.  A
# wildcard here would trust every forwarding peer and so let any client rewrite
# its own address: uvicorn overwrites the socket peer with the left-most,
# caller-chosen X-Forwarded-For entry, forging rate-limit keys and audit rows
# before application code runs.  The default is loopback, so an unset variable
# fails closed onto the real socket peer -- and, stated plainly, proto trust is
# off in that state too, so the https-dependent redirects above only work once
# an operator sets the variable to the platform's ingress range.
CMD ["sh", "-c", "python -m alembic upgrade head && python -m uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --workers ${WEB_CONCURRENCY:-2} --proxy-headers --forwarded-allow-ips=${TRUSTED_PROXY_CIDRS:-127.0.0.1}"]
