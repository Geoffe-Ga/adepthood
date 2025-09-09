import type { Goal } from '../features/Habits/Habits.types';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

export async function updateGoal(habitId: number, goal: Goal): Promise<Goal> {
  const res = await fetch(`${API_URL}/habits/${habitId}/goals/${goal.id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(goal),
  });

  if (!res.ok) {
    throw new Error(`Failed to update goal: ${res.status}`);
  }

  return (await res.json()) as Goal;
}

export async function createGoal(habitId: number, goal: Goal): Promise<Goal> {
  const res = await fetch(`${API_URL}/habits/${habitId}/goals`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(goal),
  });

  if (!res.ok) {
    throw new Error(`Failed to create goal: ${res.status}`);
  }

  return (await res.json()) as Goal;
}
