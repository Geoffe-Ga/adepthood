/* eslint-env jest */
/* global describe, test, expect, afterEach, beforeEach, jest */

const mockPipeline = jest.fn<Promise<VaultPipeline>, []>();

jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/api');
  return { ...actual, vault: { pipeline: () => mockPipeline() } };
});

import { act, renderHook } from '@testing-library/react-native';

import { refreshVaultPipeline, useVaultPipeline } from '../useVaultPipeline';

import type { VaultPipeline } from '@/api';
import { setActiveUser } from '@/storage/userScope';
import { resetAllStores } from '@/store/registry';
import { pipelineAnswer } from '@/testing/vaultPipelineFixtures';

/**
 * The dashboard read the "Your vault" screen and the Seed run's rows share
 * (#3776), held to the account it was read for.
 */

beforeEach(() => {
  jest.clearAllMocks();
  setActiveUser(1);
  resetAllStores();
});

afterEach(() => {
  setActiveUser(null);
});

describe('the shared dashboard read', () => {
  test('publishes an answer, and keeps it when a later read fails', async () => {
    const { result } = renderHook(() => useVaultPipeline());
    expect(result.current).toEqual({ answer: null, failed: false });

    const answer = pipelineAnswer();
    mockPipeline.mockResolvedValueOnce(answer);
    await act(async () => {
      await expect(refreshVaultPipeline()).resolves.toBe(true);
    });
    expect(result.current).toEqual({ answer, failed: false });

    mockPipeline.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      await expect(refreshVaultPipeline()).resolves.toBe(false);
    });
    expect(result.current).toEqual({ answer, failed: true });
  });

  test('an account boundary clears the answer', async () => {
    const { result } = renderHook(() => useVaultPipeline());
    mockPipeline.mockResolvedValueOnce(pipelineAnswer());
    await act(async () => {
      await refreshVaultPipeline();
    });

    act(() => {
      resetAllStores();
    });

    expect(result.current).toEqual({ answer: null, failed: false });
  });

  test('an answer that arrives for an account no longer here is dropped', async () => {
    const { result } = renderHook(() => useVaultPipeline());
    let finish: (value: VaultPipeline) => void = () => undefined;
    mockPipeline.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    let landed: Promise<boolean> = Promise.resolve(true);
    act(() => {
      landed = refreshVaultPipeline();
    });
    act(() => {
      resetAllStores();
    });

    await act(async () => {
      finish(pipelineAnswer());
      await expect(landed).resolves.toBe(false);
    });

    expect(result.current.answer).toBeNull();
  });

  test('a failure for an account no longer here is dropped too', async () => {
    const { result } = renderHook(() => useVaultPipeline());
    let fail: (reason: Error) => void = () => undefined;
    mockPipeline.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    let landed: Promise<boolean> = Promise.resolve(true);
    act(() => {
      landed = refreshVaultPipeline();
    });
    act(() => {
      resetAllStores();
    });

    await act(async () => {
      fail(new Error('gone'));
      await expect(landed).resolves.toBe(false);
    });

    expect(result.current.failed).toBe(false);
  });
});
