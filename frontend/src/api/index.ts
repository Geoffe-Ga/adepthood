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

export function setTokenGetter(getter: (() => string | null) | null) {
  tokenGetter = getter;
}

export function setOnUnauthorized(callback: (() => void) | null) {
  onUnauthorizedCallback = callback;
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

function handleUnauthorized(status: number): void {
  if (status === 401 && onUnauthorizedCallback) {
    onUnauthorizedCallback();
  }
}

async function handleErrorResponse(res: Response): Promise<never> {
  const detail = await extractErrorDetail(res);
  handleUnauthorized(res.status);
  throw new ApiError(res.status, detail);
}

async function parseResponse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function request<T>(
  path: string,
  { method = 'GET', body, token, headers: extraHeaders }: RequestOptions = {},
): Promise<T> {
  const resolved = resolveToken(token);
  const headers = buildHeaders(resolved, body, extraHeaders);
  const init = buildFetchInit(method, body, headers);
  const url = `${API_BASE_URL}${path}`;
  const res = init ? await fetch(url, init) : await fetch(url);
  if (!res.ok) return handleErrorResponse(res);
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

export interface ApiDailyCompletion {
  date: string;
  total_units: number;
}

export interface ApiHabitStats {
  current_streak: number;
  longest_streak: number;
  total_completions: number;
  completion_rate: number;
  completions_by_day_of_week: number[];
  daily_completions: ApiDailyCompletion[];
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
export interface JournalMessageCreate {
  message: string;
  is_stage_reflection?: boolean;
  is_practice_note?: boolean;
  is_habit_note?: boolean;
  practice_session_id?: number | null;
  user_practice_id?: number | null;
}

export interface JournalMessage {
  id: number;
  message: string;
  sender: 'user' | 'bot';
  user_id: number;
  timestamp: string;
  is_stage_reflection: boolean;
  is_practice_note: boolean;
  is_habit_note: boolean;
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
    return request<ChatResponse>('/journal/chat', {
      method: 'POST',
      body: payload,
      token,
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
};
