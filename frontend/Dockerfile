# ---- Build stage ----
FROM node:20-slim AS builder

WORKDIR /app

# NOTE: Railway's build context for this Dockerfile is the repo root (the
# `dockerfilePath` in frontend/railway.toml is `frontend/Dockerfile`, and
# Railway does not override the service root directory).  All COPY paths
# below are therefore rooted at the repo root and reference `frontend/`
# explicitly.  See frontend/Dockerfile.dockerignore for context exclusions.

# Install dependencies first (layer caching)
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# Copy source and build for web
COPY frontend/ ./

# EXPO_PUBLIC_API_BASE_URL is baked into the JS bundle at build time.
# Set it via Railway env vars — it's passed through as a Docker build arg.
ARG EXPO_PUBLIC_API_BASE_URL
ENV EXPO_PUBLIC_API_BASE_URL=$EXPO_PUBLIC_API_BASE_URL

RUN npx expo export --platform web

# ---- Serve stage ----
FROM nginx:1.27-alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
