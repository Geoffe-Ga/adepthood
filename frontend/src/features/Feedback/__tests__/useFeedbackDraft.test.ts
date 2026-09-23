/* eslint-env jest */
/* global describe, it, expect, jest, beforeEach, afterEach */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import * as api from '@/api';
import { useFeedbackDraft } from '@/features/Feedback/useFeedbackDraft';
import { FEEDBACK_DRAFT_KEY, loadFeedbackDraft } from '@/storage/feedbackDraftStorage';
import { _resetSerializedWriteForTests } from '@/storage/serializedWrite';
import { scopedKey, setActiveUser } from '@/storage/userScope';

const CONTEXT = {
  screen: 'journal.shelf',
  platform: 'ios',
  app_build: '1.0.0',
  viewport_class: 'compact',
} as const;

let warn: jest.SpyInstance;

beforeEach(async () => {
  _resetSerializedWriteForTests();
  setActiveUser(1);
  await AsyncStorage.clear();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  setActiveUser(null);
});

async function mountHydrated() {
  const hook = renderHook(() => useFeedbackDraft());
  await waitFor(() => expect(hook.result.current.hydrated).toBe(true));
  return hook;
}

describe('useFeedbackDraft', () => {
  it('mints a key and has it on disk before reporting hydrated', async () => {
    const setItem = AsyncStorage.setItem as jest.Mock;
    const { result } = await mountHydrated();

    const stored = await loadFeedbackDraft();
    expect(stored?.idempotencyKey).toBe(result.current.draft.idempotencyKey);
    expect(result.current.draft.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it('does not report hydrated until the new key has actually been written', async () => {
    let finishWrite: () => void = () => undefined;
    (AsyncStorage.setItem as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const { result } = renderHook(() => useFeedbackDraft());
    await act(async () => undefined);

    expect(result.current.hydrated).toBe(false);

    await act(async () => finishWrite());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
  });

  it('reads the SAME key back after an unmount and a remount', async () => {
    const first = await mountHydrated();
    const key = first.result.current.draft.idempotencyKey;
    act(() => first.result.current.setCategory('idea'));
    first.unmount();

    const second = await mountHydrated();

    expect(second.result.current.draft.idempotencyKey).toBe(key);
    expect(second.result.current.draft.category).toBe('idea');
  });

  it('persists every change immediately', async () => {
    const { result } = await mountHydrated();

    act(() => {
      result.current.setCategory('broken');
      result.current.setImpact('cosmetic');
      result.current.setAnswer('summary', 'Typed');
    });

    await waitFor(async () => {
      const stored = await loadFeedbackDraft();
      expect(stored).toMatchObject({
        category: 'broken',
        impact: 'cosmetic',
        answers: { summary: 'Typed' },
      });
    });
  });

  it('never sends anything while hydrating', async () => {
    const submit = jest.spyOn(api.feedback, 'submit');
    await mountHydrated();
    expect(submit).not.toHaveBeenCalled();
    submit.mockRestore();
  });

  it('freezes an attempt under the current key, and reopening mints a new one', async () => {
    const { result } = await mountHydrated();
    const key = result.current.draft.idempotencyKey;
    const payload = {
      category: 'idea',
      impact: 'not_applicable',
      summary: 'x',
      context: CONTEXT,
    } as const;

    await act(async () => result.current.freezeAttempt(payload));
    expect(result.current.draft.attempt).toEqual({ key, payload });
    expect((await loadFeedbackDraft())?.attempt?.key).toBe(key);

    await act(async () => result.current.reopenForEdit());
    expect(result.current.draft.attempt).toBeNull();
    expect(result.current.draft.idempotencyKey).not.toBe(key);
    expect((await loadFeedbackDraft())?.idempotencyKey).toBe(result.current.draft.idempotencyKey);
  });

  it('clear removes the stored draft', async () => {
    const { result } = await mountHydrated();

    await act(async () => result.current.clear());

    expect(await AsyncStorage.getItem(scopedKey(FEEDBACK_DRAFT_KEY))).toBeNull();
  });

  it('keeps working with a fixed warning when the device will not store the draft', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
    const { result } = await mountHydrated();

    expect(result.current.draft.idempotencyKey).toEqual(expect.any(String));
    expect(warn).toHaveBeenCalledWith('[feedback] could not save the draft on this device');
  });

  it('warns without detail when clearing fails', async () => {
    const { result } = await mountHydrated();
    (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('locked'));

    await act(async () => result.current.clear());

    expect(warn).toHaveBeenCalledWith('[feedback] could not clear the sent draft on this device');
  });

  it('ignores a load that lands after unmount', async () => {
    const { unmount } = renderHook(() => useFeedbackDraft());
    unmount();
    await act(async () => undefined);
    expect(warn).not.toHaveBeenCalled();
  });
});
