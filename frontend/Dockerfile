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

# Same deal for the Google web client ID, and it must be declared here for the
# same reason: a Docker build sees none of Railway's service variables unless
# the Dockerfile names them. Without this ARG the value never reaches
# `expo export`, `resolveEnv` returns '', and SocialAuthButtons hides the
# button -- a green deploy with no visible feature and nothing in any log.
#
# Only the _WEB id belongs here. The _IOS and _ANDROID ids are consumed by EAS
# native builds, which never run this Dockerfile; declaring them would be dead
# config that reads as though this image supported native.
ARG EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB
ENV EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB=$EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB

# And again for error monitoring, for exactly the same reason: undeclared here,
# the DSN never reaches `expo export`, `resolveEnv` returns '', and the web
# build reports its crashes to the console of a browser nobody is watching --
# a green deploy that is silently unmonitored. All three are optional; an
# unset DSN is a supported way to run, announced once at startup.
ARG EXPO_PUBLIC_SENTRY_DSN
ENV EXPO_PUBLIC_SENTRY_DSN=$EXPO_PUBLIC_SENTRY_DSN
ARG EXPO_PUBLIC_SENTRY_ENVIRONMENT
ENV EXPO_PUBLIC_SENTRY_ENVIRONMENT=$EXPO_PUBLIC_SENTRY_ENVIRONMENT
ARG EXPO_PUBLIC_SENTRY_RELEASE
ENV EXPO_PUBLIC_SENTRY_RELEASE=$EXPO_PUBLIC_SENTRY_RELEASE

RUN npx expo export --platform web

# ---- Serve stage ----
FROM nginx:1.27-alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
