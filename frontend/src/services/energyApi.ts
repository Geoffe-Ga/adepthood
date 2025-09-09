import { createEnergyPlan, type EnergyPlanRequest, type EnergyPlanResponse } from '../api/client';

import { API_BASE_URL } from '@/config';

export async function fetchEnergyPlan(
  payload: EnergyPlanRequest,
  idempotencyKey?: string,
): Promise<EnergyPlanResponse> {
  return createEnergyPlan(API_BASE_URL, payload, idempotencyKey);
}
