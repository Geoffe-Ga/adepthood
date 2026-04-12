# --- Build stage ---
FROM python:3.12-slim AS builder

WORKDIR /app

# Install system dependencies for asyncpg
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc libpq-dev && \
    rm -rf /var/lib/apt/lists/*

COPY requirements-lock.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements-lock.txt

# --- Runtime stage ---
FROM python:3.12-slim

WORKDIR /app

# Runtime dependency for asyncpg
RUN apt-get update && \
    apt-get install -y --no-install-recommends libpq5 && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /install /usr/local
COPY src/ src/

# Copy Alembic config if present. The trailing glob makes the COPY a no-op
# when the file is absent, which is the current state (Alembic hasn't been
# initialized yet).
COPY alembic.ini* ./

# Ensure migrations/ always exists so `alembic upgrade head` has a stable
# target once Alembic is configured. We create it here rather than COPYing
# from the build context because BuildKit on some platforms (e.g. Railway)
# strips directories that contain only hidden files from the context, which
# causes `COPY migrations/ migrations/` to fail with "/migrations: not found".
# Once `alembic init migrations` lands real files in backend/migrations/, add:
#     COPY migrations/ migrations/
# back to this Dockerfile so the migration files make it into the image.
RUN mkdir -p migrations

# Create non-root user
RUN useradd --create-home appuser
USER appuser

EXPOSE 8000

# Run migrations (when alembic.ini is present) then start the server
CMD ["sh", "-c", "if [ -f alembic.ini ]; then python -m alembic upgrade head; fi && python -m uvicorn src.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers ${WEB_CONCURRENCY:-2}"]
