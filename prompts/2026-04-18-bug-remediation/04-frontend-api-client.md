# Frontend API Client Bug Report — 2026-04-18

**Scope:** `frontend/src/api/index.ts` (1308 LOC), `frontend/src/api/types.ts` (246 LOC, generated OpenAPI types), `frontend/src/api/schemas.ts` (134 LOC, Zod runtime validators), `frontend/src/api/errorMessages.ts` (262 LOC, user-facing error mapping).

**Total bugs:** 20 — **3 Critical / 9 High / 8 Medium / 0 Low**.

## Executive summary

The API client is the layer where the user-reported "I signed up but can't log in, then tabs boot me to Signup" failure ultimately surfaces. Three bugs in this file form the smoking-gun chain on the client side:

- **BUG-API-001 (Critical)** — `retryWithRefresh` calls `onUnauthorizedCallback` unconditionally on any refresh failure, conflating *transient* 401s (clock skew, restart) with *permanent* 401s (fake token from BUG-AUTH-001). Both flip `token → null` and (via BUG-NAV-001) collapse the navigator to Signup.
- **BUG-API-016 (Critical)** — `authResponseSchema` accepts `user_id = 0`, the dummy-token sentinel issued by BUG-AUTH-001/002 on duplicate-email signups. The Zod validator was the last line of defence and it lets the bogus token through.
- **BUG-API-006 (Critical)** — Mirror of BUG-API-016 in the resource layer: `auth.signup` does not reject the `user_id = 0` response shape before persisting it.

Five other High-severity bugs amplify the same failure mode or open adjacent footguns:

- **BUG-API-002 / 005** — BotMason streaming and `/auth/refresh` paths bypass the refresh-retry logic and short-circuit to logout.
- **BUG-API-007 / 017** — Token-refresh and JWT-structure validation are missing or skipped, so dummy tokens look valid.
- **BUG-API-008** — Mutation endpoints (POST/PATCH/DELETE on habits, goals, journal, etc.) lack idempotency keys, breaking retry safety on every transient network blip.
- **BUG-API-011 / 012 / 014** — SSE streaming has CRLF parser bugs, no AbortController propagation, and no mid-stream 401 handling.
- **BUG-API-018** — `errorMessages.ts` maps every 401 to "session expired", masking the real diagnostic.

Medium-severity findings cover unbounded SSE buffer growth, 204-response JSON parse crashes, missing OpenAPI generation pinning, and i18n debt.

## Table of contents

| ID | Severity | Component | Title |
|----|----------|-----------|-------|
| BUG-API-001 | Critical | `index.ts:349-410` | 401 refresh failure unconditionally logs the user out (TAB-BOOT root cause on the client) |
| BUG-API-002 | High     | `index.ts:899-944` | `botmason.chatStream` skips token refresh on 401, immediately logging the user out on transient blips |
| BUG-API-003 | High     | `index.ts:349-380` | Race between async `onUnauthorizedCallback` and synchronous throw on retry-401 |
| BUG-API-004 | Medium   | `index.ts:302-318` | `attemptTokenRefresh` does not validate refresh response, lets `undefined` propagate as token |
| BUG-API-005 | High     | `index.ts:369-389` | `handleUnauthorizedRetry` skips logout for `/auth/refresh`, leaving users in a 401-zombie state |
| BUG-API-006 | Critical | `index.ts:1253-1276` | `auth.signup` does not reject `user_id = 0` dummy-token responses before persisting |
| BUG-API-007 | High     | `index.ts:302-318` | Token-refresh response uses unchecked `as AuthResponse` cast instead of Zod validation |
| BUG-API-008 | High     | `index.ts:636-781, 1208-1276` | Mutation endpoints lack `Idempotency-Key` headers, retries cause duplicate side effects |
| BUG-API-009 | Medium   | `index.ts:756-781, 1027-1049` | Hand-rolled query-string concatenation in `journal.list` / `prompts.history` is fragile |
| BUG-API-010 | Medium   | `index.ts:291-300` | `parseResponse` JSON-parses 204 No Content responses, crashes on legacy fetch polyfills |
| BUG-API-011 | High     | `index.ts:859-869` | SSE frame parser silently discards CRLF-terminated frames |
| BUG-API-012 | High     | `index.ts:899-944` | `AbortSignal` not propagated to stream reader — chat cancellation impossible |
| BUG-API-013 | Medium   | `index.ts:871-895` | Malformed JSON frames invoke `onStreamError(502)`, indistinguishable from real server errors |
| BUG-API-014 | High     | `index.ts:899-944` | Mid-stream 401 not detected — auth state silently desynchronises |
| BUG-API-015 | Medium   | `index.ts:927-955` | Unbounded SSE frame buffer accumulates on partial frames; OOM possible from a slow/malicious server |
| BUG-API-016 | Critical | `schemas.ts:55-62`  | `authResponseSchema` accepts `user_id = 0` sentinel, persisting dummy tokens |
| BUG-API-017 | High     | `schemas.ts:56`     | Token field accepts any non-empty string; dummy JWTs pass structural validation |
| BUG-API-018 | High     | `errorMessages.ts:39, 107` | All 401s map to "session expired" — masks dummy-token vs. real-expiry distinction |
| BUG-API-019 | Medium   | `errorMessages.ts:22-118` | Hardcoded English strings; no i18n layer |
| BUG-API-020 | Medium   | `types.ts:1-4, 87-223` | Generated OpenAPI types lack reproducibility pinning; lenient `[key: string]` response shapes |

---

## Critical & High — Core HTTP plumbing (`index.ts` 1–488)

### BUG-API-001: 401 refresh failure silently takes user from "logged in" to "logged out" without distinguishing transient vs. permanent auth failure
**Severity:** Critical
**Component:** `frontend/src/api/index.ts:349-354, 408-410`
**Symptom:** User receives a fake token (BUG-AUTH-001) on duplicate-email signup, persists it in AuthContext, and taps the Home tab. The first authenticated request returns 401. The client attempts refresh (line 350), which also 401s (dummy token is invalid), and `attemptTokenRefresh` returns `null`. On line 352, `onUnauthorizedCallback?.()` is called unconditionally, triggering `AuthContext.onUnauthorized` to set `token = null` and collapse the navigator to the Signup stack (BUG-NAV-001). The user believes they are logged in (they just signed up), but the app boots them to re-authenticate.

**Root cause:**
```typescript
async function retryWithRefresh<T>(ctx: RefreshRetryContext<T>): Promise<T | null> {
  const newToken = await attemptTokenRefresh();
  if (!newToken) {
    onUnauthorizedCallback?.();   // Called unconditionally for ANY refresh failure
    return null;
  }
  // ... retry with newToken ...
  if (!retryRes.ok) {
    if (retryRes.status === 401) onUnauthorizedCallback?.();  // Also called here
    return handleErrorResponse(retryRes);
  }
  return parseResponse<T>(retryRes, ctx.path, ctx.schema);
}
```

The code conflates two distinct failure modes: (1) **transient 401 on a valid-but-expired real token** (refresh should succeed, retry should succeed), and (2) **permanent auth failure** (token is fake, malformed, or revoked; refresh will always 401). Both paths call the same `onUnauthorizedCallback`, flipping `token → null` and unmounting the navigator. A transient network glitch, clock skew, or backend restart that causes a brief 401 should retry, not logout. A fake token (from BUG-AUTH-001) should be rejected at signup-validation time, not here.

**Fix:**
1. **Validate the token at signup**: Before persisting the `AuthResponse` in `SignupScreen` / `AuthContext.signup`, check that `user_id > 0` (reject the response if false; report BUG-FE-AUTH-010 tracks this).
2. **Distinguish transient vs. permanent 401**: Only call `onUnauthorizedCallback` if the token is provably invalid (e.g. if a refresh attempt gets 401 **and** we have evidence the token was valid before—track a `refreshAttempted` flag). For a first 401, retry once silently; only bail if the retry also 401s.
3. **Return a typed result from attemptTokenRefresh**: Return `{ ok: true; token: string } | { ok: false; reason: 'network' | 'invalid_token' }` so callers can branch on the failure reason instead of conflating them.

---

### BUG-API-002: Streaming endpoint skips token refresh, causing transient 401 to immediately logout
**Severity:** High
**Component:** `frontend/src/api/index.ts:983-996`
**Symptom:** User is in the Journal screen reading a chat stream (`botmason.chatStream`). A brief network hiccup or backend restart causes the stream request to return 401. The streaming endpoint immediately calls `onUnauthorizedCallback?.()` (line 990) without attempting token refresh, so a transient 401 becomes a permanent logout. The `request()` orchestrator would have retried with a refreshed token (lines 349-367), but `chatStream` does not.

**Root cause:**
```typescript
async chatStream(
  payload: ChatRequest,
  callbacks: ChatStreamCallbacks,
  options: { token?: string; signal?: AbortSignal } = {},
): Promise<void> {
  const res = await openChatStream(payload, options);
  if (!res.ok) {
    if (res.status === 401) onUnauthorizedCallback?.();  // No refresh attempt
    return handleErrorResponse(res);
  }
  // ...
}
```

The regular `request()` function (line 408) routes 401 through `handleUnauthorizedRetry`, which attempts refresh before calling the callback. The streaming variant (line 990) calls the callback directly, skipping that recovery path. This inconsistency means SSE streams have lower resilience than regular HTTP requests.

**Fix:** Extract the refresh-retry logic into a standalone function, e.g. `async function handle401WithRetry<T>(token: string | undefined, path: string, retryFn: () => Promise<T>): Promise<T>`, and call it from both `attemptRequest` and `chatStream`. Alternatively, have `chatStream` attempt refresh at line 990 before calling the callback, mirroring the `request()` path.

---

### BUG-API-003: Retry-after-refresh also returns 401 calls onUnauthorizedCallback then throws, racing the context state update
**Severity:** High
**Component:** `frontend/src/api/index.ts:362-364`
**Symptom:** In the double-failure case: original request 401s, token is refreshed successfully, retry request also 401s (e.g. server-side revocation of all tokens for this user, or clock went backwards). Line 363 calls `onUnauthorizedCallback?.()`, which async-sets `token = null` in the AuthContext. Line 364 synchronously throws via `handleErrorResponse(res)`. The thrown `ApiError` races the context update, and depending on timing, callers may see either (a) the error propagates while `token` is still non-null (misleading), or (b) the token is cleared but the caller never sees the error because the throw happened first.

**Root cause:**
```typescript
if (!retryRes.ok) {
  if (retryRes.status === 401) onUnauthorizedCallback?.();  // Async callback
  return handleErrorResponse(retryRes);                     // Sync throw
}
```

The callback is fire-and-forget; the throw is synchronous. If the calling code catches the error and checks `useAuth().token`, the token may or may not be cleared depending on the JS event loop schedule.

**Fix:** Move the `onUnauthorizedCallback?.()` to a `.finally()` block, or ensure the callback's `setToken(null)` is awaited before throwing. Cleaner: return the error as a typed result (`{ kind: 'error'; error: ApiError; clearAuth: boolean }`) and let the orchestrator decide whether to call the callback.

---

### BUG-API-004: Token refresh response not validated before extracting token field, allowing undefined to propagate
**Severity:** Medium
**Component:** `frontend/src/api/index.ts:302-318`
**Symptom:** The `auth/refresh` endpoint returns a 200 with a malformed JSON response (missing `token` field, or `token: null`). The code parses it as `AuthResponse` (line 312) without schema validation, extracts `data.token` (which is `undefined`), and passes it to `onTokenRefreshedCallback?.(data.token)` at line 313. In `AuthContext`, `saveTokenThenApply` is called with `undefined`, and `AsyncStorage.setItem('token', undefined)` or similar silently fails or stores the string `'undefined'`. Later requests use `'undefined'` as the Bearer token, causing 401s.

**Root cause:**
```typescript
const refreshRes = await fetch(`${API_BASE_URL}/auth/refresh`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${currentToken}` },
});
if (!refreshRes.ok) return null;
const data = (await refreshRes.json()) as AuthResponse;  // No validation
onTokenRefreshedCallback?.(data.token);                  // Could be undefined
return data.token;
```

The code trusts the response shape. If the backend (or a proxy, or corruption) returns `{ user_id: 123 }` without a `token` field, `data.token` is `undefined`, and the rest of the auth flow breaks silently.

**Fix:** Apply the same `authResponseSchema` validation used by `auth.refresh()` at line 1269 to the `attemptTokenRefresh` response, before calling the callback. If validation fails, return `null` (treat it as "refresh failed") and trigger `onUnauthorizedCallback`.

---

### BUG-API-005: Auth-path 401s do not call onUnauthorizedCallback, leaving zombie auth state when /auth/refresh itself returns 401
**Severity:** High
**Component:** `frontend/src/api/index.ts:369-383`
**Symptom:** User has a broken token (e.g. from BUG-AUTH-001 dummy token). They make any authenticated request, the client attempts `POST /auth/refresh` (line 307), the server returns 401 because the token is invalid. Line 374 detects the path starts with `/auth/` and returns `null` without calling `onUnauthorizedCallback`. The original request then falls through to line 416 and throws `ApiError(401, ...)`. The user's code catches the error, but `token` is still non-null in the context (the callback was never called), so the app remains in a "logged in but every request 401s" zombie state indefinitely. Tapping a tab triggers another 401, but since the token is still set, the navigator does not redirect to Signup.

**Root cause:**
```typescript
async function handleUnauthorizedRetry<T>(
  token: string | undefined,
  ctx: RefreshRetryContext<T>,
): Promise<T | null> {
  const isAuthPath = ctx.path.startsWith('/auth/');
  if (isAuthPath) return null;   // Auth endpoints skip refresh entirely

  if (!token) {
    const retried = await retryWithRefresh<T>(ctx);
    if (retried !== null) return retried;
  } else {
    onUnauthorizedCallback?.();
  }
  return null;
}
```

The special case for `/auth/` paths (lines 373-374) is meant to avoid infinite loops (e.g., refresh endpoint calling itself). However, it also suppresses the callback for `/auth/refresh` returning 401, which is the exact signal that the session is permanently broken.

**Fix:**
1. For `/auth/refresh` specifically, if it returns 401, call `onUnauthorizedCallback?.()` before returning `null`.
2. For other `/auth/*` endpoints (login, signup), 401 is expected during normal flow (wrong password, duplicate email), so skip the callback. Only call it for refresh.
3. Alternatively, introduce a `isRefreshPath` check separate from `isAuthPath`:
```typescript
const isRefreshPath = ctx.path === '/auth/refresh';
if (isRefreshPath && 401) {
  onUnauthorizedCallback?.();
  return null;
}
if (isAuthPath) return null;  // Other auth endpoints skip callback
```

---

## Critical, High & Medium — REST resource modules (`index.ts` 489–820, 1013–1287)

### BUG-API-006: Zod schema accepts `user_id=0` sentinel, enabling dummy-token persistence
**Severity:** Critical
**Component:** `frontend/src/api/index.ts:1253-1275` and `frontend/src/api/schemas.ts:55-62`
**Symptom:** When the backend returns `user_id=0` as a sentinel for duplicate-email signup (BUG-AUTH-001/016), the Zod `authResponseSchema` validates it as a legal response. The `auth.signup` and `auth.login` calls persist the dummy token into AsyncStorage/SecureStore and navigate to Home, leaving the user in a zombie session where all authenticated requests 401. The frontend contract should reject `user_id=0` as a nonsensical value.
**Root cause:**
```tsx
// schemas.ts:61
user_id: z.number().int().nonnegative(),

// index.ts:1261-1266
signup(credentials: AuthRequest): Promise<AuthResponse> {
  return request<AuthResponse>('/auth/signup', {
    method: 'POST',
    body: credentials,
    schema: authResponseSchema,
  });
}
```
The Zod schema allows any non-negative integer including `0`, treating it as indistinguishable from a real user ID. Defense-in-depth here is mandatory: even after the backend is fixed to return 409 on duplicate email, the frontend should refuse `user_id=0` so a server regression cannot silently wedge the session.

**Fix:** Change the `authResponseSchema` to reject `0` explicitly: `user_id: z.number().int().positive()`. This prevents the dummy-token response from validating, raising `ApiValidationError` instead of silently persisting an unusable token. Add a test asserting that `user_id=0` fails validation.

---

### BUG-API-007: `attemptTokenRefresh()` bypasses Zod validation with unsafe type cast
**Severity:** High
**Component:** `frontend/src/api/index.ts:302-318`
**Symptom:** The proactive-refresh path that fires when a token is nearing expiry reads `/auth/refresh` and casts the JSON response as `AuthResponse` without validating against `authResponseSchema`. If the backend ships a malformed response (missing `token`, `user_id` is a string, extra null fields), the cast silently succeeds and a bad token is persisted via `onTokenRefreshedCallback`, corrupting the session.
**Root cause:**
```tsx
const refreshRes = await fetch(`${API_BASE_URL}/auth/refresh`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${currentToken}` },
});
if (!refreshRes.ok) return null;
const data = (await refreshRes.json()) as AuthResponse;  // No Zod validation
onTokenRefreshedCallback?.(data.token);
return data.token;
```
Every other HTTP call in the module uses the `schema` option to `request<T>()` for Zod validation; this bypass rolls its own `fetch`, skipping validation entirely.

**Fix:** Route this through the centralized `request()` function with the schema: `const data = await request<AuthResponse>('/auth/refresh', { method: 'POST', token: currentToken, schema: authResponseSchema });` or at minimum inline the validation: `validateWithSchema('/auth/refresh', refreshRes.status, authResponseSchema, data)`.

---

### BUG-API-008: Mutation endpoints lack idempotency keys, breaking retry safety
**Severity:** High
**Component:** `frontend/src/api/index.ts:667-779` (habits, goalCompletions, goalGroups, journal, course, userPractices, practiceSessions)
**Symptom:** Endpoints that mutate state (POST/PUT/DELETE) do not send `idempotency-key` or `x-idempotency-key` headers. When a network hiccup causes the fetch to fail after the server has processed the request, the `request()` function's retry logic re-sends the same mutation without a key. The server executes it twice: a duplicate habit creation, a goal marked completed twice, a journal entry inserted twice. Only `energy.createPlan` supplies an idempotency key; all others are unprotected.
**Root cause:**
```tsx
// habits.create — no idempotency key
create(payload: HabitCreatePayload, token?: string): Promise<ApiHabit> {
  return request<ApiHabit>('/habits', { method: 'POST', body: payload, token });
}

// energy.createPlan — idempotency key supplied (the correct pattern)
createPlan(body: EnergyPlanRequest, idempotencyKey?: string): Promise<EnergyPlanResponse> {
  return request<EnergyPlanResponse>('/v1/energy/plan', {
    method: 'POST',
    body,
    headers: idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : undefined,
  });
}
```
The retry mechanism in `request()` inspects `hasIdempotencyHeader()` to decide if a POST/PUT is safe to retry (line 190); if the header is absent, the retry is blocked even if the original request failed transiently.

**Fix:** Callers who invoke mutation endpoints must provide an idempotency key. Update each mutation function to accept an optional `idempotencyKey` parameter and pass it via the `headers` option, mirroring the `energy.createPlan` pattern. Alternatively, generate a UUID inside each function (less testable). Add a comment at the top of the mutations section explaining the requirement.

---

### BUG-API-009: Conditional query-string injection can drop parameters if URL is reused
**Severity:** Medium
**Component:** `frontend/src/api/index.ts:756-766, 1038-1046`
**Symptom:** The `journal.list` and `prompts.history` endpoints construct the URL by appending query parameters conditionally, then ternary on whether the query string is empty. If a caller passes `{ offset: 0 }`, the check `if (params.offset != null)` passes but `query.toString()` may suppress the parameter if it's empty, or a later operation on the returned URL re-parses and drops trailing or malformed query segments. The pattern is error-prone and fragile.
**Root cause:**
```tsx
// journal.list:757-766
export const journal = {
  list(params: JournalListParams = {}, token?: string): Promise<JournalListResponse> {
    const query = new URLSearchParams();
    if (params.search) query.set('search', params.search);
    if (params.tag) query.set('tag', params.tag);
    if (params.practice_session_id != null)
      query.set('practice_session_id', String(params.practice_session_id));
    if (params.limit != null) query.set('limit', String(params.limit));
    if (params.offset != null) query.set('offset', String(params.offset));
    const qs = query.toString();
    return request<JournalListResponse>(`/journal${qs ? `?${qs}` : ''}`, { token });
  },
```
While this specific pattern is safe (URLSearchParams always returns a valid string), the ternary and manual concatenation add cognitive overhead and the pattern differs from other endpoints like `habits.listPaginated()` which uses `new URL()` or similar. If the code evolves to filter or transform `qs`, bugs can be introduced.

**Fix:** Use a consistent pattern across all list endpoints: pass the params object directly to `request()` and let it construct the full URL with query params, or normalize to always use `new URL(...)` with `.searchParams` for clarity. For example: `const url = new URL(\`\${API_BASE_URL}/journal\`); Object.entries(params).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, String(v)); }); return request(url.pathname + url.search, ...);` or move the query-building into a helper function.

---

### BUG-API-010: `parseResponse()` attempts JSON parse on 204 No Content, may throw
**Severity:** Medium
**Component:** `frontend/src/api/index.ts:291-296`
**Symptom:** DELETE endpoints (habits, goalGroups, journal) return HTTP 204 No Content with an empty body. The `parseResponse()` function checks for `res.status === 204` and returns early, but the early return does **not** prevent the `await res.json()` from being queued — the expression `await res.json()` is evaluated before the check. On some runtime environments or older fetch polyfills, calling `.json()` on a 204 response throws with "body is empty" or similar, crashing the delete operation.
**Root cause:**
```tsx
async function parseResponse<T>(res: Response, path = '', schema?: z.ZodType<T>): Promise<T> {
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json();  // This line runs even for 204
  if (schema) return validateWithSchema(path, res.status, schema, data);
  return data as T;
}
```
The early return looks correct, but the logic is: check status, then call `res.json()` regardless. In practice, the current code is safe because most modern browsers/React Native runtimes handle `.json()` on empty bodies, but older polyfills (e.g., some Android WebView stacks, legacy Node.js fetch) throw.

**Fix:** Move the `await res.json()` call inside the guard: wrap it in an `if (res.status !== 204) { const data = await res.json(); ... }` block, or refactor as `const data = res.status !== 204 ? await res.json() : undefined;`. Add a comment explaining that 204 responses have no body. Add a unit test for 204 responses to catch regressions.

---

## High & Medium — SSE chat streaming (`index.ts` 784–1012)

### BUG-API-011: SSE frame parser silently discards CRLF-terminated frames
**Severity:** High
**Component:** `frontend/src/api/index.ts:859-869`
**Symptom:** When the SSE server sends frames with Windows-style CRLF line endings (`\r\n`), the parser includes the carriage return in the extracted `event` field, causing the `event === 'chunk'` comparison to fail. Chunks are silently dropped without callback invocation.

**Root cause:**
```tsx
function parseSseFrame(frame: string): SsePayload | null {
  if (!frame.trim()) return null;
  let event = '';
  let data = '';
  for (const line of frame.split('\n')) {  // Splits on \n only, leaves \r
    if (line.startsWith(SSE_EVENT_PREFIX)) event = line.slice(SSE_EVENT_PREFIX.length);
    else if (line.startsWith(SSE_DATA_PREFIX)) data = line.slice(SSE_DATA_PREFIX.length);
  }
  if (!event || !data) return null;
  return { event, data };
}
```
When a frame contains `event: chunk\r\ndata: ...`, splitting by `\n` leaves `event: chunk\r` and `data: ...\r`. The event field is extracted as `"chunk\r"` instead of `"chunk"`, violating the downstream comparison at line 887: `if (parsed.event === 'chunk' ...)`. The dispatchSseFrame function returns silently via line 884 (`if (!parsed) return`), never invoking onChunk or any other callback.

**Fix:** Strip carriage returns from each line before processing:
```tsx
for (const line of frame.split('\n')) {
  const trimmedLine = line.replace('\r', '');  // Remove trailing CR
  if (trimmedLine.startsWith(SSE_EVENT_PREFIX)) event = trimmedLine.slice(SSE_EVENT_PREFIX.length);
  else if (trimmedLine.startsWith(SSE_DATA_PREFIX)) data = trimmedLine.slice(SSE_DATA_PREFIX.length);
}
```

---

### BUG-API-012: AbortSignal not propagated to stream reader, cancellation impossible
**Severity:** High
**Component:** `frontend/src/api/index.ts:983-995`
**Symptom:** When a caller passes an AbortSignal to `chatStream()` to cancel a long-running request, the signal aborts the fetch but does NOT cancel the underlying stream reader. After abort, `readChatStream` continues looping indefinitely, consuming CPU and calling callbacks with stale events from the partially-received stream body.

**Root cause:**
```tsx
async chatStream(
  payload: ChatRequest,
  callbacks: ChatStreamCallbacks,
  options: { token?: string; signal?: AbortSignal } = {},
): Promise<void> {
  const res = await openChatStream(payload, options);
  if (!res.ok) {
    if (res.status === 401) onUnauthorizedCallback?.();
    return handleErrorResponse(res);
  }
  const readable = asReadableStream(res.body);
  if (!readable) throw new StreamingUnsupportedError();
  await readChatStream(readable, callbacks);  // Signal NOT passed; reader cannot be cancelled
}
```
The `signal` is passed to `openChatStream` (line 988) for the fetch timeout, but `readChatStream` (line 995) receives no signal. Inside `readChatStream` (lines 935–939), the `while (!done)` loop does not check `externalSignal?.aborted`, so even if the caller aborts, the reader continues reading chunks indefinitely. The `MinimalReadable.reader.cancel()` method exists (line 843) but is never called.

**Fix:** Pass the signal to readChatStream and check for abort in the read loop:
```tsx
async function readChatStream(
  readable: MinimalReadable,
  callbacks: ChatStreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  while (!done) {
    if (signal?.aborted) {
      await reader.cancel?.();
      break;
    }
    const chunk = await reader.read();
    done = chunk.done;
    if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
    buffer = drainCompletedFrames(buffer, callbacks);
  }
  if (buffer.trim()) dispatchSseFrame(buffer, callbacks);
}

// Update chatStream call:
await readChatStream(readable, callbacks, options.signal);
```

---

### BUG-API-013: Malformed JSON frames invoke onStreamError but downstream handlers may not expect mid-stream errors
**Severity:** Medium
**Component:** `frontend/src/api/index.ts:871-879, 882-894`
**Symptom:** When a single SSE frame contains invalid JSON (e.g., `event: chunk\ndata: {invalid json}\n\n`), `safeJsonParse` calls `onStreamError({ status: 502, detail: 'malformed_stream_frame' })` and returns `undefined`. This error callback is indistinguishable from a server-sent `event: error` frame, potentially confusing callers who expect only socket-level errors to surface via onStreamError, not content-level parse failures.

**Root cause:**
```tsx
function safeJsonParse(raw: string, callbacks: ChatStreamCallbacks): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    // A malformed frame is treated as a provider-level error rather than a
    // thrown exception so callers get a consistent failure surface.
    callbacks.onStreamError({ status: 502, detail: MALFORMED_FRAME_DETAIL });
    return undefined;
  }
}

function dispatchSseFrame(frame: string, callbacks: ChatStreamCallbacks): void {
  const parsed = parseSseFrame(frame);
  if (!parsed) return;
  const payload = safeJsonParse(parsed.data, callbacks);  // May invoke onStreamError
  if (payload === undefined) return;
  // ...
}
```
If a partial or corrupted frame arrives (e.g., a timeout mid-JSON or a provider bug), the error is reported as HTTP 502 even though no HTTP failure occurred. The caller's error handler may attempt recovery (e.g., retry), which is incorrect—the connection is healthy, only a single chunk was malformed.

**Fix:** Distinguish JSON parse errors from provider errors by creating a separate callback or error type:
```tsx
interface ChatStreamCallbacks {
  onChunk: (_text: string) => void;
  onComplete: (_response: ChatResponse) => void;
  onStreamError: (_error: { status: number; detail: string }) => void;
  onFrameParseError?: (_detail: string) => void;  // New callback for content errors
}

function safeJsonParse(raw: string, callbacks: ChatStreamCallbacks): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    if (callbacks.onFrameParseError) {
      callbacks.onFrameParseError(MALFORMED_FRAME_DETAIL);
    } else {
      // Fallback for backward compatibility
      callbacks.onStreamError({ status: 502, detail: MALFORMED_FRAME_DETAIL });
    }
    return undefined;
  }
}
```

---

### BUG-API-014: 401 response mid-stream does not trigger AuthContext refresh, silently fails
**Severity:** High
**Component:** `frontend/src/api/index.ts:988-991`
**Symptom:** If the server returns 401 Unauthorized on the initial stream fetch (e.g., token expired), the `onUnauthorizedCallback` is invoked to trigger AuthContext cleanup. However, this callback is only called if the initial response fails. Any mid-stream 401 from an invalid/expired token does not reach this path—it either comes as an SSE `event: error` frame (which is NOT treated as an unauthorized condition) or causes a read error that is never caught.

**Root cause:**
```tsx
async chatStream(
  payload: ChatRequest,
  callbacks: ChatStreamCallbacks,
  options: { token?: string; signal?: AbortSignal } = {},
): Promise<void> {
  const res = await openChatStream(payload, options);
  if (!res.ok) {
    if (res.status === 401) onUnauthorizedCallback?.();  // Only invoked for initial response
    return handleErrorResponse(res);
  }
  const readable = asReadableStream(res.body);
  if (!readable) throw new StreamingUnsupportedError();
  await readChatStream(readable, callbacks);  // No 401 detection during streaming
}
```
The read loop in `readChatStream` (lines 935–939) has no HTTP error handling. If the server's connection drops and the proxy returns 401 before closing the stream, the reader will encounter either a partial frame or a transport error. The code does not distinguish between "stream ended cleanly" and "stream ended with an error," so 401 conditions mid-stream are never surfaced to the auth system.

**Fix:** Add HTTP error handling in the stream read path. This requires wrapping the reader in a response status check or adding error detection:
```tsx
async chatStream(
  payload: ChatRequest,
  callbacks: ChatStreamCallbacks,
  options: { token?: string; signal?: AbortSignal } = {},
): Promise<void> {
  const res = await openChatStream(payload, options);
  if (!res.ok) {
    if (res.status === 401) onUnauthorizedCallback?.();
    return handleErrorResponse(res);
  }
  const readable = asReadableStream(res.body);
  if (!readable) throw new StreamingUnsupportedError();
  try {
    await readChatStream(readable, callbacks, options.signal);
  } catch (err) {
    // If the stream closed unexpectedly, check if it was a 401
    if (res.status === 401) onUnauthorizedCallback?.();
    throw err;
  }
}
```
Alternatively, wrap the read loop to detect network errors and log them.

---

### BUG-API-015: Unbounded SSE frame buffer accumulation on partial frames without max-size cap
**Severity:** Medium
**Component:** `frontend/src/api/index.ts:927-944, 946-955`
**Symptom:** If the server sends a very large SSE `data:` line without completing the frame (no `\n\n` terminator), the buffer in `readChatStream` grows without bound. A slow or malicious server can exhaust memory by streaming a 1GB JSON object as a single incomplete frame, triggering OOM kill on the device.

**Root cause:**
```tsx
async function readChatStream(
  readable: MinimalReadable,
  callbacks: ChatStreamCallbacks,
): Promise<void> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = '';  // No size limit
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
    buffer = drainCompletedFrames(buffer, callbacks);
  }
  // Any trailing bytes that arrived without a terminating blank line still
  // need to be dispatched — servers may elide the final separator.
  if (buffer.trim()) dispatchSseFrame(buffer, callbacks);
}

function drainCompletedFrames(buffer: string, callbacks: ChatStreamCallbacks): string {
  const separatorIndex = buffer.lastIndexOf(SSE_FRAME_SEPARATOR);
  if (separatorIndex === -1) return buffer;  // No limit; buffer grows
  // ...
}
```
Each incoming chunk is appended to `buffer` (line 938) without checking size. If `drainCompletedFrames` finds no terminator (line 947), the entire buffer is returned unchanged, and the next chunk is appended. A single 1GB incomplete frame will accumulate fully in memory before cleanup.

**Fix:** Enforce a maximum buffer size and emit an error when exceeded:
```tsx
const MAX_BUFFER_SIZE = 100 * 1024 * 1024; // 100 MB

async function readChatStream(
  readable: MinimalReadable,
  callbacks: ChatStreamCallbacks,
): Promise<void> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    if (chunk.value) {
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > MAX_BUFFER_SIZE) {
        callbacks.onStreamError({
          status: 502,
          detail: 'stream_buffer_overflow'
        });
        return;
      }
    }
    buffer = drainCompletedFrames(buffer, callbacks);
  }
  if (buffer.trim()) dispatchSseFrame(buffer, callbacks);
}
```

---

## Critical, High & Medium — Types, schemas, and error messages

### BUG-API-016: Zod `authResponseSchema` accepts `user_id=0` sentinel that will fail on all authenticated requests
**Severity:** Critical
**Component:** `frontend/src/api/schemas.ts:55-62`
**Symptom:** When a user signup attempt includes a duplicate email, the backend returns HTTP 200 with `user_id=0` and a dummy JWT (signed with a random key). The frontend's Zod schema accepts this sentinel value without rejection, stores the dummy token in `AuthContext`, and all subsequent authenticated requests fail with 401 errors. The user sees a successful signup but is then locked out with no clear recovery path — they cannot log in because their token is invalid, and re-attempting signup returns the same dummy token.
**Root cause:**
```typescript
export const authResponseSchema = z.object({
  token: z.string().min(1),
  // ``user_id`` is ``0`` in the anti-enumeration signup response (BUG-AUTH-002):
  // when a caller signs up with an already-registered email the backend returns
  // a dummy token and ``user_id=0`` so the wire shape is indistinguishable from
  // a fresh signup. Real signups return a positive autoincrement id.
  user_id: z.number().int().nonnegative(),
});
```
The schema validates `user_id >= 0`, which means `user_id=0` passes validation. The backend's dual-use pattern (same response shape for both success and dummy-token cases) is itself a design flaw, but the frontend compounds it by accepting a value that should never appear in a real successful signup. Real user IDs are autoincrement integers starting from 1; zero is a sentinel that indicates "this signup failed silently" per the backend's BUG-AUTH-001 anti-enumeration pattern.

**Fix:** Change `user_id` to reject the sentinel value:
```typescript
user_id: z.number().int().positive(),
```
This forces the backend to distinguish the two cases via HTTP status code (409 Conflict for duplicate email) rather than overloading the 200 response. Alternatively, if backward compatibility is required, add a separate validator and **throw `ApiValidationError` explicitly** when `user_id === 0` is detected in the auth response, so callers see a typed error rather than silent failure on the next request.

---

### BUG-API-017: Token format lacks structural validation; dummy JWTs pass as valid
**Severity:** High
**Component:** `frontend/src/api/schemas.ts:56` + `frontend/src/utils/token.ts:19-34`
**Symptom:** The backend's `_create_dummy_token()` returns a structurally valid JWT (three base64url parts separated by dots, decodable payload) signed with a random ephemeral key. The frontend's `authResponseSchema` accepts any non-empty string as a token. When a duplicate-email signup returns the dummy token, `decodeJwtPayload()` successfully extracts `sub: "0"` and `exp`, so the token appears usable until the backend rejects it. No validation catches that the signature is invalid or that the token's `sub` claim is malformed (zero, a sentinel value that should never be issued for a real user).
**Root cause:**
```typescript
export const authResponseSchema = z.object({
  token: z.string().min(1),  // accepts "any string >= 1 char"
  ...
});
```
The Zod schema checks only that the token is a non-empty string. There is no check for JWT structure (three dot-separated parts), no validation of the `sub` claim, and no rejection of `sub: "0"`. Meanwhile, `decodeJwtPayload()` succeeds on malformed tokens due to try-catch swallowing errors.

**Fix:** Add a JWT structure validator to the schema:
```typescript
const jwtString = z.string()
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'Invalid JWT format')
  .refine(token => {
    const payload = decodeJwtPayload(token);
    return payload !== null && payload.sub !== '0';
  }, 'Token must have a valid payload with non-zero sub claim');

export const authResponseSchema = z.object({
  token: jwtString,
  user_id: z.number().int().positive(),
});
```

---

### BUG-API-018: 401 Unauthorized error message masks the real failure (dummy token or expired session)
**Severity:** High
**Component:** `frontend/src/api/errorMessages.ts:39, 107`
**Symptom:** Both the backend's duplicate-email signup path and true session-expiration failures map to the same 401 status code and `"unauthorized"` detail string. The user sees "Your session has expired. Sign back in to continue." regardless of whether their token is a dummy (and never worked) or legitimately expired (and worked until now). Users who hit BUG-API-016 (dummy token from duplicate-email signup) see "session expired" copy, which is incorrect — they never had a valid session to begin with. This misdirects them to "sign back in" when the real fix is to delete the bogus token and start signup over.
**Root cause:**
```typescript
const SESSION_EXPIRED = 'Your session has expired. Sign back in to continue.';
...
export const USER_FACING_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ...
  unauthorized: SESSION_EXPIRED,  // Used for all 401s
});
...
const STATUS_FALLBACKS: Readonly<Record<number, string>> = Object.freeze({
  ...
  401: SESSION_EXPIRED,  // Fallback when detail code is unknown
});
```
The backend returns `detail="unauthorized"` for any 401 (expired token, invalid token, no token, dummy token). Without distinction on the wire, the frontend cannot tell a legitimate expiration from a fake token. The test suite even confirms this is the designed behavior (see `retryAndValidation.test.ts:82-94`), cementing the conflation.

**Fix:** The backend should return different `detail` codes:
- `unauthorized_expired` or `token_expired` for legitimately expired JWTs
- `unauthorized_invalid` or `token_invalid` for forged/unsigned/malformed tokens (including dummy tokens)

Then add both to the frontend mapping:
```typescript
const USER_FACING_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ...
  token_expired: 'Your session has expired. Sign back in to continue.',
  token_invalid: 'Your login is no longer valid. Sign in again to get started.',
  unauthorized: 'You do not have access to this. Sign back in to continue.',
  ...
});
```

---

### BUG-API-019: Hardcoded English strings in errorMessages.ts with no localization layer
**Severity:** Medium
**Component:** `frontend/src/api/errorMessages.ts:22-28, 34-98, 106-118`
**Symptom:** All 31 user-facing error messages are hardcoded in English. There is no i18n layer (`i18next`, `react-i18next`, `formatjs`, or similar) to support translation. Any attempt to localize the app would require duplicating the entire mapping logic for each supported language and manually syncing it as new error codes are added.
**Root cause:**
```typescript
const PULL_TO_REFRESH = 'Pull down to refresh and try again.';
const CHECK_CONNECTION = 'Check your connection and try again.';
const PROVIDER_TROUBLE = "BotMason's AI provider is having trouble connecting. Give it a moment and tap retry.";
const SESSION_EXPIRED = 'Your session has expired. Sign back in to continue.';
...
export const USER_FACING_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  invalid_credentials: "That email and password don't match an account we have. Double-check both fields, or tap Sign Up if you're new.",
  ...
});
```
Every message is a literal string in the file. There is no namespace, no translation key lookup, no language-aware formatting.

**Fix:** Extract messages into a localization function:
```typescript
type ErrorMessageKey = keyof typeof USER_FACING_ERROR_MESSAGES;

export function formatApiError(err: unknown, options: FormatErrorOptions & { locale?: string } = {}): string {
  // ... existing logic to determine the message key ...
  const key: ErrorMessageKey = ...;
  return i18n.t(`errors.${key}`, { locale: options.locale ?? 'en' });
}
```
Or use a YAML/JSON translation file:
```yaml
# src/locales/en.yaml
errors:
  invalid_credentials: "That email and password don't match an account we have..."
  unauthorized: "Your session has expired. Sign back in to continue."
```

---

### BUG-API-020: types.ts is auto-generated but lacks reproducibility pinning and contains optional response fields that should be required
**Severity:** Medium
**Component:** `frontend/src/api/types.ts:1-4, 87-90, 142-159, 206-223`
**Symptom:** The file header states "This file was auto-generated by openapi-typescript. Do not make direct changes to the file." However, there is no entry in `package.json`'s `generate` script, no `.openapi-ts.json` config file, and no documentation of the generation command or version pinning. This means regeneration is not reproducible, and future developers may cargo-cult changes or accidentally commit hand-edits that will be blown away. Additionally, response schemas like `EnergyPlanResponse` (line 87-90) and operation responses (lines 142-159) use `[key: string]: unknown` for arbitrary JSON, which is too lenient — if the backend adds or removes a required field, the client silently accepts the malformed response.
**Root cause:**
```typescript
/**
 * This file was auto-generated by openapi-typescript.
 * Do not make direct changes to the file.
 */
export interface paths { ... }
export interface components {
  schemas: {
    EnergyPlan: { /* precise fields */ };
    EnergyPlanResponse: {
      plan: components['schemas']['EnergyPlan'];
      reason_code: string;
    };
    ...
  };
};

// Later in operations:
responses: {
  200: {
    content: {
      'application/json': {
        [key: string]: number;  // Too lenient; accepts anything
      };
    };
  };
};
```
The file is marked "auto-generated" but there is no reproducibility mechanism. Response type for `/practice_sessions/{user_id}/week_count` accepts `{ [key: string]: number }`, which means a missing or malformed field does not cause a type error at the call site.

**Fix:**
1. Add a `generate` script to `package.json`:
   ```json
   {
     "scripts": {
       "generate:api": "openapi-typescript ../backend/openapi.json -o ./src/api/types.ts",
       "generate": "npm run generate:api"
     }
   }
   ```
2. Add a `.openapi-ts.json` config file at the repo root to pin the generation behavior:
   ```json
   {
     "input": "../backend/openapi.json",
     "output": "frontend/src/api/types.ts",
     "useTypeOverInterfaces": true
   }
   ```
3. Verify that the OpenAPI spec in the backend (`backend/openapi.json` or generated via `FastAPI`) has tight response schemas with no `additionalProperties: true` or `[key: string]: unknown` patterns.
4. Add a pre-commit hook that detects manual changes to `types.ts` and fails with a message to regenerate instead.

---

## Suggested remediation order

1. **BUG-API-016** — change `authResponseSchema` to `user_id: z.number().int().positive()`. One-line change that immediately stops the bogus dummy token from being persisted on duplicate-email signups. Pairs with backend BUG-AUTH-001/002/016 and AuthContext BUG-FE-AUTH-010.
2. **BUG-API-006** — add the same explicit guard in `auth.signup` (defence in depth in case the schema is bypassed).
3. **BUG-API-001** — split `retryWithRefresh` failure modes; only call `onUnauthorizedCallback` for provably invalid tokens, not transient blips. Required to neutralise the tab-boot bug at the API layer.
4. **BUG-API-005** — special-case `/auth/refresh` so refresh-itself-401 routes to logout (currently the opposite is true: refresh failures are silently swallowed).
5. **BUG-API-007** — apply the Zod `authResponseSchema` to refresh responses, not an unsafe cast.
6. **BUG-API-017** — add a JWT structure regex + `sub !== '0'` refinement to the token field. Belt-and-braces protection if the backend regresses.
7. **BUG-API-002** — share the refresh-and-retry flow with `botmason.chatStream` (currently it short-circuits to logout on any 401).
8. **BUG-API-014** — detect and surface mid-stream 401s from the SSE reader; do not swallow them into `onStreamError`.
9. **BUG-API-018** — add distinct `token_expired` vs. `token_invalid` codes and update `errorMessages` mapping. Requires a coordinated backend change.
10. **BUG-API-008** — add `Idempotency-Key` headers to all mutation endpoints (POST/PATCH/DELETE on habits, goals, journal, auth.signup, etc.). Required before increasing retry budget.
11. **BUG-API-011** — fix the SSE parser's CRLF handling. Trivial change, prevents silent chunk drops.
12. **BUG-API-012** — propagate `AbortSignal` into `readChatStream`. Required for cancellation correctness in chat UI.
13. **BUG-API-015** — cap the SSE buffer at e.g. 1 MiB; reject the stream if exceeded.
14. **BUG-API-003** — make `onUnauthorizedCallback` awaitable (or wait for it before throwing) to remove the race.
15. **BUG-API-004** — validate refresh-response token with the schema (overlaps with BUG-API-007).
16. **BUG-API-013** — distinguish "malformed frame" from "server 502" in `dispatchSseFrame`'s error path.
17. **BUG-API-010** — short-circuit `parseResponse` on 204 / `Content-Length: 0` before attempting JSON parse.
18. **BUG-API-009** — replace hand-rolled query strings with `URLSearchParams`.
19. **BUG-API-020** — pin OpenAPI generation in `package.json` and tighten lenient `[key: string]` response shapes upstream.
20. **BUG-API-019** — extract user-facing strings into an i18n layer.

## Cross-references

- **BUG-API-001 + BUG-API-005 + BUG-API-016 + BUG-API-006 + BUG-API-017** are the API-layer half of the user-reported "tab boots me to signup" bug. They compound with:
  - **BUG-AUTH-001 / 002 / 016** (backend dummy-token signup response)
  - **BUG-FE-AUTH-010** (AuthContext blindly persists dummy token)
  - **BUG-NAV-001** (RootNavigator collapses to AuthStack on `token = null`)
  - **BUG-NAV-011** (BottomTabs remounts on auth churn)
- **BUG-API-002 / 014** (streaming auth handling) intersect with the BotMason work captured in report 13.
- **BUG-API-008** (idempotency keys) is the client-side mirror of any "duplicate side effect after retry" bugs surfaced in the per-resource backend reports (09, 10, 11, 12, 13, 14).
- **BUG-API-018** depends on a coordinated backend change tracked under report 01 (auth) and report 05 (app/middleware).
