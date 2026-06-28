import { z } from 'zod';

import { flattenGoalCompletions } from './flattenGoalCompletions';
import {
  apiGoalGroupSchema,
  authResponseSchema,
  contentItemSchema,
  frequencyResponseSchema,
  habitWithGoalsSchema,
  isTier,
  journalListResponseSchema,
  loginAuthResponseSchema,
  pageSchema,
  passwordResetAcceptedSchema,
  practiceItemSchema,
  practiceRecipeSchema,
  practiceSessionResponseSchema,
  practiceTagSchema,
  promptListResponseSchema,
  stageSchema,
  timezoneReadSchema,
  userPracticeSchema,
  type Page,
  type PasswordResetAcceptedT,
  type Tier,
  type TimezoneReadT,
} from './schemas';

import { API_BASE_URL } from '@/config';
import type { Habit as LocalHabit } from '@/features/Habits/Habits.types';
import type { ModeConfig } from '@/features/Practice/engine/types';

// Hand-written energy-plan contract (audit-contracts-07). Previously derived
// from the stale openapi-typescript ``types.ts`` (frozen-by-comment, never
// regenerated); these mirror the live ``/v1/energy/plan`` shapes.
export interface EnergyPlanItem {
  habit_id: number;
  date: string;
}

export interface EnergyPlan {
  items: EnergyPlanItem[];
  net_energy: number;
}

export interface EnergyPlanRequest {
  habits: Pick<ApiHabit, 'id' | 'name' | 'energy_cost' | 'energy_return'>[];
  start_date: string;
}

export interface EnergyPlanResponse {
  plan: EnergyPlan;
  reason_code: string;
}

export type { Page } from './schemas';

// ---------------------------------------------------------------------------
// Timeouts, retries, and transient-error classification
// (BUG-FRONTEND-INFRA-001 + BUG-FRONTEND-INFRA-007)
// ---------------------------------------------------------------------------

/** Default per-request timeout. Tuned long enough to cover slow 3G + warm-up. */
export const FETCH_TIMEOUT_MS = 30_000;

/**
 * Longer timeout applied to BotMason SSE streams. The server keeps the
 * connection open until the model finishes; a 30-second cap would kill the
 * tail of every reply.
 */
export const STREAM_TIMEOUT_MS = 5 * 60_000;

/** Maximum retry attempts **after** the initial request. */
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 2_000;

/** HTTP statuses worth retrying — every transient class except 401. */
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Methods safe to retry without a caller-supplied idempotency key. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'DELETE']);

const IDEMPOTENCY_HEADERS = new Set(['idempotency-key', 'x-idempotency-key']);

export class ApiError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(`Request failed with status ${status}: ${detail}`);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Raised when the HTTP response JSON does not conform to its Zod schema
 * (BUG-FRONTEND-INFRA-024). The caller sees a typed error they can surface
 * as "Something changed on the server — please update the app"; the console
 * logs the full Zod issue list so we can triage the mismatch.
 */
export class ApiValidationError extends Error {
  status: number;
  issues: z.ZodIssue[];
  path: string;

  constructor(path: string, status: number, issues: z.ZodIssue[]) {
    super(`Response validation failed for ${path}: ${issues.length} issue(s)`);
    this.name = 'ApiValidationError';
    this.status = status;
    this.issues = issues;
    this.path = path;
  }
}

/** Raised when a fetch times out before any response is received. */
export class ApiTimeoutError extends Error {
  constructor(path: string, timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms: ${path}`);
    this.name = 'ApiTimeoutError';
  }
}

/** Observer called with whether the client believes the network is reachable. */
let networkOnlineGetter: (() => boolean) | null = null;

export function setNetworkOnlineGetter(getter: (() => boolean) | null) {
  networkOnlineGetter = getter;
}

function isKnownOffline(): boolean {
  return networkOnlineGetter !== null && networkOnlineGetter() === false;
}

let tokenGetter: (() => string | null) | null = null;

/**
 * Reason a 401 surfaced.  Threaded through the unauthorized callback so
 * the AuthContext can distinguish:
 *
 *  - ``'session_expired'`` — the request carried a session token that the
 *    server rejected (token expired or invalidated).  Re-auth required.
 *  - ``'invalid_token'`` — the request carried a token that the server
 *    deems malformed/forged (``Bearer`` prefix issue, signature failure).
 *    Treat as a hard logout — the stored token is unusable.
 *  - ``'not_authenticated'`` — the request carried no token but hit a
 *    protected endpoint.  This is NOT a session expiration; it just means
 *    an anonymous caller poked an authed surface.  The auth context
 *    should NOT show a "session expired" banner — there was no session.
 *
 * BUG-API-018: previously every 401 collapsed into the single
 * "session expired" path, so an anonymous request that hit a protected
 * endpoint, or a login attempt with the wrong password, both displayed
 * the misleading "Your session has expired" banner.  The reason is now
 * forwarded so the UI can branch.
 */
export type UnauthorizedReason = 'session_expired' | 'invalid_token' | 'not_authenticated';

let onUnauthorizedCallback: ((reason: UnauthorizedReason) => void) | null = null;
/**
 * Callback invoked when the API layer refreshes the JWT.
 *
 * Receives the new token plus the server's record of `User.timezone` so
 * the auth context can keep `userTimezone` in sync without a follow-up
 * `GET /users/me`.  The timezone is `string | undefined` because legacy
 * API builds may omit it; consumers should fall back to `'UTC'`.
 */
let onTokenRefreshedCallback: ((token: string, timezone: string | undefined) => void) | null = null;
let llmApiKeyGetter: (() => string | null) | null = null;

/** Header used to forward a user-provided LLM API key (BYOK, issue #185). */
export const LLM_API_KEY_HEADER = 'X-LLM-API-Key'; // pragma: allowlist secret

/**
 * Canonical header name for client-supplied idempotency keys (BUG-API-008).
 * Matches the IETF draft (``draft-ietf-httpapi-idempotency-key-header``)
 * the backend already routes through its dedupe middleware.
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/**
 * Build a deterministic idempotency key for a mutation (BUG-API-008).
 *
 * The shape ``intent[:part]*`` is intentional: a key derived from the
 * user's INTENT (e.g. ``log-unit:42:2026-05-10``) is stable across the
 * built-in retry loop and across the user retrying after a network blip
 * -- both surface the same key, so the backend dedupes the duplicate
 * write instead of recording it twice.  Wall-clock values are forbidden
 * here on purpose: a UUID or ``Date.now()`` would defeat dedup by
 * minting a fresh key on every attempt.
 *
 * Callers pass the result via ``headers: { [IDEMPOTENCY_KEY_HEADER]: ... }``
 * on POST/PUT/PATCH; the existing ``hasIdempotencyHeader`` check then
 * promotes the request into the retry-eligible set automatically.
 */
export function idempotencyKey(intent: string, ...parts: (string | number)[]): string {
  if (!intent) {
    throw new Error('idempotencyKey: intent must be non-empty');
  }
  return parts.length === 0 ? intent : `${intent}:${parts.join(':')}`;
}

export function setTokenGetter(getter: (() => string | null) | null) {
  tokenGetter = getter;
}

export function setOnUnauthorized(callback: ((reason: UnauthorizedReason) => void) | null) {
  onUnauthorizedCallback = callback;
}

export function setOnTokenRefreshed(
  callback: ((token: string, timezone: string | undefined) => void) | null,
) {
  onTokenRefreshedCallback = callback;
}

/**
 * Register a getter for the user-owned LLM API key. When registered and
 * non-null, the key is attached to BotMason chat requests via the
 * ``X-LLM-API-Key`` header. The getter is polled per-request so rotations
 * take effect without reconfiguring the HTTP client.
 */
export function setLlmApiKeyGetter(getter: (() => string | null) | null) {
  llmApiKeyGetter = getter;
}

interface RequestOptions<TResponse = unknown> {
  method?: string;
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
  /** Zod schema for BUG-024 runtime validation. Optional for incremental rollout. */
  schema?: z.ZodType<TResponse>;
  /** Per-request timeout override (used by BotMason streaming). */
  timeoutMs?: number;
  /** External abort signal; respected alongside the timeout. */
  signal?: AbortSignal;
}

function resolveToken(token?: string): string | null {
  return token ?? tokenGetter?.() ?? null;
}

function buildHeaders(
  resolvedToken: string | null,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...(resolvedToken ? { Authorization: `Bearer ${resolvedToken}` } : {}),
    ...extraHeaders,
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function buildFetchInit(
  method: string,
  body: unknown,
  headers: Record<string, string>,
): RequestInit | undefined {
  const init: RequestInit = {};
  if (method !== 'GET') {
    init.method = method;
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  if (Object.keys(headers).length > 0) {
    init.headers = headers;
  }
  return Object.keys(init).length > 0 ? init : undefined;
}

function hasIdempotencyHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((h) => IDEMPOTENCY_HEADERS.has(h.toLowerCase()));
}

function isRetryableMethod(method: string, headers?: Record<string, string>): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  return hasIdempotencyHeader(headers);
}

/** True for network-level or explicitly transient HTTP failures. */
function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUSES.has(status);
}

function isAbortError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const maybe = err as { name?: unknown };
  return maybe.name === 'AbortError';
}

function computeBackoffMs(attempt: number): number {
  // Exponential with 100% jitter so lots of clients reconnecting after an
  // outage don't align on the same millisecond.
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return Math.floor(exponential * (0.5 + Math.random()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap a ``fetch`` with an ``AbortController`` + timeout, honouring any
 * caller-supplied signal. Surfaces ``ApiTimeoutError`` when the clock wins
 * so callers can branch on it separately from "server replied with an error".
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
  path: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', forwardAbort);
  }
  try {
    const merged: RequestInit = { ...(init ?? {}), signal: controller.signal };
    return await fetch(url, merged);
  } catch (err: unknown) {
    if (isAbortError(err) && !externalSignal?.aborted) {
      throw new ApiTimeoutError(path, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', forwardAbort);
  }
}

async function extractErrorDetail(res: Response): Promise<string> {
  try {
    const errBody = await res.json();
    if (errBody.detail && typeof errBody.detail === 'string') {
      return errBody.detail;
    }
  } catch {
    // response body wasn't JSON — use default
  }
  return 'Request failed';
}

/**
 * Map a 401 detail string to a structured {@link UnauthorizedReason}.
 *
 * The backend already returns a small, stable vocabulary
 * (``invalid_credentials`` for login failures, ``unauthorized`` for
 * any token rejection, etc. — see ``backend/src/routers/auth.py``).
 * This function is the single place that translates those tokens into
 * the higher-level reason the AuthContext branches on, so a future
 * backend addition (``token_revoked``, ``mfa_required``) needs only
 * one map entry to wire end-to-end.
 *
 * BUG-API-018: returns ``null`` for ``invalid_credentials`` because the
 * caller (the login form) handles that 401 with its own UI -- it must
 * NOT surface as a session-expired logout.
 */
export function classifyUnauthorizedDetail(detail: string | null): UnauthorizedReason | null {
  switch (detail) {
    case 'unauthorized':
      // Backend's deliberately-generic "your token is bad" detail.
      // Cannot tell expired from forged from revoked from the wire (the
      // server hides that distinction on purpose, OWASP A07), so we
      // treat it as the most common case: a session that aged out.
      return 'session_expired';
    case 'invalid_token':
      return 'invalid_token';
    case 'invalid_credentials':
      // Wrong password / unknown email on /auth/login.  The login UI
      // owns this 401; the global unauthorized handler should NOT fire.
      return null;
    default:
      // Unknown detail (or no detail).  Returning ``null`` here means
      // "no opinion": ``reasonForUnauthorized`` makes the final call
      // based on whether a session token was actually attached to the
      // request, falling back to ``session_expired`` (had token) or
      // ``not_authenticated`` (anonymous).
      return null;
  }
}

async function handleErrorResponse(res: Response): Promise<never> {
  const detail = await extractErrorDetail(res);
  throw new ApiError(res.status, detail);
}

/**
 * Validate a response body with a Zod schema and raise
 * {@link ApiValidationError} if it does not conform. We intentionally log the
 * raw data at ``console.warn`` level so operators can diff the wire against
 * the frontend expectation when a deploy goes sideways.
 */
function validateWithSchema<T>(
  path: string,
  status: number,
  schema: z.ZodType<T>,
  data: unknown,
): T {
  const parsed = schema.safeParse(data);
  if (parsed.success) return parsed.data;
  console.warn('[api] response validation failed', {
    path,
    status,
    issues: parsed.error.issues,
    // Don't leak full bodies in prod logs; the issue list already points at
    // the offending path + reason. ``DEV`` flag lets engineers see the full
    // body locally to triage quickly.
    data: __DEV__ ? data : undefined,
  });
  throw new ApiValidationError(path, status, parsed.error.issues);
}

async function parseResponse<T>(res: Response, path = '', schema?: z.ZodType<T>): Promise<T> {
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json();
  if (schema) return validateWithSchema(path, res.status, schema, data);
  return data as T;
}

/** Outcome of a refresh attempt; ``hadToken`` separates "no session" from "refresh failed". */
type RefreshResult = { token: string | null; hadToken: boolean };

/**
 * Shared in-flight refresh (audit-contracts-05). When several requests 401 at
 * once — the common cold-start / expired-token case — each used to call
 * ``attemptTokenRefresh`` independently, firing a storm of concurrent refreshes
 * against the same token. We now keep a single promise so N concurrent callers
 * await exactly one network refresh; it is cleared on settle so a later,
 * genuine refresh still fires.
 */
let inFlightRefresh: Promise<RefreshResult> | null = null;

async function performTokenRefresh(currentToken: string): Promise<RefreshResult> {
  try {
    // Route through ``fetchWithTimeout`` so a hung refresh aborts instead of
    // pinning the 401-retry loop; the ApiTimeoutError it throws on the clock
    // winning is caught below and surfaced as a refresh failure.
    const refreshRes = await fetchWithTimeout(
      `${API_BASE_URL}/auth/refresh`,
      { method: 'POST', headers: { Authorization: `Bearer ${currentToken}` } },
      FETCH_TIMEOUT_MS,
      undefined,
      '/auth/refresh',
    );
    if (!refreshRes.ok) return { token: null, hadToken: true };
    const raw: unknown = await refreshRes.json();
    // BUG-API-007 / BUG-API-017: the prior cast (``as AuthResponse``)
    // accepted any JSON shape -- a ``{}`` body would set ``data.token``
    // to ``undefined`` and the bearer header on the next request would
    // become ``Bearer undefined``, producing a zombie 401.  ``loginAuth
    // ResponseSchema`` enforces (i) the JWT three-segment shape and
    // (ii) ``user_id > 0`` (the ``user_id=0`` signup sentinel never
    // reaches /auth/refresh).  ``safeParse`` keeps us inside the
    // existing error path -- a malformed body becomes a refresh failure,
    // not an uncaught exception, so the 401 retry loop continues to
    // surface ``not_authenticated`` rather than crashing.
    const parsed = loginAuthResponseSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn('[api] /auth/refresh response failed validation', {
        issues: parsed.error.issues,
      });
      return { token: null, hadToken: true };
    }
    const data = parsed.data;
    // Forward the server's stored timezone so the AuthContext can keep
    // ``userTimezone`` in sync after a cold-start refresh.  Without
    // this, ``userTimezone`` would stay at its ``"UTC"`` default until
    // the user manually re-authenticated.
    onTokenRefreshedCallback?.(data.token, data.timezone);
    return { token: data.token, hadToken: true };
  } catch {
    return { token: null, hadToken: true };
  }
}

/**
 * Try to refresh the current token. Returns the new token on success, or
 * null if the refresh itself fails (e.g. the token is fully expired).
 *
 * Returns ``null`` immediately when the session has no token at all so
 * an anonymous request that hit a protected endpoint (BUG-API-018) does
 * NOT issue a doomed POST to /auth/refresh that would 401 again.  The
 * caller distinguishes "no token" from "refresh failed" via the second
 * tuple element.
 */
async function attemptTokenRefresh(): Promise<RefreshResult> {
  const currentToken = tokenGetter?.();
  if (!currentToken) return { token: null, hadToken: false };

  // Coalesce concurrent 401s onto a single refresh; clear on settle.
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = performTokenRefresh(currentToken).finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

function doFetch(
  url: string,
  init: RequestInit | undefined,
  opts: { path: string; timeoutMs?: number; signal?: AbortSignal } = { path: '' },
): Promise<Response> {
  return fetchWithTimeout(
    url,
    init,
    opts.timeoutMs ?? FETCH_TIMEOUT_MS,
    opts.signal,
    opts.path || url,
  );
}

interface RefreshRetryContext<T> {
  path: string;
  url: string;
  method: string;
  body: unknown;
  extraHeaders: Record<string, string> | undefined;
  schema: z.ZodType<T> | undefined;
  timeoutMs: number | undefined;
  signal: AbortSignal | undefined;
  /**
   * Detail string of the original 401 response.  Threaded through so
   * the unauthorized callback fires with the correct
   * {@link UnauthorizedReason} (BUG-API-018) instead of a generic
   * "session expired".
   */
  initialDetail: string | null;
}

/**
 * Translate the 401 detail (and whether a token was present) to a
 * structured {@link UnauthorizedReason} for the global callback.
 *
 * BUG-API-018: collapses the prior single "session expired" path into
 * three distinct reasons so the AuthContext can show "Sign in to
 * continue" for anonymous callers and "Session expired" for users
 * whose token actually aged out.
 *
 * The ``hadToken`` flag wins over the detail string when the request
 * was anonymous — there is no "session" to expire if we never sent
 * one, so any 401 in that case means "this endpoint requires auth"
 * regardless of how the server phrased it.  When a token was sent,
 * the detail string takes priority (``invalid_token`` stays distinct
 * from the default ``session_expired``).
 */
function reasonForUnauthorized(detail: string | null, hadToken: boolean): UnauthorizedReason {
  if (!hadToken) return 'not_authenticated';
  return classifyUnauthorizedDetail(detail) ?? 'session_expired';
}

/**
 * Attempt a token refresh and retry the original request once. Returns the
 * parsed response on success, or null if refresh/retry is not applicable.
 */
async function retryWithRefresh<T>(ctx: RefreshRetryContext<T>): Promise<T | null> {
  const refresh = await attemptTokenRefresh();
  if (refresh.token === null) {
    // Only fire the global "you are no longer authenticated" callback
    // when there *was* a session to begin with; an anonymous caller
    // hitting a protected endpoint is ``not_authenticated``, not
    // session-expired (BUG-API-018).
    onUnauthorizedCallback?.(reasonForUnauthorized(ctx.initialDetail, refresh.hadToken));
    return null;
  }
  const retryHeaders = buildHeaders(refresh.token, ctx.body, ctx.extraHeaders);
  const retryInit = buildFetchInit(ctx.method, ctx.body, retryHeaders);
  const retryRes = await doFetch(ctx.url, retryInit, {
    path: ctx.path,
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  });
  if (!retryRes.ok) {
    if (retryRes.status === 401) {
      const retryDetail = await extractErrorDetail(retryRes);
      onUnauthorizedCallback?.(reasonForUnauthorized(retryDetail, true));
      // Return the new ApiError below using the freshly-read detail so
      // the caller surfaces the post-retry server message rather than a
      // generic "Request failed".
      throw new ApiError(retryRes.status, retryDetail);
    }
    return handleErrorResponse(retryRes);
  }
  return parseResponse<T>(retryRes, ctx.path, ctx.schema);
}

async function handleUnauthorizedRetry<T>(
  token: string | undefined,
  ctx: RefreshRetryContext<T>,
): Promise<T | null> {
  const isAuthPath = ctx.path.startsWith('/auth/');
  // Login / signup own their own 401 UI -- never trigger the global
  // "session expired" callback from an auth endpoint.
  if (isAuthPath) return null;

  // BUG-API-018: ``invalid_credentials`` is a login-form failure, not a
  // session expiration.  Skip the unauthorized callback entirely so the
  // user does not get bounced to re-auth on top of the already-handled
  // form-level error.  Other unknown details fall through to the
  // refresh path below — they may still be a token issue we want to
  // surface as ``session_expired`` / ``not_authenticated``.
  if (ctx.initialDetail === 'invalid_credentials') return null;

  if (!token) {
    const retried = await retryWithRefresh<T>(ctx);
    if (retried !== null) return retried;
  } else {
    // Caller passed an explicit token override (e.g. probing with a
    // known-bad token from a settings screen).  Treat it as a session
    // expiration only when the explicit token came from the live
    // ``tokenGetter`` -- otherwise the global session is unaffected.
    const sessionToken = tokenGetter?.() ?? null;
    if (sessionToken !== null && sessionToken === token) {
      onUnauthorizedCallback?.(reasonForUnauthorized(ctx.initialDetail, true));
    }
  }
  return null;
}

/**
 * Execute a single HTTP attempt: dispatch fetch, route 401 through refresh,
 * parse the body. Returns a transient marker with the full ``ApiError`` so
 * callers can both retry and (if retries are exhausted) surface the real
 * server detail; throws a typed error otherwise.
 */
async function attemptRequest<T>(
  ctx: RefreshRetryContext<T>,
  token: string | undefined,
): Promise<{ kind: 'ok'; value: T } | { kind: 'transient'; error: ApiError }> {
  const resolved = resolveToken(token);
  const headers = buildHeaders(resolved, ctx.body, ctx.extraHeaders);
  const init = buildFetchInit(ctx.method, ctx.body, headers);
  const res = await doFetch(ctx.url, init, {
    path: ctx.path,
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  });

  if (res.ok) {
    const value = await parseResponse<T>(res, ctx.path, ctx.schema);
    return { kind: 'ok', value };
  }
  if (res.status === 401) {
    // Read the body once and stash the detail on ctx so both the
    // unauthorized-retry path and the eventual ``ApiError`` throw use
    // the same value (BUG-API-018).  Without this we would either
    // re-read the body (it is consumed already) or throw a generic
    // "Request failed" string, both of which lose the reason needed
    // to distinguish ``not_authenticated`` from ``session_expired``.
    const detail = await extractErrorDetail(res);
    ctx.initialDetail = detail;
    const retried = await handleUnauthorizedRetry<T>(token, ctx);
    if (retried !== null) return { kind: 'ok', value: retried };
    throw new ApiError(res.status, detail);
  }
  if (isTransientStatus(res.status) && isRetryableMethod(ctx.method, ctx.extraHeaders)) {
    const detail = await extractErrorDetail(res);
    return { kind: 'transient', error: new ApiError(res.status, detail) };
  }
  return handleErrorResponse(res);
}

function isRetryableException(err: unknown, canRetry: boolean): boolean {
  if (!canRetry) return false;
  if (err instanceof ApiTimeoutError) return true;
  if (err instanceof TypeError && err.message.toLowerCase().includes('network')) return true;
  if (!(err instanceof Error)) return false;
  return err.name !== 'ApiError' && err.name !== 'ApiValidationError' && err.name !== 'AbortError';
}

async function runAttempt<T>(
  ctx: RefreshRetryContext<T>,
  token: string | undefined,
  canRetry: boolean,
): Promise<{ kind: 'ok'; value: T } | { kind: 'retry'; error: Error }> {
  try {
    const outcome = await attemptRequest<T>(ctx, token);
    if (outcome.kind === 'ok') return outcome;
    // Transient response — retain the real server detail so the eventual
    // throw preserves the specific status instead of a generic placeholder.
    return { kind: 'retry', error: outcome.error };
  } catch (err: unknown) {
    if (!isRetryableException(err, canRetry)) throw err;
    return { kind: 'retry', error: err as Error };
  }
}

async function request<T>(
  path: string,
  {
    method = 'GET',
    body,
    token,
    headers: extraHeaders,
    schema,
    timeoutMs,
    signal,
  }: RequestOptions<T> = {},
): Promise<T> {
  const ctx: RefreshRetryContext<T> = {
    path,
    url: `${API_BASE_URL}${path}`,
    method,
    body,
    extraHeaders,
    schema,
    timeoutMs,
    signal,
    initialDetail: null,
  };

  // Fast-fail when the network layer already knows we're offline: retrying
  // would just stall each attempt until the timeout. The caller can catch
  // the ApiError and queue the request to replay on reconnect.
  if (isKnownOffline() && method.toUpperCase() === 'GET') {
    throw new ApiError(0, 'network_error');
  }

  const canRetry = isRetryableMethod(method, extraHeaders);
  const totalAttempts = canRetry ? MAX_RETRIES + 1 : 1;
  let lastError: Error = new ApiError(0, 'network_error');
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const outcome = await runAttempt<T>(ctx, token, canRetry);
    if (outcome.kind === 'ok') return outcome.value;
    lastError = outcome.error;
    if (attempt < totalAttempts) await delay(computeBackoffMs(attempt));
  }
  throw lastError;
}

// Habit types and client
// These interfaces match the backend schemas (schemas/habit.py, schemas/goal.py).

export type NotificationFrequency = 'daily' | 'weekly' | 'custom' | 'off';

/** One row of a goal's logged completion history (BUG-FE-HABIT-301). */
export interface ApiGoalCompletion {
  id: number;
  timestamp: string;
  completed_units: number;
}

export interface ApiGoal {
  id: number;
  habit_id: number;
  title: string;
  description?: string | null;
  tier: string;
  target: number;
  target_unit: string;
  frequency: number;
  frequency_unit: string;
  is_additive: boolean;
  goal_group_id?: number | null;
  /** Weekly cadence ("Mon".."Sun"); null/absent means every day. */
  days_of_week?: string[] | null;
  /** Optional for back-compat with API builds that don't yet embed completions. */
  completions?: ApiGoalCompletion[];
}

export interface ApiGoalGroup {
  id: number;
  name: string;
  icon?: string | null;
  description?: string | null;
  user_id?: number | null;
  shared_template: boolean;
  source?: string | null;
  goals: ApiGoal[];
}

export interface GoalGroupCreatePayload {
  name: string;
  icon?: string | null;
  description?: string | null;
  shared_template?: boolean;
  source?: string | null;
}

export interface ApiHabit {
  id: number;
  // ``user_id`` is intentionally absent — see ``habitSchema`` in ``schemas.ts``.
  name: string;
  icon: string;
  start_date: string;
  energy_cost: number;
  energy_return: number;
  notification_times?: string[] | null;
  notification_frequency?: NotificationFrequency | null;
  notification_days?: string[] | null;
  milestone_notifications: boolean;
  sort_order?: number | null;
  stage: string;
  streak: number;
}

export interface ApiHabitWithGoals extends ApiHabit {
  goals: ApiGoal[];
}

export interface ApiHabitStats {
  day_labels: string[];
  values: number[];
  completions_by_day: number[];
  longest_streak: number;
  current_streak: number;
  total_completions: number;
  completion_rate: number;
  completion_dates: string[];
}

export interface HabitCreatePayload {
  name: string;
  icon: string;
  start_date: string;
  energy_cost: number;
  energy_return: number;
  notification_times?: string[] | null;
  notification_frequency?: NotificationFrequency | null;
  notification_days?: string[] | null;
  milestone_notifications?: boolean;
  sort_order?: number | null;
  stage?: string;
}

/**
 * Convert an API habit response (with goals) to the local Habit type used
 * throughout the frontend. Dates are converted from ISO strings to Date
 * objects and notification fields are mapped from snake_case API names to
 * the camelCase local convention.
 */
const NOTIFICATION_FREQUENCIES: readonly NotificationFrequency[] = [
  'daily',
  'weekly',
  'custom',
  'off',
];

function isNotificationFrequency(value: unknown): value is NotificationFrequency {
  return (
    typeof value === 'string' && (NOTIFICATION_FREQUENCIES as readonly string[]).includes(value)
  );
}

/**
 * Narrow a free-form string from the API to the ``Tier`` enum
 * (BUG-FRONTEND-INFRA-010). Unknown values default to ``"clear"`` rather than
 * crashing — a backend that rolls out a new tier silently won't crater the
 * UI while the schema waits for a follow-up deploy.
 */
function narrowTier(value: unknown): Tier {
  return isTier(value) ? value : 'clear';
}

export function toLocalHabit(apiHabit: ApiHabitWithGoals): LocalHabit {
  return {
    id: apiHabit.id,
    name: apiHabit.name,
    icon: apiHabit.icon,
    stage: apiHabit.stage,
    streak: apiHabit.streak,
    energy_cost: apiHabit.energy_cost,
    energy_return: apiHabit.energy_return,
    start_date: new Date(apiHabit.start_date),
    goals: apiHabit.goals.map((g) => ({
      id: g.id,
      title: g.title,
      tier: narrowTier(g.tier),
      target: g.target,
      target_unit: g.target_unit,
      frequency: g.frequency,
      frequency_unit: g.frequency_unit,
      is_additive: g.is_additive,
      goal_group_id: g.goal_group_id ?? null,
      days_of_week: g.days_of_week ?? undefined,
    })),
    completions: flattenGoalCompletions(apiHabit.goals),
    notificationTimes: apiHabit.notification_times ?? undefined,
    notificationFrequency: isNotificationFrequency(apiHabit.notification_frequency)
      ? apiHabit.notification_frequency
      : undefined,
    notificationDays: apiHabit.notification_days ?? undefined,
    milestoneNotifications: apiHabit.milestone_notifications,
  };
}

const habitWithGoalsArraySchema = z.array(habitWithGoalsSchema);
const habitPageSchema = pageSchema(habitWithGoalsSchema);

/**
 * Standard ``limit`` / ``offset`` knobs every ``listPaginated`` helper accepts.
 * Both default to the server's values (limit 50, offset 0) when omitted.
 */
export interface PaginationParams {
  limit?: number;
  offset?: number;
}

/**
 * Build the query string shared by every ``listPaginated`` helper: always opt
 * into the ``Page`` envelope (``paginate=true``), append any endpoint-specific
 * filters (e.g. ``stage_number``), then ``limit`` / ``offset`` only when the
 * caller supplies them — mirroring ``habits.listPaginated`` above.
 */
function pageQuery(extra: Record<string, string | number>, params: PaginationParams): string {
  const query = new URLSearchParams({ paginate: 'true' });
  for (const [key, value] of Object.entries(extra)) query.set(key, String(value));
  if (params.limit != null) query.set('limit', String(params.limit));
  if (params.offset != null) query.set('offset', String(params.offset));
  return query.toString();
}

/**
 * Drain every page of a ``listPaginated``-style helper into one flat array.
 *
 * The screen-adoption path for the ``Page`` envelope (issue #408): every
 * list in the app is small today, so screens keep their whole-list render
 * while the wire contract moves to the envelope. A screen that later needs
 * true incremental loading calls its ``listPaginated`` helper directly with
 * offsets instead. The empty-page guard stops a buggy server from looping
 * forever on ``has_more: true``.
 */
export async function fetchAllPages<T>(
  fetchPage: (_params: PaginationParams) => Promise<Page<T>>,
): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  for (;;) {
    const result = await fetchPage({ offset });
    items.push(...result.items);
    if (!result.has_more || result.items.length === 0) return items;
    offset += result.items.length;
  }
}

// Collection-level habit URLs use a trailing slash to match the FastAPI route
// (`prefix="/habits"` + `@router.{get,post}("/")`). Without the slash, every
// request hit a 307 redirect — a wasted round-trip in the happy path and an
// outright failure mode on browsers that drop ``Authorization`` across the
// redirect (the symptom that surfaced as "logging units does nothing" on
// mobile web). Item-level URLs (`/habits/{id}`) are matched without the
// trailing slash because their FastAPI routes are declared that way.
export const habits = {
  list(token?: string): Promise<ApiHabitWithGoals[]> {
    return request<ApiHabitWithGoals[]>('/habits/', {
      token,
      schema: habitWithGoalsArraySchema as unknown as z.ZodType<ApiHabitWithGoals[]>,
    });
  },
  /**
   * Paginated habits list (BUG-INFRA-013). Opts into the server-side
   * ``Page`` envelope introduced alongside the backend pagination change;
   * callers that need ``total`` / ``has_more`` should prefer this over the
   * bare-list variant above.
   */
  listPaginated(
    params: { limit?: number; offset?: number } = {},
    token?: string,
  ): Promise<Page<ApiHabitWithGoals>> {
    const query = new URLSearchParams({ paginate: 'true' });
    if (params.limit != null) query.set('limit', String(params.limit));
    if (params.offset != null) query.set('offset', String(params.offset));
    return request<Page<ApiHabitWithGoals>>(`/habits/?${query.toString()}`, {
      token,
      schema: habitPageSchema as unknown as z.ZodType<Page<ApiHabitWithGoals>>,
    });
  },
  /** Whole habits list via the ``Page`` envelope (issue #408). */
  listAll(token?: string): Promise<ApiHabitWithGoals[]> {
    return fetchAllPages((params) => habits.listPaginated(params, token));
  },
  get(habitId: number, token?: string): Promise<ApiHabitWithGoals> {
    return request<ApiHabitWithGoals>(`/habits/${habitId}`, {
      token,
      schema: habitWithGoalsSchema as unknown as z.ZodType<ApiHabitWithGoals>,
    });
  },
  create(payload: HabitCreatePayload, token?: string): Promise<ApiHabit> {
    return request<ApiHabit>('/habits/', { method: 'POST', body: payload, token });
  },
  update(habitId: number, payload: HabitCreatePayload, token?: string): Promise<ApiHabit> {
    return request<ApiHabit>(`/habits/${habitId}`, { method: 'PUT', body: payload, token });
  },
  /**
   * Atomically update the shared unit fields on every goal of the habit
   * (issue #289). Replaces the per-tier ``goals.update`` fan-out whose
   * partial failure left tiers with mismatched units server-side.
   */
  updateGoalUnits(habitId: number, payload: GoalUnitsPayload, token?: string): Promise<ApiGoal[]> {
    return request<ApiGoal[]>(`/habits/${habitId}/goals/units`, {
      method: 'PUT',
      body: payload,
      token,
    });
  },
  delete(habitId: number, token?: string): Promise<void> {
    return request<void>(`/habits/${habitId}`, { method: 'DELETE', token });
  },
  getStats(habitId: number, token?: string): Promise<ApiHabitStats> {
    return request<ApiHabitStats>(`/habits/${habitId}/stats`, { token });
  },
};

// Goal completion types and client
export interface GoalCompletionPayload {
  goal_id: number;
  did_complete?: boolean;
  /**
   * Calendar day (``YYYY-MM-DD``, user's timezone) the check-in is for.
   * Omit to log today; supply a past day to backfill a missed one.
   */
  completed_on?: string;
}

export interface CheckInResult {
  streak: number;
  milestones: Array<{ threshold: number }>;
  reason_code: string;
}

export const goalCompletions = {
  // Trailing slash — see the rationale on the ``habits`` client above.
  //
  // BUG-API-008: ``options.idempotencyKey`` lets the caller (the check-in
  // screen) pass a deterministic key built via :func:`idempotencyKey`
  // (e.g. ``log-unit:${goalId}:${dayISO}``).  Without it, a network blip
  // mid-tap or the user mashing the button surfaces as duplicate
  // completions; with it, the backend's dedupe layer reuses the prior
  // result.  Optional for back-compat with screens that have not yet
  // adopted the helper.
  create(
    payload: GoalCompletionPayload,
    options: { token?: string; idempotencyKey?: string } = {},
  ): Promise<CheckInResult> {
    return request<CheckInResult>('/goal_completions/', {
      method: 'POST',
      body: payload,
      token: options.token,
      headers: options.idempotencyKey
        ? { [IDEMPOTENCY_KEY_HEADER]: options.idempotencyKey }
        : undefined,
    });
  },
};

// Goal write payload — fields the editor exposes. ``habit_id`` is omitted
// because a goal is bound to its parent habit for life and the server's
// ``GoalUpdate`` schema rejects any attempt to forge it.
/** Shared unit fields for the atomic all-tiers update (issue #289). */
export interface GoalUnitsPayload {
  target_unit: string;
  frequency: number;
  frequency_unit: string;
}

export interface GoalUpdatePayload {
  title: string;
  description?: string | null;
  tier: string;
  target: number;
  target_unit: string;
  frequency: number;
  frequency_unit: string;
  is_additive: boolean;
  goal_group_id?: number | null;
  days_of_week?: string[] | null;
}

export const goals = {
  update(goalId: number, payload: GoalUpdatePayload, token?: string): Promise<ApiGoal> {
    return request<ApiGoal>(`/goals/${goalId}`, { method: 'PUT', body: payload, token });
  },
};

// Goal group client
export const goalGroups = {
  list(token?: string): Promise<ApiGoalGroup[]> {
    return request<ApiGoalGroup[]>('/goal-groups/', { token });
  },
  /**
   * Paginated goal-groups list (BUG-INFRA-015). Opts into the ``Page``
   * envelope; prefer this over the bare-list variant when ``total`` /
   * ``has_more`` are needed for a "load more" control.
   */
  listPaginated(params: PaginationParams = {}, token?: string): Promise<Page<ApiGoalGroup>> {
    return request<Page<ApiGoalGroup>>(`/goal-groups/?${pageQuery({}, params)}`, {
      token,
      schema: pageSchema(apiGoalGroupSchema) as unknown as z.ZodType<Page<ApiGoalGroup>>,
    });
  },
  get(groupId: number, token?: string): Promise<ApiGoalGroup> {
    return request<ApiGoalGroup>(`/goal-groups/${groupId}`, { token });
  },
  create(payload: GoalGroupCreatePayload, token?: string): Promise<ApiGoalGroup> {
    return request<ApiGoalGroup>('/goal-groups/', { method: 'POST', body: payload, token });
  },
  update(groupId: number, payload: GoalGroupCreatePayload, token?: string): Promise<ApiGoalGroup> {
    return request<ApiGoalGroup>(`/goal-groups/${groupId}`, {
      method: 'PUT',
      body: payload,
      token,
    });
  },
  delete(groupId: number, token?: string): Promise<void> {
    return request<void>(`/goal-groups/${groupId}`, { method: 'DELETE', token });
  },
};

// Journal types and client
export type JournalTag = 'freeform' | 'stage_reflection' | 'practice_note' | 'habit_note';

export interface JournalMessageCreate {
  message: string;
  tag?: JournalTag;
  practice_session_id?: number | null;
  user_practice_id?: number | null;
}

export type EntryStatus = 'draft' | 'finished';

export interface JournalMessage {
  id: number;
  message: string;
  sender: 'user' | 'bot';
  timestamp: string;
  tag: JournalTag;
  practice_session_id: number | null;
  user_practice_id: number | null;
  /** Editorial document fields (journal-resonance). */
  title?: string | null;
  status?: EntryStatus;
  updated_at?: string;
}

/**
 * PATCH body for editing an entry — only the provided fields are sent. Mirrors
 * the backend schema (message / title / status); ``tag`` is set at create time
 * and is not editable here.
 */
export interface JournalEntryUpdate {
  message?: string;
  title?: string | null;
  status?: EntryStatus;
}

export type MarginaliaKind = 'theme' | 'connection' | 'symbol';
export type MarginaliaStatus = 'active' | 'stale';

export interface Marginalia {
  id: number;
  journal_entry_id: number;
  kind: MarginaliaKind;
  anchor_start: number;
  anchor_end: number;
  anchor_text: string;
  note: string;
  essay: string | null;
  essay_generated_at: string | null;
  status: MarginaliaStatus;
  created_at: string;
  updated_at: string;
}

export interface ResonanceResponse {
  marginalia: Marginalia[];
  remaining_messages: number;
  remaining_balance: number;
  monthly_reset_date: string;
}

export interface MarginaliaListResponse {
  items: Marginalia[];
}

export interface JournalListResponse {
  items: JournalMessage[];
  total: number;
  has_more: boolean;
}

export interface JournalListParams {
  search?: string;
  tag?: string;
  practice_session_id?: number;
  limit?: number;
  offset?: number;
}

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
    return request<JournalListResponse>(`/journal${qs ? `?${qs}` : ''}`, {
      token,
      schema: journalListResponseSchema as unknown as z.ZodType<JournalListResponse>,
    });
  },
  get(entryId: number, token?: string): Promise<JournalMessage> {
    return request<JournalMessage>(`/journal/${entryId}`, { token });
  },
  create(entry: JournalMessageCreate, token?: string): Promise<JournalMessage> {
    return request<JournalMessage>('/journal', {
      method: 'POST',
      body: entry,
      token,
    });
  },
  /**
   * Edit an entry. Only the fields present on ``patch`` are sent (``JSON`` drops
   * ``undefined``), so callers can update the title without touching the body.
   */
  update(entryId: number, patch: JournalEntryUpdate, token?: string): Promise<JournalMessage> {
    return request<JournalMessage>(`/journal/${entryId}`, {
      method: 'PATCH',
      body: patch,
      token,
    });
  },
  delete(entryId: number, token?: string): Promise<void> {
    return request<void>(`/journal/${entryId}`, { method: 'DELETE', token });
  },
};

/** Optional bring-your-own-key header for the resonance LLM endpoints. */
// Resolve the bring-your-own-key header: an explicit per-call key wins, else the
// key registered by the BYOK provider (ApiKeyContext) at call time so rotations
// apply immediately. Empty/absent → no header (backend falls back to its env).
const byokHeaders = (apiKey?: string): Record<string, string> | undefined => {
  const key = apiKey ?? llmApiKeyGetter?.() ?? null;
  return key ? { [LLM_API_KEY_HEADER]: key } : undefined;
};

/**
 * Resonance + marginalia client (journal-resonance). ``generate`` and ``essay``
 * call the LLM (and may surface ``402 insufficient_offerings`` /
 * ``502 llm_provider_error`` as an ``ApiError``); ``list`` is a plain read.
 */
export const resonance = {
  /** Run a resonance pass over an entry: persists + returns notes and balances. */
  generate(entryId: number, token?: string, apiKey?: string): Promise<ResonanceResponse> {
    return request<ResonanceResponse>(`/journal/${entryId}/resonance`, {
      method: 'POST',
      token,
      headers: byokHeaders(apiKey),
    });
  },
  /** List an entry's margin notes (ordered by anchor position). */
  list(entryId: number, token?: string): Promise<MarginaliaListResponse> {
    return request<MarginaliaListResponse>(`/journal/${entryId}/marginalia`, { token });
  },
  /** Lazily generate (and cache) the long-form essay for one margin note. */
  essay(marginaliaId: number, token?: string, apiKey?: string): Promise<Marginalia> {
    return request<Marginalia>(`/journal/marginalia/${marginaliaId}/essay`, {
      method: 'POST',
      token,
      headers: byokHeaders(apiKey),
    });
  },
};

// Wallet (BotMason credit) types — the chat endpoints were retired with the
// journal-resonance redesign; only the wallet surface remains.
export interface BalanceResponse {
  balance: number;
}

export interface UsageResponse {
  monthly_messages_used: number;
  monthly_messages_remaining: number;
  monthly_cap: number;
  monthly_reset_date: string;
  offering_balance: number;
}

export const botmason = {
  getBalance(token?: string): Promise<BalanceResponse> {
    return request<BalanceResponse>('/user/balance', { token });
  },
  getUsage(token?: string): Promise<UsageResponse> {
    return request<UsageResponse>('/user/usage', { token });
  },
  addBalance(amount: number, token?: string): Promise<{ balance: number; added: number }> {
    return request<{ balance: number; added: number }>('/user/balance/add', {
      method: 'POST',
      body: { amount },
      token,
    });
  },
};

// Prompts types and client
export interface PromptDetail {
  week_number: number;
  question: string;
  has_responded: boolean;
  response: string | null;
  timestamp: string | null;
}

export interface PromptListResponse {
  items: PromptDetail[];
  // ``int | None`` on the backend — null when the count was not requested.
  // Consumers must guard (e.g. ``total ?? items.length``) before arithmetic.
  total: number | null;
  has_more: boolean;
}

export const prompts = {
  current(token?: string): Promise<PromptDetail> {
    return request<PromptDetail>('/prompts/current', { token });
  },
  respond(weekNumber: number, response: string, token?: string): Promise<PromptDetail> {
    return request<PromptDetail>(`/prompts/${weekNumber}/respond`, {
      method: 'POST',
      body: { response },
      token,
    });
  },
  history(
    params: { limit?: number; offset?: number } = {},
    token?: string,
  ): Promise<PromptListResponse> {
    const query = new URLSearchParams();
    if (params.limit != null) query.set('limit', String(params.limit));
    if (params.offset != null) query.set('offset', String(params.offset));
    const qs = query.toString();
    return request<PromptListResponse>(`/prompts/history${qs ? `?${qs}` : ''}`, {
      token,
      schema: promptListResponseSchema as unknown as z.ZodType<PromptListResponse>,
    });
  },
};

// Stage types and client
export interface Stage {
  id: number;
  title: string;
  subtitle: string;
  stage_number: number;
  overview_url: string;
  category: string;
  aspect: string;
  spiral_dynamics_color: string;
  growing_up_stage: string;
  divine_gender_polarity: string;
  relationship_to_free_will: string;
  free_will_description: string;
  is_unlocked: boolean;
  progress: number;
}

export interface StageProgressDetail {
  habits_progress: number;
  practice_sessions_completed: number;
  course_items_completed: number;
  overall_progress: number;
}

export interface PracticeHistoryItem {
  name: string;
  sessions_completed: number;
  total_minutes: number;
  last_session: string | null;
}

export interface HabitHistoryItem {
  name: string;
  icon: string;
  goals_achieved: Record<string, boolean>;
  best_streak: number;
  total_completions: number;
}

export interface StageHistoryResponse {
  stage_number: number;
  practices: PracticeHistoryItem[];
  habits: HabitHistoryItem[];
}

export const stages = {
  list(token?: string): Promise<Stage[]> {
    return request<Stage[]>('/stages', { token });
  },
  /**
   * Paginated stages list (BUG-INFRA-016). Opts into the ``Page`` envelope.
   * Note the route has no trailing slash (``/stages``), matching the backend.
   */
  listPaginated(params: PaginationParams = {}, token?: string): Promise<Page<Stage>> {
    return request<Page<Stage>>(`/stages?${pageQuery({}, params)}`, {
      token,
      schema: pageSchema(stageSchema),
    });
  },
  /** Whole stages list via the ``Page`` envelope (issue #408). */
  listAll(token?: string): Promise<Stage[]> {
    return fetchAllPages((params) => stages.listPaginated(params, token));
  },
  get(stageNumber: number, token?: string): Promise<Stage> {
    return request<Stage>(`/stages/${stageNumber}`, { token });
  },
  progress(stageNumber: number, token?: string): Promise<StageProgressDetail> {
    return request<StageProgressDetail>(`/stages/${stageNumber}/progress`, { token });
  },
  history(stageNumber: number, token?: string): Promise<StageHistoryResponse> {
    return request<StageHistoryResponse>(`/stages/${stageNumber}/history`, { token });
  },
};

// Course content types and client
export interface ContentItem {
  id: number;
  title: string;
  content_type: string;
  release_day: number;
  url: string | null;
  is_locked: boolean;
  is_read: boolean;
}

export interface CourseProgress {
  total_items: number;
  read_items: number;
  progress_percent: number;
  next_unlock_day: number | null;
}

export interface ContentCompletion {
  id: number;
  user_id: number;
  content_id: number;
  completed_at: string;
}

/** Raw Markdown body + metadata returned by the in-app content endpoints. */
export interface ContentBody {
  title: string;
  content_type: string;
  body_markdown: string;
}

/** One entry in the always-available "Site Resources" list. */
export interface SiteResource {
  slug: string;
  title: string;
  description: string;
  url: string;
}

export const course = {
  stageContent(stageNumber: number, token?: string): Promise<ContentItem[]> {
    return request<ContentItem[]>(`/course/stages/${stageNumber}/content`, { token });
  },
  /**
   * Paginated stage content (BUG-INFRA-018). Opts into the ``Page`` envelope.
   *
   * Caveat: pagination is applied *after* drip-feed filtering, so ``total``
   * reflects only the items the user can currently see — it grows as content
   * unlocks over time, without new database rows being added.
   */
  stageContentPaginated(
    stageNumber: number,
    params: PaginationParams = {},
    token?: string,
  ): Promise<Page<ContentItem>> {
    return request<Page<ContentItem>>(
      `/course/stages/${stageNumber}/content?${pageQuery({}, params)}`,
      {
        token,
        schema: pageSchema(contentItemSchema) as unknown as z.ZodType<Page<ContentItem>>,
      },
    );
  },
  /** Whole stage-content list via the ``Page`` envelope (issue #408). */
  stageContentAll(stageNumber: number, token?: string): Promise<ContentItem[]> {
    return fetchAllPages((params) => course.stageContentPaginated(stageNumber, params, token));
  },
  markRead(contentId: number, token?: string): Promise<ContentCompletion> {
    return request<ContentCompletion>(`/course/content/${contentId}/mark-read`, {
      method: 'POST',
      token,
    });
  },
  stageProgress(stageNumber: number, token?: string): Promise<CourseProgress> {
    return request<CourseProgress>(`/course/stages/${stageNumber}/progress`, { token });
  },
  contentBody(contentId: number, token?: string): Promise<ContentBody> {
    return request<ContentBody>(`/course/content/${contentId}/body`, { token });
  },
  siteResources(token?: string): Promise<SiteResource[]> {
    return request<SiteResource[]>('/course/site-resources', { token });
  },
  siteResourceBody(slug: string, token?: string): Promise<ContentBody> {
    return request<ContentBody>(`/course/site-resources/${slug}/body`, { token });
  },
};

// Practice types and client

export interface PracticeItem {
  id: number;
  stage_number: number;
  name: string;
  description: string;
  instructions: string;
  default_duration_minutes: number;
  // Absent on the wire — the backend ``PracticeResponse`` omits it to avoid
  // leaking who proposed a draft (BUG-PRACTICE-001 / BUG-SCHEMA-010). Optional
  // here so callers don't assume a value the server never sends; see
  // ``practiceItemSchema`` in ``schemas.ts``.
  submitted_by_user_id?: number | null;
  approved: boolean;
  /** ritual-01: discriminator for ``mode_config``. Older fixtures may omit. */
  mode?: string;
  /** ritual-01: per-mode authoring config (validated server-side as ModeConfig). */
  mode_config?: ModeConfig;
}

export interface UserPractice {
  id: number;
  user_id: number;
  practice_id: number;
  stage_number: number;
  start_date: string;
  end_date: string | null;
  /** ritual-03: per-user display name override; null when no override set. */
  custom_name?: string | null;
  /** ritual-03: per-user mode_config override (validated server-side as ModeConfig). */
  mode_config_override?: ModeConfig | null;
  /** ritual-03: server-resolved (custom_name ?? practice.name); may be absent on legacy payloads. */
  effective_name?: string | null;
  /** ritual-03: server-resolved (mode_config_override ?? practice.mode_config). */
  effective_config?: ModeConfig | null;
}

export interface UserPracticeCreate {
  practice_id: number;
  stage_number: number;
}

/**
 * Payload for ``PATCH /user-practices/{id}/customize`` (ritual-03).
 *
 * Both fields are nullable so a request can clear an override by passing
 * ``null`` explicitly: the backend treats ``null`` as "remove" and ``undefined``
 * (field absent from JSON) as "leave alone".
 */
export interface UserPracticeCustomize {
  custom_name?: string | null;
  mode_config_override?: ModeConfig | null;
}

/**
 * Per-mode session metadata mirroring the backend
 * :class:`schemas.practice_session_metadata.SessionMetadata`
 * discriminated union (ritual-04). The runtime payload is plain JSON;
 * the discriminator must match the resolved practice mode or the server
 * returns 400 ``mode_metadata_mismatch``.
 */
export interface MeditationTimerSessionMetadata {
  mode: 'meditation_timer';
}

export interface CountUpSessionMetadata {
  mode: 'count_up';
}

export interface MetronomeSessionMetadata {
  mode: 'metronome';
  bpm_used: number;
}

export interface IntervalBellSessionMetadata {
  mode: 'interval_bell';
  intervals_struck: number;
  total_intervals: number;
}

export interface RandomIntervalBellSessionMetadata {
  mode: 'random_interval_bell';
  bells_struck: number;
  /** Whole-second gap before each struck bell; one entry per bell. */
  interval_seconds: readonly number[];
}

export interface RepCounterSessionMetadata {
  mode: 'rep_counter';
  rep_count: number;
}

export interface SenseGroundingSessionMetadata {
  mode: 'sense_grounding';
  // Sense union duplicated inline (the engine layer owns the named type at
  // ``features/Practice/engine/types.SenseKind``); we keep the api wire
  // surface free of feature-layer imports.
  // KEEP IN SYNC WITH ``features/Practice/engine/types.SenseKind`` —
  // adding a new sense requires updating both unions or the engine emits
  // a value the wire layer can't represent (and TS won't catch it).
  senses_completed: ReadonlyArray<'sight' | 'touch' | 'hearing' | 'smell' | 'taste'>;
}

export interface TarotSessionMetadata {
  mode: 'tarot';
  card_index: number;
}

export interface CardMeditationSessionMetadata {
  mode: 'card_meditation';
  deck_id: string;
  card_drawn_name: string;
  /** Canonical deck index; omitted when the draw cannot be positioned. */
  card_drawn_index?: number;
}

export interface TalliedGroundingSessionMetadata {
  mode: 'tallied_grounding';
  rounds_completed: number;
  total_rounds: number;
  items_completed: number;
}

/**
 * Mirrors the engine ``MindfulAnchorMetadata`` shape
 * (``features/Practice/engine/types``). ``met_min_duration`` is emitted by
 * the client so the analytics rollup can tell "long enough" from
 * "abandoned early" without re-running the soft-floor comparison.
 */
export interface MindfulAnchorSessionMetadata {
  mode: 'mindful_anchor';
  chosen_option_key: string | null;
  duration_seconds: number;
  met_min_duration: boolean;
}

export type SessionMetadata =
  | MeditationTimerSessionMetadata
  | CountUpSessionMetadata
  | MetronomeSessionMetadata
  | IntervalBellSessionMetadata
  | RandomIntervalBellSessionMetadata
  | RepCounterSessionMetadata
  | SenseGroundingSessionMetadata
  | TalliedGroundingSessionMetadata
  | TarotSessionMetadata
  | CardMeditationSessionMetadata
  | MindfulAnchorSessionMetadata;

export interface PracticeSessionCreate {
  user_practice_id: number;
  // BUG-PRACTICE-006 / BUG-FE-PRACTICE-101: clients send wall-clock ISO
  // timestamps; the server derives ``duration_minutes`` so a backgrounded
  // ``setInterval`` can't under-report and a tampered client can't inflate.
  started_at: string;
  ended_at: string;
  reflection?: string | null;
  /** ritual-04: per-mode session metadata; discriminator must match practice mode. */
  mode_metadata?: SessionMetadata | null;
  /** ritual-04: ``true`` means the engine reached its terminal state. */
  completed?: boolean;
  /** ritual-12: short post-session insight (≤ 2,000 chars; distinct from ``reflection``). */
  insight?: string | null;
}

export interface PracticeSessionResponse {
  id: number;
  user_id: number;
  user_practice_id: number;
  duration_minutes: number;
  timestamp: string;
  reflection: string | null;
  /** ritual-04 fields — older sessions may have these absent on the wire. */
  mode?: string;
  mode_metadata?: SessionMetadata | null;
  completed?: boolean;
  insight?: string | null;
}

export interface WeekCountResponse {
  count: number;
}

/**
 * Ritual-04 rollup payload served at ``GET /practice-sessions/insights``.
 *
 * Mirrors ``backend/src/schemas/practice.py::PracticeInsightsResponse``.
 * `useWeeklyProgress` prefers the latest `weekly_counts` bucket but falls
 * back to `practiceSessions.weekCount()` if this route is unavailable.
 */
export interface PracticeWeeklyBucket {
  /** ISO date (YYYY-MM-DD) of the bucket's Monday in the user's TZ. */
  week_start: string;
  count: number;
}

export interface PracticeInsightsResponse {
  weekly_counts: PracticeWeeklyBucket[];
  streak_weeks: number;
  total_minutes_30d: number;
  avg_duration_minutes_30d: number | null;
  per_mode_counts: Record<string, number>;
  last_insight: string | null;
}

/**
 * Payload for ``POST /practices/`` (custom-practices-07).
 *
 * Mirrors the backend ``PracticeCreate`` schema: ``mode`` and ``mode_config``
 * are optional only for the legacy ``meditation_timer`` default — every
 * other mode requires both to be set, and the server returns 422 if they
 * disagree.
 */
export interface PracticeCreatePayload {
  stage_number: number;
  name: string;
  description: string;
  instructions: string;
  default_duration_minutes: number;
  mode?: string;
  mode_config?: ModeConfig;
}

export const practices = {
  /**
   * List approved practices for a stage.
   *
   * ``includeMine`` opts in to the backend's ``?include_mine=true`` flag
   * (custom-practices-07), which also returns the authenticated user's
   * own unapproved drafts so the catalog can render a "My drafts"
   * section. The default ``false`` preserves the legacy approved-only
   * behaviour for existing callers (e.g. useActivePractice).
   *
   * The numeric overload retains the historic ``practices.list(stage)``
   * signature so older call sites keep working without a churn pass.
   */
  async list(
    options: { stageNumber: number; includeMine?: boolean } | number,
    token?: string,
  ): Promise<PracticeItem[]> {
    const params = typeof options === 'number' ? { stageNumber: options } : options;
    const query = new URLSearchParams();
    query.set('stage_number', String(params.stageNumber));
    if (params.includeMine === true) query.set('include_mine', 'true');
    // Parse the array (don't filter): a drifted row now raises
    // ApiValidationError instead of silently vanishing from the catalog.
    return request<PracticeItem[]>(`/practices/?${query.toString()}`, {
      token,
      schema: z.array(practiceItemSchema) as unknown as z.ZodType<PracticeItem[]>,
    });
  },
  /**
   * Paginated practices list for a stage (BUG-INFRA-012). Opts into the
   * ``Page`` envelope; ``stage_number`` is required (the backend route filters
   * by stage). Prefer this over ``list`` when ``total`` / ``has_more`` matter.
   */
  listPaginated(
    params: { stageNumber: number; includeMine?: boolean } & PaginationParams,
    token?: string,
  ): Promise<Page<PracticeItem>> {
    const { stageNumber, includeMine, ...page } = params;
    const extra: Record<string, string | number> = { stage_number: stageNumber };
    if (includeMine === true) extra.include_mine = 'true';
    return request<Page<PracticeItem>>(`/practices/?${pageQuery(extra, page)}`, {
      token,
      schema: pageSchema(practiceItemSchema) as unknown as z.ZodType<Page<PracticeItem>>,
    });
  },
  /**
   * Whole practices list via the ``Page`` envelope (issue #408). Items are
   * validated per ``practiceItemSchema`` inside ``listPaginated``, so a
   * malformed row rejects the page (``fetchAllPages`` propagates the
   * ``ApiValidationError``) rather than being silently dropped.
   */
  async listAll(
    options: { stageNumber: number; includeMine?: boolean } | number,
    token?: string,
  ): Promise<PracticeItem[]> {
    const params = typeof options === 'number' ? { stageNumber: options } : options;
    return fetchAllPages((pageParams) =>
      practices.listPaginated({ ...params, ...pageParams }, token),
    );
  },
  get(practiceId: number, token?: string): Promise<PracticeItem> {
    return request<PracticeItem>(`/practices/${practiceId}`, {
      token,
      schema: practiceItemSchema as unknown as z.ZodType<PracticeItem>,
    });
  },
  /**
   * Submit a new user-created practice (custom-practices-07).
   *
   * Drafts land with ``approved=false``; the catalog filters them into
   * the "My drafts" section for the submitter alone.
   */
  create(payload: PracticeCreatePayload, token?: string): Promise<PracticeItem> {
    return request<PracticeItem>('/practices/', { method: 'POST', body: payload, token });
  },
};

export const userPractices = {
  create(payload: UserPracticeCreate, token?: string): Promise<UserPractice> {
    return request<UserPractice>('/user-practices/', { method: 'POST', body: payload, token });
  },
  list(token?: string): Promise<UserPractice[]> {
    return request<UserPractice[]>('/user-practices/', { token });
  },
  /**
   * Paginated user-practices list (BUG-INFRA-017). Opts into the ``Page``
   * envelope; prefer this over the bare-list variant when ``total`` /
   * ``has_more`` are needed.
   */
  listPaginated(params: PaginationParams = {}, token?: string): Promise<Page<UserPractice>> {
    return request<Page<UserPractice>>(`/user-practices/?${pageQuery({}, params)}`, {
      token,
      schema: pageSchema(userPracticeSchema) as unknown as z.ZodType<Page<UserPractice>>,
    });
  },
  /**
   * PATCH the per-user overrides (custom name + mode_config_override).
   *
   * Passing ``mode_config_override: null`` resets to the catalog default;
   * passing ``undefined`` (or omitting the field) leaves the existing
   * override untouched. The endpoint is documented in ritual-03; until
   * that PR lands, this client method targets the agreed-upon route so
   * the frontend can be cut over with no extra refactor.
   */
  customize(
    userPracticeId: number,
    payload: UserPracticeCustomize,
    token?: string,
  ): Promise<UserPractice> {
    return request<UserPractice>(`/user-practices/${userPracticeId}/customize`, {
      method: 'PATCH',
      body: payload,
      token,
    });
  },
};

/**
 * Mirrors the backend `PracticeTagOut` schema (migration `07b8c9d0e1f2`).
 *
 * `owner_user_id === null` marks a system tag (read-only); a non-null
 * value scopes the tag to one user. The personal namespace is
 * independent of the system one — a user can claim a slug a system
 * tag already uses.
 */
export interface PracticeTag {
  id: number;
  slug: string;
  label: string;
  owner_user_id: number | null;
  created_at: string;
}

export interface PracticeTagCreate {
  slug: string;
  label: string;
}

export interface PracticeTagUpdate {
  label: string;
}

// PracticeTag responses validate via practiceTagSchema so a drifted field raises
// ApiValidationError instead of a generic Error (audit-contracts-09).
const tagSchema = practiceTagSchema as unknown as z.ZodType<PracticeTag>;
const tagArraySchema = z.array(practiceTagSchema) as unknown as z.ZodType<PracticeTag[]>;

export const practiceTags = {
  list(token?: string): Promise<PracticeTag[]> {
    return request<PracticeTag[]>('/practice-tags/', { token, schema: tagArraySchema });
  },
  create(payload: PracticeTagCreate, token?: string): Promise<PracticeTag> {
    return request<PracticeTag>('/practice-tags/', {
      method: 'POST',
      body: payload,
      token,
      schema: tagSchema,
    });
  },
  update(tagId: number, payload: PracticeTagUpdate, token?: string): Promise<PracticeTag> {
    return request<PracticeTag>(`/practice-tags/${tagId}`, {
      method: 'PATCH',
      body: payload,
      token,
      schema: tagSchema,
    });
  },
  remove(tagId: number, token?: string): Promise<void> {
    return request<void>(`/practice-tags/${tagId}`, { method: 'DELETE', token });
  },
};

/**
 * Mirrors the backend `PracticeRecipeOut` schema. A recipe is a named
 * ordered collection of steps that materialises into a `mode_config`
 * payload on apply. `mode` is one of the recipe-capable modes
 * (`sense_grounding` or `tallied_grounding`).
 */
export type RecipeMode = 'sense_grounding' | 'tallied_grounding';

export interface PracticeRecipeStep {
  position: number;
  tag_slug: string;
  tag_label: string;
  prompt_label: string;
  target_count: number;
}

export interface PracticeRecipe {
  id: number;
  slug: string;
  name: string;
  description: string;
  owner_user_id: number | null;
  mode: RecipeMode;
  rounds: number;
  created_at: string;
  steps: PracticeRecipeStep[];
}

export interface PracticeRecipeStepInput {
  tag_slug: string;
  tag_label: string;
  prompt_label: string;
  target_count: number;
}

export interface PracticeRecipeCreate {
  slug: string;
  name: string;
  description?: string;
  mode: RecipeMode;
  rounds: number;
  steps: PracticeRecipeStepInput[];
}

export interface PracticeRecipeUpdate {
  name: string;
  description?: string;
  rounds: number;
  steps: PracticeRecipeStepInput[];
}

// PracticeRecipe responses are validated via ``practiceRecipeSchema`` so a
// drifted field raises ApiValidationError instead of being silently rejected
// with an opaque Error (audit-contracts-06).
const recipeSchema = practiceRecipeSchema as unknown as z.ZodType<PracticeRecipe>;
const recipeArraySchema = z.array(practiceRecipeSchema) as unknown as z.ZodType<PracticeRecipe[]>;

export const practiceRecipes = {
  list(mode?: RecipeMode, token?: string): Promise<PracticeRecipe[]> {
    const qs = mode ? `?mode=${encodeURIComponent(mode)}` : '';
    return request<PracticeRecipe[]>(`/practice-recipes/${qs}`, {
      token,
      schema: recipeArraySchema,
    });
  },
  get(recipeId: number, token?: string): Promise<PracticeRecipe> {
    return request<PracticeRecipe>(`/practice-recipes/${recipeId}`, {
      token,
      schema: recipeSchema,
    });
  },
  create(payload: PracticeRecipeCreate, token?: string): Promise<PracticeRecipe> {
    return request<PracticeRecipe>('/practice-recipes/', {
      method: 'POST',
      body: payload,
      token,
      schema: recipeSchema,
    });
  },
  update(recipeId: number, payload: PracticeRecipeUpdate, token?: string): Promise<PracticeRecipe> {
    return request<PracticeRecipe>(`/practice-recipes/${recipeId}`, {
      method: 'PATCH',
      body: payload,
      token,
      schema: recipeSchema,
    });
  },
  remove(recipeId: number, token?: string): Promise<void> {
    return request<void>(`/practice-recipes/${recipeId}`, { method: 'DELETE', token });
  },
  /**
   * Materialise the recipe into the target UserPractice's
   * `mode_config_override`. The backend re-validates against the catalog
   * mode and rejects cross-mode swaps with `400 mode_mismatch`.
   */
  apply(recipeId: number, userPracticeId: number, token?: string): Promise<UserPractice> {
    return request<UserPractice>(`/practice-recipes/${recipeId}/apply-to/${userPracticeId}`, {
      method: 'POST',
      token,
    });
  },
};

/**
 * Server-assembled frequency banner payload. Mirrors the
 * `FrequencyResponse` schema introduced in ritual-05
 * (`backend/src/routers/user_practices.py::GET /user-practices/current/frequency`).
 *
 * `banner_text` is the fully formatted English string — the client
 * renders it verbatim, never assembling the copy from the structured
 * fields. The structured fields are still exposed for chips and tests.
 *
 * TODO(ritual-05): once #310 (frequency-copy endpoint) merges, align this
 * hand-written shape with the backend response (e.g. via a shared Zod schema)
 * for end-to-end type safety.
 */
export interface FrequencyResponse {
  stage_number: number;
  color: string;
  aspect: string;
  practice_name: string;
  practice_id: number;
  user_practice_id: number | null;
  banner_text: string;
}

export const frequency = {
  /**
   * @param stageNumber Optional override. Pins the banner to a specific
   *   stage instead of the server-stored ``StageProgress.current_stage``;
   *   omit to keep the legacy "server decides" behaviour.
   * @param token Optional auth token. NOTE: ``stageNumber`` is the first
   *   parameter — a positional ``token`` would silently bind to it.
   *   Pass ``undefined`` for ``stageNumber`` if you only want to set
   *   ``token`` (``current(undefined, jwt)``).
   */
  async current(stageNumber?: number | null, token?: string): Promise<FrequencyResponse> {
    const query = new URLSearchParams();
    if (stageNumber != null) query.set('stage_number', String(stageNumber));
    const qs = query.toString();
    return request<FrequencyResponse>(`/user-practices/current/frequency${qs ? `?${qs}` : ''}`, {
      token,
      schema: frequencyResponseSchema as unknown as z.ZodType<FrequencyResponse>,
    });
  },
};

export const practiceSessions = {
  create(payload: PracticeSessionCreate, token?: string): Promise<PracticeSessionResponse> {
    return request<PracticeSessionResponse>('/practice-sessions/', {
      method: 'POST',
      body: payload,
      token,
    });
  },
  /**
   * Paginated session history for one user-practice (BUG-INFRA-014). Opts into
   * the ``Page`` envelope; ``userPracticeId`` is required (the backend route
   * scopes sessions to a single user-practice).
   */
  listPaginated(
    params: { userPracticeId: number } & PaginationParams,
    token?: string,
  ): Promise<Page<PracticeSessionResponse>> {
    const { userPracticeId, ...page } = params;
    return request<Page<PracticeSessionResponse>>(
      `/practice-sessions/?${pageQuery({ user_practice_id: userPracticeId }, page)}`,
      {
        token,
        schema: pageSchema(practiceSessionResponseSchema) as unknown as z.ZodType<
          Page<PracticeSessionResponse>
        >,
      },
    );
  },
  weekCount(token?: string): Promise<WeekCountResponse> {
    return request<WeekCountResponse>('/practice-sessions/week-count', { token });
  },
  /**
   * Ritual-04 rollup. The frontend prefers this when available and falls
   * back to ``weekCount()`` on failure — see `useWeeklyProgress`.
   */
  insights(token?: string): Promise<PracticeInsightsResponse> {
    return request<PracticeInsightsResponse>('/practice-sessions/insights', { token });
  },
};

// Practice share-link types and client (issue #348)

/**
 * Owner-supplied knobs for ``POST /practices/{id}/share-link``.
 *
 * Both fields are optional: omitting ``expires_in_days`` mints a never-expiring
 * link and omitting ``max_uses`` mints an unlimited one. The backend caps
 * the values (``ge=1, le=365`` for days, ``le=1000`` for max_uses).
 */
export interface ShareLinkCreateRequest {
  expires_in_days?: number | null;
  max_uses?: number | null;
}

/** Owner-facing view of a share link row. */
export interface ShareLinkResponse {
  id: number;
  token: string;
  practice_id: number;
  created_at: string;
  expires_at: string | null;
  max_uses: number | null;
  use_count: number;
  revoked_at: string | null;
}

/**
 * Recipient-facing preview returned by ``GET /practices/share/{token}``.
 *
 * Mirrors the catalog payload minus anything that would leak the source
 * row's owner id. ``created_by_display_name`` is the email-local-part the
 * backend derives so the recipient sees *something* identifying the
 * sender (full email is not exposed).
 */
export interface ShareLinkPreviewResponse {
  practice_id: number;
  stage_number: number;
  name: string;
  description: string;
  instructions: string;
  default_duration_minutes: number;
  mode: string;
  mode_config: Record<string, unknown>;
  created_by_display_name: string | null;
  expires_at: string | null;
  max_uses: number | null;
  use_count: number;
}

/** Result of redeeming a share link into a private draft. */
export interface ShareLinkImportResponse {
  practice_id: number;
  stage_number: number;
  name: string;
  approved: boolean;
}

export const practiceShare = {
  /**
   * Mint a new share link for a practice the caller owns (or any preset).
   * Backend rate-limits to 10/hour per user.
   */
  create(
    practiceId: number,
    payload: ShareLinkCreateRequest = {},
    token?: string,
  ): Promise<ShareLinkResponse> {
    return request<ShareLinkResponse>(`/practices/${practiceId}/share-link`, {
      method: 'POST',
      body: payload,
      token,
    });
  },
  /** List the caller's outstanding share links for a practice (owner only). */
  list(practiceId: number, token?: string): Promise<ShareLinkResponse[]> {
    return request<ShareLinkResponse[]>(`/practices/${practiceId}/share-links`, { token });
  },
  /** Preview a share link by token. Any signed-in user may call. */
  preview(shareToken: string, token?: string): Promise<ShareLinkPreviewResponse> {
    return request<ShareLinkPreviewResponse>(`/practices/share/${encodeURIComponent(shareToken)}`, {
      token,
    });
  },
  /** Redeem a share link, cloning the source into the recipient's catalog. */
  import(shareToken: string, token?: string): Promise<ShareLinkImportResponse> {
    return request<ShareLinkImportResponse>(
      `/practices/share/${encodeURIComponent(shareToken)}/import`,
      { method: 'POST', token },
    );
  },
  /** Revoke a share link the caller minted. Idempotent. */
  revoke(shareLinkId: number, token?: string): Promise<void> {
    return request<void>(`/practices/share-links/${shareLinkId}`, {
      method: 'DELETE',
      token,
    });
  },
};

// Auth types and client
export interface AuthRequest {
  email: string;
  password: string;
}

/**
 * Signup payload — `AuthRequest` plus the user's IANA timezone.
 *
 * The frontend sends `Intl.DateTimeFormat().resolvedOptions().timeZone`
 * on first signup so streak / daily-completion math computes "today" in
 * the user's local calendar from day one (closes the BUG-STREAK-002
 * write-path gap).  Optional on the wire — omitting it keeps the
 * column at its `"UTC"` default for clients still on the old payload
 * shape.
 */
export interface SignupRequest extends AuthRequest {
  timezone?: string;
}

export interface AuthResponse {
  token: string;
  user_id: number;
  /**
   * IANA timezone the server has on record for this user.  Returned on
   * signup / login / refresh so the frontend can wire it into the auth
   * context immediately and pass it to user-local helpers (Habit stats,
   * streak displays) without a follow-up `GET /users/me`.  Defaults to
   * `"UTC"` server-side -- see `BUG-FE-HABIT-002` / `-207` for the
   * call-site reasons that need this value.
   */
  timezone?: string;
}
/**
 * Request shapes for the password-recovery endpoints.  Mirror the
 * backend Pydantic schemas in ``backend/src/schemas/password_reset.py``.
 */
export interface PasswordResetRequestPayload {
  email: string;
}

export interface PasswordResetConfirmPayload {
  token: string;
  new_password: string;
}

export interface PasswordResetCancelPayload {
  token: string;
}

export const auth = {
  login(credentials: AuthRequest): Promise<AuthResponse> {
    // BUG-API-017: ``loginAuthResponseSchema`` enforces ``user_id > 0``
    // because the ``user_id == 0`` anti-enumeration sentinel only fires
    // on the signup endpoint.  A login that returned zero would be a
    // server bug, so we reject it at the boundary instead of letting
    // the AuthContext persist a zombie session.
    return request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: credentials,
      schema: loginAuthResponseSchema,
    });
  },
  signup(credentials: SignupRequest): Promise<AuthResponse> {
    return request<AuthResponse>('/auth/signup', {
      method: 'POST',
      body: credentials,
      schema: authResponseSchema,
    });
  },
  refresh(token: string): Promise<AuthResponse> {
    // BUG-API-017: refresh, like login, must never see ``user_id == 0``.
    return request<AuthResponse>('/auth/refresh', {
      method: 'POST',
      token,
      schema: loginAuthResponseSchema,
    });
  },
  /**
   * Kick off password recovery.  Always resolves on a 202 with the
   * generic anti-enumeration message; the caller should NOT distinguish
   * registered vs. unregistered email in its UI (SPEC R4).
   */
  requestPasswordReset(payload: PasswordResetRequestPayload): Promise<PasswordResetAcceptedT> {
    return request<PasswordResetAcceptedT>('/auth/password-reset/request', {
      method: 'POST',
      body: payload,
      schema: passwordResetAcceptedSchema,
    });
  },
  /**
   * Complete the reset by trading a single-use token for a fresh
   * AuthResponse.  On success the device is logged in and every
   * outstanding session for the user is invalidated server-side
   * (SPEC R7).
   */
  confirmPasswordReset(payload: PasswordResetConfirmPayload): Promise<AuthResponse> {
    // Mints a real session for an existing user; BUG-API-017 rejects
    // ``user_id == 0`` here too.
    return request<AuthResponse>('/auth/password-reset/confirm', {
      method: 'POST',
      body: payload,
      schema: loginAuthResponseSchema,
    });
  },
  /**
   * "This wasn't me" -- cancel a still-live token.  Returns 204 with
   * no body, regardless of whether the token was real (SPEC R4).
   */
  cancelPasswordReset(payload: PasswordResetCancelPayload): Promise<void> {
    return request<void>('/auth/password-reset/cancel', {
      method: 'POST',
      body: payload,
    });
  },
};

/** Inbound payload for ``PUT /users/me/timezone`` (issue #261). */
export interface TimezoneUpdatePayload {
  timezone: string;
}

// User profile client
export const users = {
  /**
   * Update the authenticated caller's IANA timezone (issue #261).
   *
   * The server applies the same trust-boundary rules as signup: an
   * unknown or oversized name is rejected with 422 and blank input
   * coerces to ``"UTC"``.  On success the caller should push the echoed
   * zone into ``AuthContext.setUserTimezone`` so user-local helpers
   * (Habit stats, streaks, weekday charts) pick it up immediately.
   */
  updateMyTimezone(payload: TimezoneUpdatePayload, token?: string): Promise<TimezoneReadT> {
    return request<TimezoneReadT>('/users/me/timezone', {
      method: 'PUT',
      body: payload,
      token,
      schema: timezoneReadSchema,
    });
  },
};

// Energy plan client
export const energy = {
  createPlan(body: EnergyPlanRequest, idempotencyKey?: string): Promise<EnergyPlanResponse> {
    return request<EnergyPlanResponse>('/v1/energy/plan', {
      method: 'POST',
      body,
      headers: idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : undefined,
    });
  },
};

export default {
  habits,
  goalCompletions,
  goalGroups,
  goals,
  journal,
  botmason,
  prompts,
  stages,
  course,
  practices,
  practiceShare,
  practiceRecipes,
  practiceTags,
  userPractices,
  frequency,
  practiceSessions,
  auth,
  users,
  energy,
  setTokenGetter,
  setOnUnauthorized,
  setOnTokenRefreshed,
  setLlmApiKeyGetter,
  setNetworkOnlineGetter,
  LLM_API_KEY_HEADER,
};
