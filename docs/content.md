# Editing Course Content

Stage-locked chapter metadata is driven by the **vendored content
manifest** (`backend/content/manifest.json`, synced from the
[`aptitude-course`](https://github.com/Geoffe-Ga/aptitude-course) repo —
see ADR 0001 in `docs/adr/`).  Chapter *bodies* are still fetched from
the password-protected Squarespace site until the body-endpoint rewrite
lands; the Squarespace sections below remain operative until then.

## Where things live

| What | File |
| ---- | ---- |
| Vendored chapter metadata (all 10 stages) | `backend/content/manifest.json` (synced; do not hand-edit) |
| Manifest contract + reader | `backend/content/manifest.schema.json`, `backend/src/services/content_repository.py` |
| Sync command (pin bumps) | `backend/scripts/sync_content.py` / `make sync-content REF=<sha>` |
| Manifest → seeder bridge and site resource links | `backend/src/content_config.py` |
| Site password env var | `backend/.env` (`SQUARESPACE_SITE_PASSWORD=...`) |
| Database seeder that materialises chapters into `StageContent` rows | `backend/src/seed_content.py` |
| HTTP client that fetches and cleans Squarespace HTML | `backend/src/services/squarespace.py` |
| API endpoints that the app talks to | `backend/src/routers/course.py` |
| In-app reader (WebView) | `frontend/src/features/Course/ChapterReader.tsx` |
| Always-available "From Aptitude Guru" chips | `frontend/src/features/Course/SiteResourcesPanel.tsx` |

## How releases are timed

Each chapter's `release_day` comes straight from the manifest (set via
YAML frontmatter in the content repo): day `N` means the chapter drips
open `N` days after the user starts the stage, with `0` unlocking
immediately.  Days at the end of a stage with no new chapter are a
catch-up window by design.

## Adding, reordering, renaming, or removing chapters

All of it happens in the **content repo**, not here:

1. Edit the Markdown/frontmatter in `aptitude-course` and merge; the
   content repo regenerates `manifest.json`.
2. Vendor the new pin: `make sync-content REF=<sha>` and commit the
   `backend/content/` diff.
3. Deploy.  The startup seeder reconciles `StageContent` rows from the
   manifest for every stage it ships: new chapters insert, changed
   fields (title-matched within a stage) update in place, and rows that
   were marked read stay marked read.

The seeder never deletes rows (deletion would silently lose
`ContentCompletion` references).  A chapter dropped from the manifest
simply stops being referenced; if you actually want the row gone, write
a one-off migration.

Stages the manifest does not cover yet keep placeholder rows (defined in
`seed_content.py`); they are suppressed automatically once the manifest
ships that stage.

`StageContent.url` holds a local `content://<chapter-id>` reference for
manifest-driven rows — not a fetchable URL.  The body endpoint maps it
back to the vendored Markdown (cms-migration epic #388).

## Adding a "From Aptitude Guru" link

These chips live above the stage metadata and are not stage-gated.
Add to `SITE_RESOURCES` in `content_config.py`:

```python
SITE_RESOURCES: Final[list[SiteResource]] = [
    SiteResource(slug="philosophy", title="Philosophy", description="..."),
    SiteResource(slug="about",       title="About",      description="..."),
    # New →
    SiteResource(slug="faq", title="FAQ", description="Common questions.",
                 path="/faq"),
]
```

* `slug` is the URL trailing segment **and** the URL used by the
  backend to fetch the page.  Pick the Squarespace URL slug.
* `path` is optional — supply it only when the URL doesn't match
  `/{slug}` exactly (e.g. nested paths).

No restart required for the chip list itself (the endpoint reads the
config on every request), but the backend still has to be deployed
before the new chip will appear in the app.

## Site password

The Squarespace site password is a single env var on the backend:

```
SQUARESPACE_SITE_PASSWORD=<set-from-team-secrets-manager>
```

* The live value matches the password Gumroad buyers receive. Read it
  from the team secrets manager (1Password / Doppler / Railway env).
  **Never commit the literal value to this repo** — git history is
  forever, and rotating Squarespace's password does not retroactively
  invalidate the value in old commits.
* Rotating: change the Squarespace site password, update the secret in
  the secrets manager, redeploy backend.  The frontend never sees the
  password.
* If the password is missing or wrong, every chapter endpoint returns
  `503 cms_auth_failed` and the in-app reader shows
  "The course site password is not set on the server. Reach out so we
  can fix it."  This is intentional: an attacker can tell something
  went wrong, but not which env var or how to fix it.

## Cache

Cleaned chapter HTML is cached in-process for one hour by default
(override with `SQUARESPACE_CACHE_TTL_SECONDS`).  Bouncing the backend
clears the cache; there is no admin endpoint to nuke a single URL.
For ad-hoc invalidation during development, restart `uvicorn`.

## Local development

You can develop the app without a real Squarespace site by setting:

```
SQUARESPACE_SITE_PASSWORD=anything-non-empty
SQUARESPACE_BASE_URL=http://127.0.0.1:9000
```

…and pointing the `BASE_URL` at a local server that returns plausible
HTML.  The service's SSRF guard means it rejects URLs outside the
configured base, so you can't accidentally hit production while iterating.

## Testing

* Backend service:   `backend/tests/test_squarespace_service.py`
* Backend endpoints: `backend/tests/test_squarespace_endpoints.py`
* Seeder:            `backend/tests/test_seed_content.py`
* Frontend reader:   `frontend/src/features/Course/__tests__/ChapterReader.test.tsx`
* Resource panel:    `frontend/src/features/Course/__tests__/SiteResourcesPanel.test.tsx`

All three suites mock the HTTP layer — no test ever hits the real
Squarespace site.
