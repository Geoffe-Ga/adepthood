# course-cms-04: Frontend API client + `ChapterReader` `kind: 'intro'` source

**GitHub:** #720 · **Labels:** `frontend`, `enhancement`
**Epic:** #716 · **Depends on:** #719 (endpoints)
**Estimated LoC:** ~150

## Problem

The frontend has no client for the new stage-introduction endpoints, and the
`ChapterReader` (which already renders chapter and site-resource bodies as
native Markdown) has no source variant for an intro. Add both so the Course
screen (#721) can open a stage intro in the existing reader.

## Scope

`frontend/src/api/index.ts` (the `course` client + types) and
`frontend/src/features/Course/ChapterReader.tsx` (the `ChapterReaderSource`
union). No screen wiring yet (that's #721).

## Tasks (TDD)

1. **Types.** Add a `StageIntro` type
   `{ stage: number; id: string; slug: string; title: string; summary: string | null }`.
   Reuse the existing `ContentBody` type for the body. If the repo validates API
   responses with Zod (`frontend/src/api/schemas.ts`), add a matching schema and
   validate, consistent with sibling endpoints.
2. **Client.** On `export const course` in `index.ts` add:
   - `stageIntro(stageNumber: number, token?: string): Promise<StageIntro>` →
     `GET /course/stages/{n}/intro`;
   - `stageIntroBody(stageNumber: number, token?: string): Promise<ContentBody>`
     → `GET /course/stages/{n}/intro/body`.
   Follow the exact `request()` + token-fallback pattern used by
   `stageContentAll` / `siteResources`.
3. **Reader source.** Extend `ChapterReaderSource` with
   `{ kind: 'intro'; stageNumber: number }` and branch the fetch in
   `ChapterReader` to call `courseApi.stageIntroBody(source.stageNumber)`,
   reusing the existing loading / error / empty states and Markdown rules
   (including the image/link guards). No footer for intros (like resources).
4. **Tests.**
   - API: `frontend/src/api/__tests__` — `stageIntro` / `stageIntroBody` hit the
     right paths, send auth, and (if Zod) reject a malformed payload with
     `ApiValidationError`.
   - Reader: extend `ChapterReader.test.tsx` — an `intro` source fetches via
     `stageIntroBody`, renders the returned Markdown, and shows the error state
     on failure.

## Acceptance criteria

- `course.stageIntro` / `course.stageIntroBody` exist, typed, and call the
  correct endpoints with the shared auth pattern.
- `ChapterReader` accepts `{ kind: 'intro'; stageNumber }` and renders the intro
  body natively, reusing existing states.
- `cd frontend && npm test && npm run lint && npx tsc --noEmit` all pass
  (ESLint zero-warnings, no `any`, no `@ts-ignore`).

## Files to modify

| File | Action |
|------|--------|
| `frontend/src/api/index.ts` | `StageIntro` type + two `course` methods |
| `frontend/src/api/schemas.ts` | Zod schema (if the repo validates responses) |
| `frontend/src/features/Course/ChapterReader.tsx` | `intro` source variant |
| `frontend/src/api/__tests__/*` | Client tests |
| `frontend/src/features/Course/__tests__/ChapterReader.test.tsx` | Reader test |

## Constraints

- Reuse `ChapterReader`'s existing rendering/guards — do not fork a new reader.
- Match the existing client conventions exactly (token fallback, error mapping).
- No behaviour change to the `content` / `resource` source paths.
