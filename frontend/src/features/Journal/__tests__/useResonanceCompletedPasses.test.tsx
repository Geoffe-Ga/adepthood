/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { TEST_TIMEZONE, note, resonancePayload } from './resonanceTestKit';

import type { Marginalia, ResonanceResponse } from '@/api';
import { ApiError } from '@/api';

/**
 * ``completedPasses`` — the hook's count of resolved, non-intimate generate
 * passes, which is what tells ``CorpusInvitationNote`` a moment has arrived
 * (#2407). It is a signal to ask the server, never a thing to render.
 *
 * It must not move on a rejected pass (nothing was received) and must not move
 * on an intimate pass: the server never counts those, and a client that did
 * would fetch an offer and render "sent once to the language-model provider"
 * beneath the message that this entry never leaves the device.
 */

const mockList = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<{ items: Marginalia[] }>
>;
const mockGenerate = jest.fn() as jest.MockedFunction<(_id: number) => Promise<ResonanceResponse>>;

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api') as Record<string, unknown>;
  return {
    ...actual,
    resonance: {
      list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
      generate: (...a: unknown[]) =>
        (mockGenerate as unknown as (...x: unknown[]) => unknown)(...a),
    },
    completionSuggestions: {
      list: jest.fn(() => Promise.resolve({ items: [] })),
      accept: jest.fn(),
      dismiss: jest.fn(),
    },
  };
});

const { useResonance } = require('../useResonance');

const flush = jest.fn(async () => 7);

async function pass(result: ReturnType<typeof renderHook>['result']) {
  await act(async () => {
    await (result.current as { requestResonance: () => Promise<void> }).requestResonance();
  });
}

function passes(result: ReturnType<typeof renderHook>['result']): number {
  return (result.current as { completedPasses: number }).completedPasses;
}

beforeEach(() => {
  mockList.mockReset();
  mockGenerate.mockReset();
  mockList.mockResolvedValue({ items: [] });
});

describe('useResonance.completedPasses', () => {
  it('starts at zero and does not move on the load-on-open read', async () => {
    mockList.mockResolvedValue({ items: [note()] });
    const { result } = renderHook(() =>
      useResonance({ routeEntryId: 7, flush, userTimezone: TEST_TIMEZONE }),
    );

    await act(async () => {});

    expect(passes(result)).toBe(0);
  });

  it('counts a resolved pass, notes or not', async () => {
    mockGenerate
      .mockResolvedValueOnce(resonancePayload({ marginalia: [note()] }))
      .mockResolvedValueOnce(resonancePayload({ no_notes_message: 'Nothing this time.' }));
    const { result } = renderHook(() =>
      useResonance({ routeEntryId: 7, flush, userTimezone: TEST_TIMEZONE }),
    );

    await pass(result);
    expect(passes(result)).toBe(1);
    await pass(result);
    expect(passes(result)).toBe(2);
  });

  it('does not count a pass that rejected', async () => {
    mockGenerate.mockRejectedValue(new ApiError(502, 'llm_provider_error'));
    const { result } = renderHook(() =>
      useResonance({ routeEntryId: 7, flush, userTimezone: TEST_TIMEZONE }),
    );

    await pass(result);

    expect(passes(result)).toBe(0);
  });

  it('does not count a pass the privacy floor withheld', async () => {
    mockGenerate.mockResolvedValue(
      resonancePayload({ private: true, private_message: 'This entry stays on the device.' }),
    );
    const { result } = renderHook(() =>
      useResonance({ routeEntryId: 7, flush, userTimezone: TEST_TIMEZONE }),
    );

    await pass(result);

    expect(passes(result)).toBe(0);
  });
});
