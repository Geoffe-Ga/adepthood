import type { paths } from './types';

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
      ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Request failed with status ${res.status}`);
  }
  return (await res.json()) as EnergyPlanResponse;
}
