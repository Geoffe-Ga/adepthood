import type { components, paths } from './types';

import { API_BASE_URL } from '@/config';

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

export function setTokenGetter(getter: (() => string | null) | null) {
  tokenGetter = getter;
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
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

// Habit types and client
export type Habit = components['schemas']['Habit'];
export const habits = {
  list(token?: string): Promise<Habit[]> {
    return request<Habit[]>('/habits', { token });
  },
};

// Journal types and client
export interface JournalEntry {
  id?: number;
  content: string;
}
export const journal = {
  create(entry: JournalEntry, token?: string): Promise<JournalEntry> {
    return request<JournalEntry>('/journal', {
      method: 'POST',
      body: entry,
      token,
    });
  },
};

// Stage types and client
export interface Stage {
  id: number;
  title: string;
}
export const stages = {
  list(token?: string): Promise<Stage[]> {
    return request<Stage[]>('/stages', { token });
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

export default { habits, journal, stages, practice, auth, energy };
