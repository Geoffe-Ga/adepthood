# --- Build stage ---
FROM python:3.12-slim AS builder

WORKDIR /app

# Install system dependencies for asyncpg
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc libpq-dev && \
    rm -rf /var/lib/apt/lists/*

# NOTE: Railway's build context for this Dockerfile is the repo root
# (because railway.toml sets `dockerfilePath = "backend/Dockerfile"` without
# overriding the service root directory). All COPY paths are therefore
# rooted at the repo root and reference backend/ explicitly. See
# backend/Dockerfile.dockerignore for context exclusions.
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

# Copy Alembic config (optional — glob is a no-op when the file is absent).
# Once `alembic init migrations` is run and alembic.ini is committed,
# add `COPY backend/migrations/ migrations/` below so `alembic upgrade head`
# can find the revision scripts. Until then, the CMD guards on the
# presence of alembic.ini and skips migrations entirely.
COPY backend/alembic.ini* ./

# Create non-root user
RUN useradd --create-home appuser
USER appuser

EXPOSE 8000

# Run migrations (when alembic.ini is present) then start the server
CMD ["sh", "-c", "if [ -f alembic.ini ]; then python -m alembic upgrade head; fi && python -m uvicorn src.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers ${WEB_CONCURRENCY:-2}"]
