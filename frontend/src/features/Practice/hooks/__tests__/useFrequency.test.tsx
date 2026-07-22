/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { FrequencyResponse } from '@/api';

const sampleFrequency: FrequencyResponse = {
  stage_number: 5,
  color: 'Orange',
  aspect: 'Mind',
  practice_name: 'Concentration on the breath',
  practice_id: 17,
  user_practice_id: 42,
  banner_text:
    'You are in the Orange frequency of APTITUDE. That means you are working on Mind. ' +
    'Your practice is Concentration on the breath but you are encouraged to replace it ' +
    'if another tradition has a practice that deals with Mind that calls to you more.',
};

const mockFrequencyCurrent = jest.fn() as jest.MockedFunction<() => Promise<FrequencyResponse>>;

jest.mock('@/api', () => ({
  frequency: {
    current: (...args: unknown[]) =>
      (mockFrequencyCurrent as unknown as (...a: unknown[]) => Promise<FrequencyResponse>)(...args),
  },
}));

const { useFrequency } = require('../useFrequency');

describe('useFrequency', () => {
  beforeEach(() => {
    mockFrequencyCurrent.mockReset();
  });

  it('starts loading and resolves with the server payload', async () => {
    mockFrequencyCurrent.mockResolvedValue(sampleFrequency);

    const { result } = renderHook(() => useFrequency());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data).toEqual(sampleFrequency);
    expect(result.current.error).toBeNull();
    expect(mockFrequencyCurrent).toHaveBeenCalledTimes(1);
  });

  it('surfaces a fetch failure as an Error and clears data', async () => {
    mockFrequencyCurrent.mockRejectedValueOnce(new Error('boom'));

    const { result } = renderHook(() => useFrequency());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('boom');
  });

  it('wraps non-Error rejections into a real Error so call sites can read .message', async () => {
    mockFrequencyCurrent.mockRejectedValueOnce('network down');

    const { result } = renderHook(() => useFrequency());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('network down');
  });

  it('refetch() re-runs the request and clears any prior error', async () => {
    mockFrequencyCurrent
      .mockRejectedValueOnce(new Error('first try'))
      .mockResolvedValueOnce(sampleFrequency);

    const { result } = renderHook(() => useFrequency());

    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
    });

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.data).toEqual(sampleFrequency);
    expect(result.current.error).toBeNull();
    expect(mockFrequencyCurrent).toHaveBeenCalledTimes(2);
  });

  it('passes a stage_number override into the API client', async () => {
    // Master-date wiring: the Practice screen passes its
    // date-derived stage to the hook so the banner pins to the same
    // stage as the practice card, not whatever the server-stored
    // current_stage happens to be.
    mockFrequencyCurrent.mockResolvedValue(sampleFrequency);

    const { result } = renderHook(() => useFrequency(7));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockFrequencyCurrent).toHaveBeenCalledWith(7);
  });

  it('refetches when the stage_number changes', async () => {
    // Date moves → derived stage changes → banner should re-pin.
    mockFrequencyCurrent.mockResolvedValue(sampleFrequency);

    const { result, rerender } = renderHook(({ stage }: { stage: number }) => useFrequency(stage), {
      initialProps: { stage: 1 },
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(mockFrequencyCurrent).toHaveBeenLastCalledWith(1);

    rerender({ stage: 3 });

    await waitFor(() => {
      expect(mockFrequencyCurrent).toHaveBeenLastCalledWith(3);
    });
    expect(mockFrequencyCurrent).toHaveBeenCalledTimes(2);
  });

  it('ignores a stale response if the component unmounted before it resolved', async () => {
    let resolveFn: ((value: FrequencyResponse) => void) | undefined;
    mockFrequencyCurrent.mockReturnValueOnce(
      new Promise<FrequencyResponse>((resolve) => {
        resolveFn = resolve;
      }),
    );

    const { result, unmount } = renderHook(() => useFrequency());
    unmount();
    // Resolve after unmount — `useFrequency` must not call setState.
    await act(async () => {
      resolveFn?.(sampleFrequency);
    });
    // Final state is whatever was captured pre-unmount — initial loading.
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeNull();
  });
});
