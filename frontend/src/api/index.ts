const API_BASE_URL = 'http://localhost:8000';

// Habit types and client
export interface Habit {
  id: number;
  name: string;
}
export const habits = {
  async list(): Promise<Habit[]> {
    const res = await fetch(`${API_BASE_URL}/habits`);
    return (await res.json()) as Habit[];
  },
};

// Journal types and client
export interface JournalEntry {
  id?: number;
  content: string;
}
export const journal = {
  async create(entry: JournalEntry): Promise<JournalEntry> {
    const res = await fetch(`${API_BASE_URL}/journal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    return (await res.json()) as JournalEntry;
  },
};

// Stage types and client
export interface Stage {
  id: number;
  title: string;
}
export const stages = {
  async list(): Promise<Stage[]> {
    const res = await fetch(`${API_BASE_URL}/stages`);
    return (await res.json()) as Stage[];
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
  async log(session: PracticeSessionCreate): Promise<PracticeSession> {
    const res = await fetch(`${API_BASE_URL}/practice_sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(session),
    });
    return (await res.json()) as PracticeSession;
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
  async login(credentials: AuthRequest): Promise<AuthResponse> {
    const res = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });
    return (await res.json()) as AuthResponse;
  },
};

export default { habits, journal, stages, practice, auth };
