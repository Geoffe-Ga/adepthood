# journal-load-fix-03: Stop redirect/CORS failures masquerading as "offline"

**Labels:** `bug`, `frontend`, `observability`
**Epic:** [Fix journal load failure](journal-load-fix-epic.md)
**Depends on:** none (independent of 01)
**Estimated LoC:** ~140

## Role

You are a frontend engineer making misconfiguration debuggable. Right now a
route/CORS/redirect failure is indistinguishable from a real offline state — it
told a journal user to "check your connection" while they were online, and the
mislabel is what made the root cause (a 307 redirect) take so long to find.

## Goal

When a request fails because of a redirect or CORS/preflight problem rather than
a genuine loss of connectivity, surface and log it as a **distinct, diagnosable
failure** — not `network_error` / "you appear to be offline". A real offline
state must still read as offline.

## Context

A failed `fetch` rejects with a `TypeError`. `errorMessages.ts`
(`frontend/src/api/errorMessages.ts:235-277`) lumps every such `TypeError` into
`network_error`:

```ts
const FETCH_NETWORK_MESSAGE_FRAGMENTS = ['load failed', 'failed to fetch', ...];
function isFetchNetworkError(err): boolean { /* TypeError + fragment match */ }
function classifyNetworkError(err): string | undefined {
  // ...
  if (isFetchNetworkError(err)) return USER_FACING_ERROR_MESSAGES.network_error; // "offline"
}
```

The browser deliberately gives the same opaque `TypeError` for "no network" and
"CORS blocked the redirect", so the message string alone can't separate them.
But the request layer has more signal: whether `navigator.onLine` is true, and
whether the response (when one came back) was a redirect (`res.redirected` /
`res.type === 'opaqueredirect'`). The fix is to use that signal so an online
client that hit a redirect/CORS wall gets a different, actionable failure and a
distinct log line — instead of a dead-end "you're offline".

## Tasks

1. **Detect redirects at the fetch boundary.** In
   `frontend/src/api/index.ts`, where the response is handled
   (`attemptRequest` / `parseResponse`, ~`index.ts:637-672`), detect a redirected
   or opaque-redirect response and raise a typed, named error (e.g. extend the
   existing `ApiError`/`ApiValidationError` family with an
   `ApiRouteRedirectError` carrying `path` + `location` if available). A
   collection request should never be redirected once clients are correct, so
   this both diagnoses today's bug and guards against its return.

2. **Split the message mapping.** In `errorMessages.ts`:
   - Add copy for the new redirect/route error: name that the app reached the
     server but the request was bounced (a misconfiguration, not the user's
     network), and what to do (update the app / retry).
   - When classifying a bare fetch `TypeError`, consult connectivity: if the
     platform reports online (`navigator.onLine === true` where available),
     prefer a "couldn't reach the server" framing over the flat "you're offline."
     Keep the true-offline copy for when the platform reports offline.

3. **Log distinctly.** Ensure the redirect/route error logs a `console.warn`
   with the path (mirroring the schema-validation log at `index.ts:413-421`) so
   operators can spot a slash/route regression immediately.

4. **Tests** in `frontend/src/api/__tests__/errorMessages.test.ts` (extend) and
   `retryAndValidation.test.ts`:
   - A redirected response maps to the new error + its copy, not `network_error`.
   - A `TypeError` while `navigator.onLine === false` still maps to offline copy.
   - A `TypeError` while online maps to the "couldn't reach the server" copy.

## Acceptance Criteria

- [ ] A redirected/opaque-redirect response produces a typed route error, not
      `network_error`, and logs a `console.warn` with the path.
- [ ] An online fetch `TypeError` no longer renders the flat "you appear to be
      offline" copy; a genuinely offline one still does.
- [ ] New/updated tests cover all three branches above.
- [ ] No change to any successful-path behavior or to non-fetch error mapping.
- [ ] `cd frontend && npm test`, `npx tsc --noEmit`, `npm run lint` pass.
- [ ] `pre-commit run --all-files` green.

## Constraints

- Don't break the existing offline UX: `isKnownOffline()` fast-fail
  (`index.ts:726`) and the true-offline copy must still work.
- `navigator.onLine` is unreliable/absent on some RN targets — treat "unknown"
  as "assume online and prefer the server-unreachable framing," never throw.
- Keep user copy in `errorMessages.ts` (the single source of error copy); no
  inline strings in `index.ts`.
- Conventional commit: `fix(frontend): classify redirect/CORS failures distinctly from offline`.

## References

- `frontend/src/api/errorMessages.ts:114,235-277` — current network classification + copy
- `frontend/src/api/index.ts:637-672` — response handling / `attemptRequest`
- `frontend/src/api/index.ts:413-421` — schema-validation `console.warn` to mirror
- `frontend/src/api/index.ts:85-118` — `ApiError` / `ApiValidationError` / `ApiTimeoutError` classes
