import type { EmojiPrefsResponse, EmojiSelectionPayload } from '../types/emoji';

const API_BASE = '/v1';

export async function getEmojiPrefs(): Promise<EmojiPrefsResponse> {
  const res = await fetch(`${API_BASE}/emoji/prefs`);
  if (!res.ok) {
    throw new Error('Failed to fetch emoji prefs');
  }
  return res.json();
}

export async function patchEmojiPrefs(body: {
  preferred_skin_tone?: number | null;
  recents: string[];
}): Promise<EmojiPrefsResponse> {
  const res = await fetch(`${API_BASE}/emoji/prefs`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error('Failed to patch emoji prefs');
  }
  return res.json();
}

export async function patchHabitEmoji(habitId: string | number, selection: EmojiSelectionPayload) {
  const res = await fetch(`${API_BASE}/habits/${habitId}/emoji`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selection }),
  });
  if (!res.ok) {
    throw new Error('Failed to patch habit emoji');
  }
  return res.json();
}

export async function getCustomEmoji() {
  const res = await fetch(`${API_BASE}/emoji/custom`);
  if (!res.ok) {
    throw new Error('Failed to fetch custom emoji');
  }
  return res.json();
}
