import { API_BASE_URL } from '@/config';

interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string;
}

async function request<T>(
  path: string,
  { method = 'GET', body, token }: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
    throw new Error(`Request failed with status ${res.status}`);
  }
  return (await res.json()) as T;
}

// Habit types and client
export interface Habit {
  id: number;
  name: string;
}
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
export interface PracticeSessionCreate {
  practiceId: number;
  duration: number;
}
export interface PracticeSession extends PracticeSessionCreate {
  id: number;
}
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
}
export const auth = {
  login(credentials: AuthRequest): Promise<AuthResponse> {
    return request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: credentials,
    });
  },
};

export default { habits, journal, stages, practice, auth };
