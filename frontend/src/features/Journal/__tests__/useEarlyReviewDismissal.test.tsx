import { beforeEach, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import { useEarlyReviewDismissal } from '../useEarlyReviewDismissal';

import * as dismissalStorage from '@/storage/reflectionDismissalStorage';
import { setActiveUser } from '@/storage/userScope';

beforeEach(async () => {
  jest.restoreAllMocks();
  await AsyncStorage.clear();
  setActiveUser(1);
});

it('does not let an older focus read undo a confirmed decline', async () => {
  const { result, rerender } = renderHook(
    ({ focus }: { focus: number }) => useEarlyReviewDismissal(focus),
    {
      initialProps: { focus: 0 },
    },
  );
  await waitFor(() => expect(result.current.dismissed).toBe(false));
  let resolveRead: (_value: boolean) => void = () => undefined;
  jest.spyOn(dismissalStorage, 'loadReflectionDismissed').mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        resolveRead = resolve;
      }),
  );
  rerender({ focus: 1 });
  await act(async () => {
    await result.current.change(true);
  });
  expect(result.current.dismissed).toBe(true);
  await act(async () => {
    resolveRead(false);
  });
  expect(result.current.dismissed).toBe(true);
});

it('ignores a departing account’s delayed decline on a still-mounted screen', async () => {
  const { result } = renderHook(() => useEarlyReviewDismissal());
  await waitFor(() => expect(result.current.dismissed).toBe(false));
  let resolveWrite: () => void = () => undefined;
  jest.spyOn(dismissalStorage, 'saveReflectionDismissed').mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        resolveWrite = resolve;
      }),
  );
  let pending: Promise<boolean> | null = null;
  act(() => {
    pending = result.current.change(true);
  });
  act(() => setActiveUser(2));
  expect(result.current.dismissed).toBeNull();
  await waitFor(() => expect(result.current.dismissed).toBe(false));
  await act(async () => {
    resolveWrite();
    expect(await pending).toBe(false);
  });
  expect(result.current.dismissed).toBe(false);
});
