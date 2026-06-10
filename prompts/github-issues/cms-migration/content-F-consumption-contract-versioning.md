# Consumption contract + release versioning

**Repo:** `Geoffe-Ga/aptitude-course` · **Labels:** `spec`
**Epic:** adepthood#388 · **Depends on:** D (manifest), E (CI) · **Pairs with:** adepthood#391 (sync), adepthood#397 (build wiring)

## Role & context

The app vendors a **pinned commit** of this repo (adepthood#391 writes the SHA
to `CONTENT_VERSION`). Both sides need a stable, documented contract so content
can ship independently of app deploys without surprise breakage.

## Goal

Document the consumption contract and adopt a release/versioning convention so
the app can pin, audit, and upgrade content deterministically.

## Tasks

1. Write `CONSUMPTION.md` defining the **published surface** the app may rely
   on: `manifest.json` (with `schema_version`), `markdown/**` bodies referenced
   by `path`, and assets (issue I). Everything else is internal.
2. Define **manifest schema semver** rules: patch = content-only; minor =
   additive fields; major = breaking — coordinated with adepthood#389. State
   the app's compatibility expectation.
3. Adopt **release tagging** (e.g. `content-vYYYY.MM.DD` or semver tags) so the
   app pins a tag/SHA rather than a moving branch; document the cut process.
4. Document the **update handshake**: content PR merges → CI green → tag → app
   bumps pinned SHA (adepthood#391) → redeploy.

## Acceptance criteria

- `CONSUMPTION.md` merged: published surface, semver rules, tagging, handshake.
- A first release tag exists and is referenced by adepthood#391's default pin.
- Breaking-change policy is explicit and cross-linked to adepthood#389.

## Constraints

- Never break the published surface without a major version + coordinated app
  change.
