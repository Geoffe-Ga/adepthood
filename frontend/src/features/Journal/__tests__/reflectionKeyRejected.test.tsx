/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { useResonance } from '../useResonance';

import type { CompletionSuggestion, Marginalia, ResonanceResponse } from '@/api';
import { ApiError } from '@/api';
import {
  REFLECTION_KEY_REJECTED_COPY,
  USER_FACING_ERROR_MESSAGES,
  formatApiError,
} from '@/api/errorMessages';

/**
 * A vault-bound pass whose writer key its provider refused (Creek contract
 * 0.28). Waiting never clears it, so the margin names the remedy and never
 * invites another try before the key is replaced.
 */

const mockGenerate = jest.fn() as jest.MockedFunction<(_id: number) => Promise<ResonanceResponse>>;
const mockDetect = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<{ items: CompletionSuggestion[]; checked: boolean }>
>;

jest.mock('@/features/Habits/services/habitManager', () => ({
  habitManager: { loadHabits: () => Promise.resolve() },
}));

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api') as Record<string, unknown>;
  return {
    ...actual,
    resonance: {
      list: (): Promise<{ items: Marginalia[] }> => Promise.resolve({ items: [] }),
      generate: (...a: unknown[]) =>
        (mockGenerate as unknown as (...x: unknown[]) => unknown)(...a),
    },
    completionSuggestions: {
      list: (): Promise<{ items: CompletionSuggestion[] }> => Promise.resolve({ items: [] }),
      detect: (...a: unknown[]) => (mockDetect as unknown as (...x: unknown[]) => unknown)(...a),
    },
  };
});

const REFUSAL = new ApiError(424, 'reflection_key_rejected');
const STORED_KEY = 'sk-ant-lane-rejected-example-key-0000'; // pragma: allowlist secret

async function refusedPass(checked: boolean): Promise<string | null> {
  mockGenerate.mockRejectedValue(REFUSAL);
  mockDetect.mockResolvedValue({ checked, items: [] });
  const flush = jest.fn(async () => 42);
  const { result } = renderHook(() =>
    useResonance({ routeEntryId: null, flush, userTimezone: 'UTC' }),
  );
  await act(async () => {
    await result.current.requestResonance();
  });
  return result.current.error;
}

beforeEach(() => {
  mockGenerate.mockReset();
  mockDetect.mockReset();
});

describe('a refused writer key on a vault-bound pass', () => {
  it('has its own copy, distinct from the retryable outage', () => {
    expect(formatApiError(REFUSAL)).toBe(REFLECTION_KEY_REJECTED_COPY);
    expect(REFLECTION_KEY_REJECTED_COPY).not.toBe(
      USER_FACING_ERROR_MESSAGES.reflection_source_unavailable,
    );
  });

  it('names who refused, what was spared, and the one remedy', () => {
    expect(REFLECTION_KEY_REJECTED_COPY).toMatch(/turned down your own API key/);
    expect(REFLECTION_KEY_REJECTED_COPY).toMatch(/nothing was charged/);
    expect(REFLECTION_KEY_REJECTED_COPY).toMatch(/entry is saved/);
    expect(REFLECTION_KEY_REJECTED_COPY).toMatch(/Settings → API key/);
  });

  it('is calm, never echoes a key, and never says to wait', () => {
    expect(REFLECTION_KEY_REJECTED_COPY).not.toContain(STORED_KEY);
    expect(REFLECTION_KEY_REJECTED_COPY).not.toMatch(
      /\b(401|403|unauthori[sz]ed|forbidden|error)\b/i,
    );
    expect(REFLECTION_KEY_REJECTED_COPY).not.toMatch(/!|urgent|immediately|warning/i);
    expect(REFLECTION_KEY_REJECTED_COPY).not.toMatch(/give it a moment|just now/i);
  });

  it('reads whole inside the margin when detection could not run', async () => {
    const error = await refusedPass(false);

    expect(error).toBe(
      `We couldn't create a reflection or check this entry for completed habits. ${REFLECTION_KEY_REJECTED_COPY}`,
    );
  });

  it('does not invite another pass before the key is replaced', async () => {
    const error = await refusedPass(true);

    expect(error).toBe(
      `We couldn't create a reflection for this entry. ${REFLECTION_KEY_REJECTED_COPY} We still checked it for completed habits.`,
    );
  });
});
