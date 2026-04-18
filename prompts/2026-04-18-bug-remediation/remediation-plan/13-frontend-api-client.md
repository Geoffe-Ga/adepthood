# Prompt 13 — Frontend API client hardening (Wave 4, parallelizable)

## Role
You are a frontend engineer who thinks of the API client as a reliability surface: retry policy, abort propagation, Zod validation at the edge, idempotency headers, SSE frame parsing. You treat `as` casts as bugs.

## Goal
Close the High-severity bugs in report 04 (frontend API client) that remain after Prompt 01. The 401-unblocking work landed in Prompt 01; this prompt addresses the rest.

Success criteria:

1. `botmason.chatStream` routes 401s through the same refresh flow as REST calls, not a direct logout.
2. `handleUnauthorizedRetry` handles `/auth/refresh` as a special case without leaving the user in a 401-zombie.
3. All refresh / signup / login responses validate via Zod — no `as AuthResponse` casts.
4. Mutation endpoints accept an optional `Idempotency-Key` header; callers auto-generate one per user action (mutation key derived from user intent, not wall clock).
5. SSE parser handles CRLF-terminated frames; `AbortSignal` propagates to the stream reader so user-cancel actually cancels upstream.
6. Mid-stream 401 detection: if a data frame signals auth failure, raise into the refresh flow, do not silently continue.
7. Token shape validation: reject obviously-invalid JWTs at the client boundary (three dot-separated base64 segments, etc.); reject `user_id == 0` if it somehow slipped through.
8. 401 error messages distinguish "token expired" from "token invalid" (dummy-token zombie) from "policy denied" — Prompt 10 wires Sentry; this prompt adds the shape.

## Context
Bug IDs (skip those marked [done-by-N]):
- `prompts/2026-04-18-bug-remediation/04-frontend-api-client.md`:
  - BUG-API-002 (chatStream skips refresh), -003 (race between async onUnauthorizedCallback and sync throw), -007 (unchecked `as AuthResponse`), -008 (no Idempotency-Key), -011 (SSE CRLF frames dropped), -012 (AbortSignal not propagated), -014 (mid-stream 401 not detected), -017 (token shape validation), -018 (401 message conflation).
  - Medium/Low items -004, -009, -010, -013, -015, -019, -020 (pick those you hit naturally).
  - Skip BUG-API-001 [done-by-01], -005 [done-by-01], -006 [done-by-03], -016 [done-by-03].

Files you will touch (expect ≤10): `frontend/src/api/client.ts`, `frontend/src/api/botmason.ts`, `frontend/src/api/auth.ts`, `frontend/src/api/schemas/*.ts` (Zod), tests.

## Output Format
Five atomic commits:

1. `fix(frontend-api): botmason.chatStream uses refresh flow; /auth/refresh 401 handling (BUG-API-002, -005-overlap)`.
2. `fix(frontend-api): Zod-validate all auth responses; reject user_id=0 (BUG-API-007, -017)`.
3. `feat(frontend-api): Idempotency-Key on all mutations (BUG-API-008)`.
4. `fix(frontend-api): SSE CRLF frames + AbortSignal propagation + mid-stream 401 (BUG-API-011, -012, -014)`.
5. `fix(frontend-api): distinguish 401 reasons in error types (BUG-API-018, plus Medium pickups)`.

## Examples

Zod at the edge:
```ts
const AuthResponse = z.object({
  access_token: z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  refresh_token: z.string().optional(),
  user_id: z.number().int().positive(), // rejects 0
  expires_in: z.number().int().positive(),
});
```

Idempotency keying:
```ts
function idempotencyKey(intent: string, ...parts: (string | number)[]): string {
  return `${intent}:${parts.join(":")}`;
  // Mutation callers pass a deterministic intent, e.g. `log-unit:${habitId}:${dateISO}`.
}
```

SSE + abort:
```ts
async function* readSSE(response: Response, signal: AbortSignal) {
  const reader = response.body!.getReader();
  signal.addEventListener("abort", () => void reader.cancel(), { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    // Accept LF and CRLF frame terminators.
    while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
      yield frame;
    }
  }
}
```

## Requirements
- `max-quality-no-shortcuts`: no `as` casts on parsed responses; use Zod or io-ts.
- `testing`: each commit ships with a unit test that reproduces the bug first.
- `security`: idempotency-key must not be exfiltrable as a session identifier; do not log it in plaintext beyond debug.
- Do NOT touch `authStatus` state machine (owned by Prompt 01) — only surface the 401 distinction into the existing shape.
- Parallelizable with 11, 12, 14, 15.
- `pre-commit run --all-files` before each commit.
