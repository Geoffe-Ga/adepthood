# ---- Build stage ----
FROM node:20-slim AS builder

WORKDIR /app

# NOTE: Railway's build context for this Dockerfile is the repo root (the
# `dockerfilePath` in frontend/railway.toml is `frontend/Dockerfile`, and
# Railway does not override the service root directory).  All COPY paths
# below are therefore rooted at the repo root and reference `frontend/`
# explicitly.  See frontend/Dockerfile.dockerignore for context exclusions.

# Install dependencies first (layer caching). Dependency patches must already
# be present because npm ci runs patch-package through postinstall.
COPY frontend/package.json frontend/package-lock.json ./
COPY frontend/patches/ ./patches/
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

# And the Digital Sangha's Discord invite, for the third time the same reason.
# This one has no default at all -- undeclared here, `resolveEnv` returns '',
# the resolver refuses to render a door, and the web build ships with the
# Sangha silently missing.
ARG EXPO_PUBLIC_SANGHA_INVITE_URL
ENV EXPO_PUBLIC_SANGHA_INVITE_URL=$EXPO_PUBLIC_SANGHA_INVITE_URL

# Fictional habit history is never a network fallback. It is available only to
# purpose-built demo deployments whose public build configuration says so;
# omitted (the production default) means disabled.
ARG EXPO_PUBLIC_HABIT_DEMO_MODE
ENV EXPO_PUBLIC_HABIT_DEMO_MODE=$EXPO_PUBLIC_HABIT_DEMO_MODE

# The Gumroad URLs were previously left undeclared on the grounds that their
# defaults were safe. That held only while no storefront existed: the default
# named an account subdomain nobody owned, so the pre-auth CTA opened a 404 and
# no Railway variable could correct it, because a Docker build sees only the
# variables this file names. The default is now the real storefront AND the
# override is wired, so moving the store is a variable change plus a rebuild
# rather than a code change.
ARG EXPO_PUBLIC_GUMROAD_PRODUCT_URL
ENV EXPO_PUBLIC_GUMROAD_PRODUCT_URL=$EXPO_PUBLIC_GUMROAD_PRODUCT_URL
ARG EXPO_PUBLIC_GUMROAD_HELP_URL
ENV EXPO_PUBLIC_GUMROAD_HELP_URL=$EXPO_PUBLIC_GUMROAD_HELP_URL

# Export, then stamp every script and stylesheet in the built index.html with
# its sha384 Subresource Integrity hash; the stamp fails the build if any
# served asset is left unhashed, mismatched, inline or foreign (the same two
# steps as `npm run web:build`). Then render nginx.conf's enforced CSP: its
# connect-src names the API origin (and the Sentry origin, when a DSN is set)
# from the same EXPO_PUBLIC_* values the bundle was just built with, and the
# render refuses to produce a conf without an https API origin. ADR 0009
# phase (b), #3067.
RUN npx expo export --platform web
# Railway exposes this platform commit only when declared as a build ARG.
# Stamp independently of Sentry labels and the backend's served release.
ARG RAILWAY_GIT_COMMIT_SHA
RUN node web-hardening/build-receipt.js dist
RUN node web-hardening/sri.js stamp dist
RUN node web-hardening/csp.js nginx.conf nginx.rendered.conf

# ---- Serve stage ----
FROM nginx:1.27-alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY --from=builder /app/nginx.rendered.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
