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

async function request<T>(
  path: string,
  { method = 'GET', body, token, headers: extraHeaders }: RequestOptions = {},
): Promise<T> {
  const resolvedToken = token ?? tokenGetter?.() ?? null;

  const headers: Record<string, string> = {
    ...(resolvedToken ? { Authorization: `Bearer ${resolvedToken}` } : {}),
    ...extraHeaders,
  };
  const init: RequestInit = {};
  if (method !== 'GET') {
    init.method = method;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (Object.keys(headers).length > 0) {
    init.headers = headers;
  }
  const res = Object.keys(init).length
    ? await fetch(`${API_BASE_URL}${path}`, init)
    : await fetch(`${API_BASE_URL}${path}`);
  if (!res.ok) {
    let detail = 'Request failed';
    try {
      const errBody = await res.json();
      if (errBody.detail && typeof errBody.detail === 'string') {
        detail = errBody.detail;
      }
    } catch {
      // response body wasn't JSON — use default
    }
    if (res.status === 401 && onUnauthorizedCallback) {
      onUnauthorizedCallback();
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
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

// Practice session types and client
export type PracticeSessionCreate = components['schemas']['PracticeSessionCreate'];
export type PracticeSession = components['schemas']['PracticeSession'];
export const practice = {
  log(session: PracticeSessionCreate, token?: string): Promise<PracticeSession> {
    return request<PracticeSession>('/practice_sessions', {
      method: 'POST',
      body: session,
      token,
    });
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
  journal,
  prompts,
  stages,
  practice,
  auth,
  energy,
  setTokenGetter,
  setOnUnauthorized,
};
