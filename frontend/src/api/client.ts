import type { paths } from './types';

type AuthRequest = { username: string; password: string };
type AuthResponse = { token: string; user_id: number };

let authToken: string | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}

export async function signup(baseUrl: string, credentials: AuthRequest): Promise<AuthResponse> {
  const res = await fetch(`${baseUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  if (!res.ok) {
    throw new Error(`Request failed with status ${res.status}`);
  }
  const data = (await res.json()) as AuthResponse;
  setAuthToken(data.token);
  return data;
}

export async function login(baseUrl: string, credentials: AuthRequest): Promise<AuthResponse> {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  if (!res.ok) {
    throw new Error(`Request failed with status ${res.status}`);
  }
  const data = (await res.json()) as AuthResponse;
  setAuthToken(data.token);
  return data;
}

export type EnergyPlanRequest =
  paths['/v1/energy/plan']['post']['requestBody']['content']['application/json'];
export type EnergyPlanResponse =
  paths['/v1/energy/plan']['post']['responses']['200']['content']['application/json'];

export async function createEnergyPlan(
  baseUrl: string,
  body: EnergyPlanRequest,
  idempotencyKey?: string,
): Promise<EnergyPlanResponse> {
  const res = await fetch(`${baseUrl}/v1/energy/plan`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Request failed with status ${res.status}`);
  }
  return (await res.json()) as EnergyPlanResponse;
}
