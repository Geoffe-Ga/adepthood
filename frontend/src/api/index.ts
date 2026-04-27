import { z } from 'zod';

import {
  authResponseSchema,
  habitWithGoalsSchema,
  isTier,
  pageSchema,
  type Page,
  type Tier,
} from './schemas';
import type { components, paths } from './types';

import { API_BASE_URL } from '@/config';
import type { Habit as LocalHabit } from '@/features/Habits/Habits.types';

// Re-export OpenAPI types for convenience
export type EnergyPlanRequest =
  paths['/v1/energy/plan']['post']['requestBody']['content']['application/json'];
export type EnergyPlanResponse =
  paths['/v1/energy/plan']['post']['responses']['200']['content']['application/json'];

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
let onUnauthorizedCallback: (() => void) | null = null;
let onTokenRefreshedCallback: ((token: string) => void) | null = null;
let llmApiKeyGetter: (() => string | null) | null = null;

/** Header used to forward a user-provided LLM API key (BYOK, issue #185). */
export const LLM_API_KEY_HEADER = 'X-LLM-API-Key'; // pragma: allowlist secret

export function setTokenGetter(getter: (() => string | null) | null) {
  tokenGetter = getter;
}

export function setOnUnauthorized(callback: (() => void) | null) {
  onUnauthorizedCallback = callback;
}

export function setOnTokenRefreshed(callback: ((token: string) => void) | null) {
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

/**
 * Try to refresh the current token. Returns the new token on success, or
 * null if the refresh itself fails (e.g. the token is fully expired).
 */
async function attemptTokenRefresh(): Promise<string | null> {
  const currentToken = tokenGetter?.();
  if (!currentToken) return null;

  try {
    const refreshRes = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${currentToken}` },
    });
    if (!refreshRes.ok) return null;
    const data = (await refreshRes.json()) as AuthResponse;
    onTokenRefreshedCallback?.(data.token);
    return data.token;
  } catch {
    return null;
  }
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
}

/**
 * Attempt a token refresh and retry the original request once. Returns the
 * parsed response on success, or null if refresh/retry is not applicable.
 */
async function retryWithRefresh<T>(ctx: RefreshRetryContext<T>): Promise<T | null> {
  const newToken = await attemptTokenRefresh();
  if (!newToken) {
    onUnauthorizedCallback?.();
    return null;
  }
  const retryHeaders = buildHeaders(newToken, ctx.body, ctx.extraHeaders);
  const retryInit = buildFetchInit(ctx.method, ctx.body, retryHeaders);
  const retryRes = await doFetch(ctx.url, retryInit, {
    path: ctx.path,
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  });
  if (!retryRes.ok) {
    if (retryRes.status === 401) onUnauthorizedCallback?.();
    return handleErrorResponse(retryRes);
  }
  return parseResponse<T>(retryRes, ctx.path, ctx.schema);
}

async function handleUnauthorizedRetry<T>(
  token: string | undefined,
  ctx: RefreshRetryContext<T>,
): Promise<T | null> {
  const isAuthPath = ctx.path.startsWith('/auth/');
  if (isAuthPath) return null;

  if (!token) {
    const retried = await retryWithRefresh<T>(ctx);
    if (retried !== null) return retried;
  } else {
    onUnauthorizedCallback?.();
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
    const retried = await handleUnauthorizedRetry<T>(token, ctx);
    if (retried !== null) return { kind: 'ok', value: retried };
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
  user_id: number;
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

/** @deprecated Use ApiHabit instead — this only includes the OpenAPI subset. */
export type Habit = components['schemas']['Habit'];

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
    })),
    completions: [],
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

export const habits = {
  list(token?: string): Promise<ApiHabitWithGoals[]> {
    return request<ApiHabitWithGoals[]>('/habits', {
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
    return request<Page<ApiHabitWithGoals>>(`/habits?${query.toString()}`, {
      token,
      schema: habitPageSchema as unknown as z.ZodType<Page<ApiHabitWithGoals>>,
    });
  },
  get(habitId: number, token?: string): Promise<ApiHabitWithGoals> {
    return request<ApiHabitWithGoals>(`/habits/${habitId}`, {
      token,
      schema: habitWithGoalsSchema as unknown as z.ZodType<ApiHabitWithGoals>,
    });
  },
  create(payload: HabitCreatePayload, token?: string): Promise<ApiHabit> {
    return request<ApiHabit>('/habits', { method: 'POST', body: payload, token });
  },
  update(habitId: number, payload: HabitCreatePayload, token?: string): Promise<ApiHabit> {
    return request<ApiHabit>(`/habits/${habitId}`, { method: 'PUT', body: payload, token });
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
}

export interface CheckInResult {
  streak: number;
  milestones: Array<{ threshold: number }>;
  reason_code: string;
}

export const goalCompletions = {
  create(payload: GoalCompletionPayload, token?: string): Promise<CheckInResult> {
    return request<CheckInResult>('/goal_completions', { method: 'POST', body: payload, token });
  },
};

// Goal group client
export const goalGroups = {
  list(token?: string): Promise<ApiGoalGroup[]> {
    return request<ApiGoalGroup[]>('/goal-groups/', { token });
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

export interface JournalMessage {
  id: number;
  message: string;
  sender: 'user' | 'bot';
  timestamp: string;
  tag: JournalTag;
  practice_session_id: number | null;
  user_practice_id: number | null;
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
    return request<JournalListResponse>(`/journal${qs ? `?${qs}` : ''}`, { token });
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
  delete(entryId: number, token?: string): Promise<void> {
    return request<void>(`/journal/${entryId}`, { method: 'DELETE', token });
  },
};

// BotMason AI chat types and client
export interface ChatRequest {
  message: string;
}

export interface ChatResponse {
  response: string;
  remaining_balance: number;
  remaining_messages: number;
  monthly_reset_date: string;
  bot_entry_id: number;
}

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

/** Callback bag for ``botmason.chatStream``. */
export interface ChatStreamCallbacks {
  /** Called once per ``event: chunk`` frame with the incremental text delta. */
  onChunk: (_text: string) => void;
  /** Called once, after the final ``event: complete`` frame, with the full payload. */
  onComplete: (_response: ChatResponse) => void;
  /**
   * Called when the server emits an ``event: error`` frame mid-stream. HTTP-level
   * failures (401/402/429/etc.) surface as a thrown ``ApiError`` instead so
   * callers can distinguish "never started" from "failed in flight".
   */
  onStreamError: (_error: { status: number; detail: string }) => void;
}

/**
 * Raised by ``chatStream`` when the runtime fetch implementation cannot expose
 * a streaming body (older React Native versions, misbehaving proxies). Callers
 * should catch this and fall back to the non-streaming ``chat`` endpoint.
 */
export class StreamingUnsupportedError extends Error {
  constructor() {
    super('streaming_unsupported');
    this.name = 'StreamingUnsupportedError';
  }
}

// Server-Sent Events frame separator (blank line). Extracted as a constant so
// the parser and splitter stay in lock-step.
const SSE_FRAME_SEPARATOR = '\n\n';
const SSE_EVENT_PREFIX = 'event: ';
const SSE_DATA_PREFIX = 'data: ';

type MinimalReadable = {
  getReader: () => {
    read: () => Promise<{ done: boolean; value?: Uint8Array }>;
    cancel?: () => Promise<void> | void;
  };
};

function asReadableStream(body: unknown): MinimalReadable | null {
  if (body !== null && typeof body === 'object' && 'getReader' in body) {
    return body as MinimalReadable;
  }
  return null;
}

interface SsePayload {
  event: string;
  data: string;
}

function parseSseFrame(frame: string): SsePayload | null {
  if (!frame.trim()) return null;
  let event = '';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith(SSE_EVENT_PREFIX)) event = line.slice(SSE_EVENT_PREFIX.length);
    else if (line.startsWith(SSE_DATA_PREFIX)) data = line.slice(SSE_DATA_PREFIX.length);
  }
  if (!event || !data) return null;
  return { event, data };
}

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
  const payload = safeJsonParse(parsed.data, callbacks);
  if (payload === undefined) return;
  if (parsed.event === 'chunk' && typeof (payload as { text?: string }).text === 'string') {
    callbacks.onChunk((payload as { text: string }).text);
  } else if (parsed.event === 'complete') {
    callbacks.onComplete(payload as ChatResponse);
  } else if (parsed.event === 'error') {
    callbacks.onStreamError(payload as { status: number; detail: string });
  }
}

/** Server-reported detail string when a single SSE frame can't be parsed as JSON. */
const MALFORMED_FRAME_DETAIL = 'malformed_stream_frame';

async function openChatStream(
  payload: ChatRequest,
  options: { token?: string; signal?: AbortSignal },
): Promise<Response> {
  const resolvedToken = resolveToken(options.token);
  const apiKey = llmApiKeyGetter?.() ?? null;
  const extraHeaders: Record<string, string> = {
    Accept: 'text/event-stream',
    ...(apiKey ? { [LLM_API_KEY_HEADER]: apiKey } : {}),
  };
  const headers = buildHeaders(resolvedToken, payload, extraHeaders);
  const path = '/journal/chat/stream';
  // BUG-001: even the streaming endpoint needs a (generous) wall clock.
  // 5 minutes is long enough to cover a large BotMason reply but still
  // short enough to eventually surface a wedged connection.
  return fetchWithTimeout(
    `${API_BASE_URL}${path}`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
      headers,
    },
    STREAM_TIMEOUT_MS,
    options.signal,
    path,
  );
}

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
    if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
    buffer = drainCompletedFrames(buffer, callbacks);
  }
  // Any trailing bytes that arrived without a terminating blank line still
  // need to be dispatched — servers may elide the final separator.
  if (buffer.trim()) dispatchSseFrame(buffer, callbacks);
}

function drainCompletedFrames(buffer: string, callbacks: ChatStreamCallbacks): string {
  const separatorIndex = buffer.lastIndexOf(SSE_FRAME_SEPARATOR);
  if (separatorIndex === -1) return buffer;
  const complete = buffer.slice(0, separatorIndex);
  const remainder = buffer.slice(separatorIndex + SSE_FRAME_SEPARATOR.length);
  for (const frame of complete.split(SSE_FRAME_SEPARATOR)) {
    dispatchSseFrame(frame, callbacks);
  }
  return remainder;
}

export const botmason = {
  chat(payload: ChatRequest, token?: string): Promise<ChatResponse> {
    // The user-owned key (if any) is fetched from the getter at call time
    // so rotations made in Settings apply immediately. A missing or empty
    // key means "fall back to the server-side env var" on the backend.
    const apiKey = llmApiKeyGetter?.() ?? null;
    const headers = apiKey ? { [LLM_API_KEY_HEADER]: apiKey } : undefined;
    return request<ChatResponse>('/journal/chat', {
      method: 'POST',
      body: payload,
      token,
      headers,
    });
  },
  /**
   * Open an SSE stream against ``/journal/chat/stream`` and dispatch each
   * event to the supplied callbacks. Returns only once the stream has closed
   * (either because ``complete`` arrived, an error frame arrived, or the
   * connection was aborted).
   *
   * Error semantics mirror ``chat``: HTTP-level failures raise ``ApiError``
   * so the caller can distinguish "auth expired" (retry won't help) from
   * "provider blipped" (retry might). Runtime failures to read the body
   * raise ``StreamingUnsupportedError`` so callers can seamlessly fall back
   * to the non-streaming endpoint.
   */
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
    await readChatStream(readable, callbacks);
  },
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
  total: number;
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
    return request<PromptListResponse>(`/prompts/history${qs ? `?${qs}` : ''}`, { token });
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

export const course = {
  stageContent(stageNumber: number, token?: string): Promise<ContentItem[]> {
    return request<ContentItem[]>(`/course/stages/${stageNumber}/content`, { token });
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
};

// Practice types and client

export interface PracticeItem {
  id: number;
  stage_number: number;
  name: string;
  description: string;
  instructions: string;
  default_duration_minutes: number;
  submitted_by_user_id: number | null;
  approved: boolean;
}

export interface UserPractice {
  id: number;
  user_id: number;
  practice_id: number;
  stage_number: number;
  start_date: string;
  end_date: string | null;
}

export interface UserPracticeCreate {
  practice_id: number;
  stage_number: number;
}

export interface PracticeSessionCreate {
  user_practice_id: number;
  duration_minutes: number;
  reflection?: string | null;
}

export interface PracticeSessionResponse {
  id: number;
  user_id: number;
  user_practice_id: number;
  duration_minutes: number;
  timestamp: string;
  reflection: string | null;
}

export interface WeekCountResponse {
  count: number;
}

function validatePracticeItem(item: unknown): item is PracticeItem {
  if (typeof item !== 'object' || item === null) return false;
  const p = item as Record<string, unknown>;
  return (
    typeof p.id === 'number' &&
    typeof p.name === 'string' &&
    typeof p.stage_number === 'number' &&
    typeof p.default_duration_minutes === 'number'
  );
}

export const practices = {
  async list(stageNumber: number, token?: string): Promise<PracticeItem[]> {
    const data = await request<PracticeItem[]>(`/practices/?stage_number=${stageNumber}`, {
      token,
    });
    return data.filter(validatePracticeItem);
  },
  async get(practiceId: number, token?: string): Promise<PracticeItem> {
    const data = await request<PracticeItem>(`/practices/${practiceId}`, { token });
    if (!validatePracticeItem(data)) throw new Error('Invalid practice response');
    return data;
  },
};

export const userPractices = {
  create(payload: UserPracticeCreate, token?: string): Promise<UserPractice> {
    return request<UserPractice>('/user-practices/', { method: 'POST', body: payload, token });
  },
  list(token?: string): Promise<UserPractice[]> {
    return request<UserPractice[]>('/user-practices/', { token });
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
  weekCount(token?: string): Promise<WeekCountResponse> {
    return request<WeekCountResponse>('/practice-sessions/week-count', { token });
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
 * write-path gap surfaced by the PR #260 review).  Optional on the wire
 * — omitting it keeps the column at its `"UTC"` default for clients
 * still on the old payload shape.
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
export const auth = {
  login(credentials: AuthRequest): Promise<AuthResponse> {
    return request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: credentials,
      schema: authResponseSchema,
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
    return request<AuthResponse>('/auth/refresh', {
      method: 'POST',
      token,
      schema: authResponseSchema,
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
  journal,
  botmason,
  prompts,
  stages,
  course,
  practices,
  userPractices,
  practiceSessions,
  auth,
  energy,
  setTokenGetter,
  setOnUnauthorized,
  setOnTokenRefreshed,
  setLlmApiKeyGetter,
  setNetworkOnlineGetter,
  LLM_API_KEY_HEADER,
};
