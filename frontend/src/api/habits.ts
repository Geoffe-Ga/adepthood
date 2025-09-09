import type { Habit } from '../features/Habits/Habits.types';

export async function logCompletion(
  baseUrl: string,
  habitId: number,
  amount: number,
): Promise<Habit> {
  const res = await fetch(`${baseUrl}/v1/habits/${habitId}/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ completed_units: amount }),
  });
  if (!res.ok) {
    throw new Error(`Request failed with status ${res.status}`);
  }
  return (await res.json()) as Habit;
}
