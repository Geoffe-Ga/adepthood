# Editing Squarespace-Backed Course Content

The Adepthood app pulls every course page from the password-protected
Squarespace site at <https://aptitude.guru>.  This doc covers everything
you need to know to add, remove, or rearrange that content.

## Where things live

| What | File |
| ---- | ---- |
| Stage chapter plans (Beige, Purple, …) and site resource links | `backend/src/content_config.py` |
| Site password env var | `backend/.env` (`SQUARESPACE_SITE_PASSWORD=...`) |
| Database seeder that materialises chapters into `StageContent` rows | `backend/src/seed_content.py` |
| HTTP client that fetches and cleans Squarespace HTML | `backend/src/services/squarespace.py` |
| API endpoints that the app talks to | `backend/src/routers/course.py` |
| In-app reader (WebView) | `frontend/src/features/Course/ChapterReader.tsx` |
| Always-available "From Aptitude Guru" chips | `frontend/src/features/Course/SiteResourcesPanel.tsx` |

## How releases are timed

Each stage runs for `PLAN_DURATION_DAYS = 21` calendar days (see
`backend/src/domain/energy.py`).  Inside that window:

* Chapter `n` (1-indexed) of a stage unlocks on `release_day = n - 1`.
* If a stage ships fewer chapters than 21, the remaining days are a
  catch-up window with no new reading.
* The "daily" pattern is currently the only one supported.  Adding a
  pattern (`weekly`, `front_loaded`, …) means extending
  `build_chapter_release_days()` in `content_config.py`.

Today the Beige stage ships 14 chapters → days 0–13 unlock one new
chapter each, days 14–20 are catch-up.

## Adding chapters to a new stage

1. Publish the Squarespace pages.  Use the slug pattern that
   `content_config.py` expects: `https://aptitude.guru/course/{slug}-{n}`
   where `{n}` runs from 1.
2. Append a `StageContentPlan` entry to `STAGE_PLANS`:

   ```python
   STAGE_PLANS: Final[list[StageContentPlan]] = [
       StageContentPlan(stage_number=1, slug="beige",  chapter_count=14),
       # New →
       StageContentPlan(stage_number=2, slug="purple", chapter_count=10),
   ]
   ```

3. Open `backend/src/seed_content.py` and drop the stage's placeholder
   rows from `_PLACEHOLDER_DEFINITIONS` if any are still listed there —
   the seeder already skips stages that have a plan, so leaving them
   only wastes lines.
4. Restart the backend.  The startup seeder will create one
   `StageContent` row per chapter; subsequent boots are idempotent.

## Reordering or renaming chapters

Two paths, depending on what changed:

* **Renamed the page on Squarespace, slug unchanged** — no action.
  We always hit the same URL.
* **Slug changed** — update `chapter_count` (or the `slug` field on
  the plan).  Restart the backend.  The seeder's reconciliation step
  updates the URL on existing rows in place; rows that were marked read
  stay marked read.

## Removing chapters

Lower `chapter_count` in the relevant plan.  The seeder doesn't delete
the now-orphaned `StageContent` row by itself (deletion would silently
lose `ContentCompletion` rows referencing it).  If you actually want
the row gone, write a one-off migration; otherwise the row simply
stops appearing in the chapter list once `chapter_count` is below its
index.

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
SQUARESPACE_SITE_PASSWORD=ToBeYourOwnGuru
```

* The same string you give Gumroad buyers.
* Rotating: change the Squarespace site password, update the env var,
  redeploy backend.  The frontend never sees the password.
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
