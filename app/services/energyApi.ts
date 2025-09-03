import {
  createEnergyPlan,
  type EnergyPlanRequest,
  type EnergyPlanResponse,
} from '../src/api/client';

const BASE_URL = 'http://localhost:8000';

export async function fetchEnergyPlan(
  payload: EnergyPlanRequest,
  idempotencyKey?: string,
): Promise<EnergyPlanResponse> {
  return createEnergyPlan(BASE_URL, payload, idempotencyKey);
}
