import type { components, paths } from './types';

import { API_BASE_URL } from '@/config';
import type { Habit as LocalHabit } from '@/features/Habits/Habits.types';

// Re-export OpenAPI types for convenience
export type EnergyPlanRequest =
  paths['/v1/energy/plan']['post']['requestBody']['content']['application/json'];
export type EnergyPlanResponse =
  paths['/v1/energy/plan']['post']['responses']['200']['content']['application/json'];

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

interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
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

async function parseResponse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
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

function doFetch(url: string, init: RequestInit | undefined): Promise<Response> {
  return init ? fetch(url, init) : fetch(url);
}

/**
 * Attempt a token refresh and retry the original request once. Returns the
 * parsed response on success, or null if refresh/retry is not applicable.
 */
async function retryWithRefresh<T>(
  url: string,
  method: string,
  body: unknown,
  extraHeaders: Record<string, string> | undefined,
): Promise<T | null> {
  const newToken = await attemptTokenRefresh();
  if (!newToken) {
    onUnauthorizedCallback?.();
    return null;
  }
  const retryHeaders = buildHeaders(newToken, body, extraHeaders);
  const retryInit = buildFetchInit(method, body, retryHeaders);
  const retryRes = await doFetch(url, retryInit);
  if (!retryRes.ok) {
    if (retryRes.status === 401) onUnauthorizedCallback?.();
    return handleErrorResponse(retryRes);
  }
  return parseResponse<T>(retryRes);
}

async function handleUnauthorizedRetry<T>(
  path: string,
  token: string | undefined,
  url: string,
  method: string,
  body: unknown,
  extraHeaders: Record<string, string> | undefined,
): Promise<T | null> {
  const isAuthPath = path.startsWith('/auth/');
  if (isAuthPath) return null;

  if (!token) {
    const retried = await retryWithRefresh<T>(url, method, body, extraHeaders);
    if (retried !== null) return retried;
  } else {
    onUnauthorizedCallback?.();
  }
  return null;
}

async function request<T>(
  path: string,
  { method = 'GET', body, token, headers: extraHeaders }: RequestOptions = {},
): Promise<T> {
  const resolved = resolveToken(token);
  const headers = buildHeaders(resolved, body, extraHeaders);
  const init = buildFetchInit(method, body, headers);
  const url = `${API_BASE_URL}${path}`;
  const res = await doFetch(url, init);

  if (!res.ok) {
    if (res.status === 401) {
      const retried = await handleUnauthorizedRetry<T>(
        path,
        token,
        url,
        method,
        body,
        extraHeaders,
      );
      if (retried !== null) return retried;
    }
    return handleErrorResponse(res);
  }
  return parseResponse<T>(res);
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
      tier: g.tier as 'low' | 'clear' | 'stretch',
      target: g.target,
      target_unit: g.target_unit,
      frequency: g.frequency,
      frequency_unit: g.frequency_unit,
      is_additive: g.is_additive,
      goal_group_id: g.goal_group_id ?? null,
    })),
    completions: [],
    notificationTimes: apiHabit.notification_times ?? undefined,
    notificationFrequency:
      (apiHabit.notification_frequency as LocalHabit['notificationFrequency']) ?? undefined,
    notificationDays: apiHabit.notification_days ?? undefined,
    milestoneNotifications: apiHabit.milestone_notifications,
  };
}

export const habits = {
  list(token?: string): Promise<ApiHabitWithGoals[]> {
    return request<ApiHabitWithGoals[]>('/habits', { token });
  },
  get(habitId: number, token?: string): Promise<ApiHabitWithGoals> {
    return request<ApiHabitWithGoals>(`/habits/${habitId}`, { token });
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
  user_id: number;
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
  bot_entry_id: number;
}

export interface BalanceResponse {
  balance: number;
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
  getBalance(token?: string): Promise<BalanceResponse> {
    return request<BalanceResponse>('/user/balance', { token });
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

export const practices = {
  list(stageNumber: number, token?: string): Promise<PracticeItem[]> {
    return request<PracticeItem[]>(`/practices/?stage_number=${stageNumber}`, { token });
  },
  get(practiceId: number, token?: string): Promise<PracticeItem> {
    return request<PracticeItem>(`/practices/${practiceId}`, { token });
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
  username: string;
  password: string;
}
export interface AuthResponse {
  token: string;
  user_id?: number;
}
export const auth = {
  login(credentials: AuthRequest): Promise<AuthResponse> {
    return request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: credentials,
    });
  },
  signup(credentials: AuthRequest): Promise<AuthResponse> {
    return request<AuthResponse>('/auth/signup', {
      method: 'POST',
      body: credentials,
    });
  },
  refresh(token: string): Promise<AuthResponse> {
    return request<AuthResponse>('/auth/refresh', {
      method: 'POST',
      token,
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
  LLM_API_KEY_HEADER,
};
