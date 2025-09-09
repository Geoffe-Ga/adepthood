import { logCompletion as logCompletionRequest } from '../api/habits';

const BASE_URL = 'http://localhost:8000';

export async function logCompletion(habitId: number, amount: number) {
  return logCompletionRequest(BASE_URL, habitId, amount);
}
