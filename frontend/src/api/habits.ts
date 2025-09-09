import type { Habit } from '../features/Habits/Habits.types';

const BASE_URL = 'http://localhost:8000';

export async function getHabits(): Promise<Habit[]> {
  const res = await fetch(`${BASE_URL}/habits`);
  if (!res.ok) {
    throw new Error(`Failed to fetch habits: ${res.status}`);
  }
  const data = (await res.json()) as Habit[];
  return data;
}

export async function createHabit(habit: Partial<Habit>): Promise<Habit> {
  const res = await fetch(`${BASE_URL}/habits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(habit),
  });
  if (!res.ok) {
    throw new Error(`Failed to create habit: ${res.status}`);
  }
  return (await res.json()) as Habit;
}

export async function updateHabit(habit: Habit): Promise<Habit> {
  if (!habit.id) {
    throw new Error('Habit id required for update');
  }
  const res = await fetch(`${BASE_URL}/habits/${habit.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(habit),
  });
  if (!res.ok) {
    throw new Error(`Failed to update habit: ${res.status}`);
  }
  return (await res.json()) as Habit;
}

export async function deleteHabit(habitId: number): Promise<void> {
  const res = await fetch(`${BASE_URL}/habits/${habitId}`, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`Failed to delete habit: ${res.status}`);
  }
}
