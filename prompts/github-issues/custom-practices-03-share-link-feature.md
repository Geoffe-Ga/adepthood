# custom-practices-03: Practice share-link feature

**Labels:** `enhancement`, `ritual-practice`, `backend`, `frontend`
**Epic:** [Customizable practices](custom-practices-epic.md)
**Depends on:** none
**Estimated LoC:** ~400

## Role

You are a full-stack engineer building a private-share mechanism: one user generates a token for a practice they own; another user opens a link with that token and imports a copy into their own catalog.

## Goal

A user with a custom practice can tap **Share**, generate a one-time-or-multi-use link, and send it. The recipient opens the link, sees a preview of the practice (name, mode, config summary), and taps **Import** to copy the practice into their own catalog as an unapproved draft owned by them.

## Context

The infrastructure for "copy a practice owned by user A into user B's catalog" doesn't exist today, but the building blocks do:
- `POST /practices` already creates `approved=False, submitted_by_user_id=<self>` rows (`backend/src/routers/practices.py:88-129`).
- The visibility filter (`backend/src/dependencies/ownership.py:155-168`) already restricts `approved=False` rows to the owner — so an imported copy is automatically private to the recipient.

What's missing: a token table, generate/redeem endpoints, and the share/import UI.

## Tasks — Backend

1. **New model `PracticeShareLink`** at `backend/src/models/practice_share_link.py`:
   - `id: int` PK
   - `token: str = Field(index=True, unique=True, max_length=64)` — URL-safe base64
   - `practice_id: int = Field(foreign_key="practice.id", index=True)`
   - `created_by_user_id: int = Field(foreign_key="user.id", index=True)`
   - `created_at: datetime`
   - `expires_at: datetime | None` — null = never expires
   - `max_uses: int | None = Field(default=None, ge=1, le=1000)` — null = unlimited
   - `use_count: int = Field(default=0, ge=0)`
   - `revoked_at: datetime | None`

2. **Alembic migration** for the new table.

3. **Schemas** at `backend/src/schemas/practice_share.py`:
   - `ShareLinkCreateRequest` (`expires_in_days: int | None`, `max_uses: int | None`)
   - `ShareLinkResponse` (`token, share_url, expires_at, max_uses, use_count`)
   - `ShareLinkPreviewResponse` (`practice_name, mode, default_duration_minutes, description, created_by_display_name, expires_at, remaining_uses`)
   - `ShareLinkImportResponse` (`imported_practice_id`)

4. **Router** at `backend/src/routers/practice_share.py`:
   - `POST /practices/{practice_id}/share-link` (auth: owner of practice) → generate token, return `ShareLinkResponse`
   - `GET /practices/share/{token}` (auth: any logged-in user) → return `ShareLinkPreviewResponse`. Validates not revoked, not expired, under `max_uses`.
   - `POST /practices/share/{token}/import` (auth: any logged-in user) → copy practice as `approved=False, submitted_by_user_id=<self>`, increment `use_count`, return `ShareLinkImportResponse`. Recipient cannot import their own share (returns 400).
   - `DELETE /practices/share-links/{share_link_id}` (auth: owner) → set `revoked_at = now`

5. **Rate-limiting**: 10 share-link creates / hour / user, 30 redemptions / hour / IP.

6. **Tests** at `backend/tests/test_practice_share.py`:
   - Owner can generate a link
   - Non-owner cannot generate a link
   - Recipient can preview and import
   - Imported practice belongs to recipient, is `approved=False`
   - Expired link returns 410
   - `max_uses` exhausted returns 410
   - Revoked link returns 410
   - Self-import returns 400
   - Generated tokens are unique under contention

## Tasks — Frontend

7. **API client** at `frontend/src/api/practiceShare.ts` mirroring the four endpoints.

8. **Share UI**:
   - `ShareSheet` component opened from the practice detail screen for any practice the user owns
   - Form fields: `expires_in_days` (default 30, options 1/7/30/never), `max_uses` (default unlimited, options 1/5/10/unlimited)
   - On submit, displays the share URL with a Copy button
   - Lists existing active links for the practice with Revoke buttons

9. **Import flow**:
   - Deep-link handler registers `adepthood://practices/share/:token` (and equivalent universal link)
   - `SharePreviewScreen` shows the preview response, with **Import to my catalog** + **Cancel**
   - On import, navigates to the new practice's detail screen in the catalog

10. **Tests**:
    - `ShareSheet.test.tsx`: form renders, Copy button copies the URL, Revoke calls DELETE
    - `SharePreviewScreen.test.tsx`: renders preview fields, Import calls POST, expired link shows the error state

## Acceptance Criteria

- [ ] `pytest backend/` green
- [ ] `npm test` green
- [ ] Manual smoke: user A creates a practice → generates a share link → opens it as user B → previews → imports → finds the practice in their own catalog at `approved=False`
- [ ] Expired and revoked links fail closed with 410
- [ ] Self-import is rejected

## Files

| File | Action |
|------|--------|
| `backend/src/models/practice_share_link.py` | **Create** |
| `backend/src/schemas/practice_share.py` | **Create** |
| `backend/src/routers/practice_share.py` | **Create** |
| `backend/src/main.py` | Modify (mount router) |
| `backend/migrations/versions/<rev>_add_practice_share_link.py` | **Create** |
| `backend/tests/test_practice_share.py` | **Create** |
| `frontend/src/api/practiceShare.ts` | **Create** |
| `frontend/src/features/Practice/components/ShareSheet.tsx` | **Create** |
| `frontend/src/features/Practice/screens/SharePreviewScreen.tsx` | **Create** |
| `frontend/src/navigation/` (deep-link config) | Modify |
| `frontend/src/features/Practice/components/__tests__/ShareSheet.test.tsx` | **Create** |
| `frontend/src/features/Practice/screens/__tests__/SharePreviewScreen.test.tsx` | **Create** |

## Constraints

- Tokens are 32 random bytes URL-safe base64 (`secrets.token_urlsafe(32)`)
- The server never auto-approves an imported practice; `approved=False` keeps it private to the recipient via the existing visibility filter
- Do not expose the original owner's user_id — only `created_by_display_name`
- The recipient's imported copy is independent — revoking the original share link does not affect already-imported copies
- Sharing a preset (`submitted_by_user_id=null`) is also allowed; the import still creates a private draft owned by the recipient
