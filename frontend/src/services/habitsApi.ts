import { habits, type Habit } from '../api/index';

export async function listHabits(token?: string): Promise<Habit[]> {
  return habits.list(token);
}
