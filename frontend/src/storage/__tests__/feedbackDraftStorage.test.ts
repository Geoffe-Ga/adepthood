/* eslint-env jest */
/* global describe, it, expect, jest, beforeEach, afterEach */
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  clearFeedbackDraft,
  FEEDBACK_DRAFT_KEY,
  feedbackDraftKey,
  loadFeedbackDraft,
  readFeedbackDraft,
  saveFeedbackDraft,
  settleFeedbackAttempt,
  type StoredFeedbackDraft,
} from '@/storage/feedbackDraftStorage';
import { _resetSerializedWriteForTests } from '@/storage/serializedWrite';
import { scopedKey, setActiveUser } from '@/storage/userScope';

const SENTINEL = 'SENTINEL prose that must never reach a log';

const DRAFT: StoredFeedbackDraft = {
  category: 'broken',
  impact: 'blocked',
  answers: { summary: 'It broke', intent: 'Save', expected: 'Saved', actual: 'Nothing' },
  idempotencyKey: '8b0a3c52-2c1f-4c0e-9d1f-7a3c2b1e0f9d',
  attempt: null,
};

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

function warnedWith(text: string): boolean {
  return warn.mock.calls.some((args: unknown[]) =>
    args.some((arg) => {
      if (arg instanceof Error)
        return arg.message.includes(text) || String(arg.stack).includes(text);
      return JSON.stringify(arg)?.includes(text) ?? false;
    }),
  );
}

describe('feedbackDraftStorage', () => {
  it('round-trips a draft', async () => {
    await saveFeedbackDraft(DRAFT);
    await expect(loadFeedbackDraft()).resolves.toEqual(DRAFT);
  });

  it('round-trips a frozen attempt', async () => {
    const frozen: StoredFeedbackDraft = {
      ...DRAFT,
      attempt: {
        key: DRAFT.idempotencyKey,
        payload: {
          category: 'broken',
          impact: 'blocked',
          summary: 'It broke',
          context: {
            screen: 'journal.shelf',
            platform: 'web',
            app_build: '1.0.0',
            viewport_class: 'compact',
          },
        },
      },
    };
    await saveFeedbackDraft(frozen);
    await expect(loadFeedbackDraft()).resolves.toEqual(frozen);
  });

  it('resolves null when nothing is stored', async () => {
    await expect(loadFeedbackDraft()).resolves.toBeNull();
  });

  it('writes under the active user’s scoped key', async () => {
    await saveFeedbackDraft(DRAFT);
    expect(await AsyncStorage.getItem(scopedKey(FEEDBACK_DRAFT_KEY))).not.toBeNull();
    expect(scopedKey(FEEDBACK_DRAFT_KEY)).not.toBe(FEEDBACK_DRAFT_KEY);
    expect(await AsyncStorage.getItem(FEEDBACK_DRAFT_KEY)).toBeNull();

    setActiveUser(2);
    await expect(loadFeedbackDraft()).resolves.toBeNull();
    setActiveUser(1);
    await expect(loadFeedbackDraft()).resolves.toEqual(DRAFT);
  });

  it('clears the draft', async () => {
    await saveFeedbackDraft(DRAFT);
    await clearFeedbackDraft();
    await expect(loadFeedbackDraft()).resolves.toBeNull();
  });

  it('heals corrupt JSON without putting any of it in a log', async () => {
    await AsyncStorage.setItem(scopedKey(FEEDBACK_DRAFT_KEY), `{"summary": "${SENTINEL}`);

    await expect(loadFeedbackDraft()).resolves.toBeNull();

    expect(await AsyncStorage.getItem(scopedKey(FEEDBACK_DRAFT_KEY))).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(warnedWith('SENTINEL')).toBe(false);
  });

  it('heals a row of the wrong shape without logging its contents', async () => {
    await AsyncStorage.setItem(
      scopedKey(FEEDBACK_DRAFT_KEY),
      JSON.stringify({ ...DRAFT, category: SENTINEL }),
    );

    await expect(loadFeedbackDraft()).resolves.toBeNull();

    expect(await AsyncStorage.getItem(scopedKey(FEEDBACK_DRAFT_KEY))).toBeNull();
    expect(warnedWith('SENTINEL')).toBe(false);
  });

  it('keeps the stored row on a transient read failure', async () => {
    await saveFeedbackDraft(DRAFT);
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error(SENTINEL));

    await expect(loadFeedbackDraft()).resolves.toBeNull();

    await expect(loadFeedbackDraft()).resolves.toEqual(DRAFT);
    expect(warnedWith('SENTINEL')).toBe(false);
  });

  it('survives a failed self-heal without logging the row', async () => {
    await AsyncStorage.setItem(scopedKey(FEEDBACK_DRAFT_KEY), `not json ${SENTINEL}`);
    (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error(SENTINEL));

    await expect(loadFeedbackDraft()).resolves.toBeNull();

    expect(warnedWith('SENTINEL')).toBe(false);
  });
});

describe('feedbackDraftStorage — reads that fail are not "no draft" (review [2])', () => {
  it('reports a transient read failure as unreadable, distinct from empty', async () => {
    await saveFeedbackDraft(DRAFT);
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('locked'));

    await expect(readFeedbackDraft()).resolves.toEqual({ kind: 'unreadable' });
    await expect(readFeedbackDraft()).resolves.toEqual({ kind: 'draft', draft: DRAFT });
  });

  it('reports a missing row as empty', async () => {
    await expect(readFeedbackDraft()).resolves.toEqual({ kind: 'empty' });
  });
});

describe('feedbackDraftStorage — settling a sent attempt (review [0], [3], [4])', () => {
  const FROZEN: StoredFeedbackDraft = {
    ...DRAFT,
    attempt: {
      key: DRAFT.idempotencyKey,
      payload: {
        category: 'broken',
        impact: 'blocked',
        summary: 'It broke',
        context: {
          screen: 'journal.shelf',
          platform: 'web',
          app_build: '1.0.0',
          viewport_class: 'compact',
        },
      },
    },
  };

  it('writes and clears under an explicitly captured key, whatever the active scope now is', async () => {
    const key = feedbackDraftKey();
    setActiveUser(2);
    await saveFeedbackDraft(FROZEN, key);
    expect(await AsyncStorage.getItem(scopedKey(FEEDBACK_DRAFT_KEY))).toBeNull();
    await clearFeedbackDraft(key);
    expect(await AsyncStorage.getItem(key)).toBeNull();
  });

  it('a sent attempt removes the row only while that attempt is still the stored one', async () => {
    await saveFeedbackDraft(FROZEN);
    await settleFeedbackAttempt(feedbackDraftKey(), 'some-other-key', 'sent');
    await expect(loadFeedbackDraft()).resolves.toEqual(FROZEN);

    await settleFeedbackAttempt(feedbackDraftKey(), DRAFT.idempotencyKey, 'sent');
    await expect(loadFeedbackDraft()).resolves.toBeNull();
  });

  it('an unfrozen attempt keeps the stored answers and key, and drops only the attempt', async () => {
    await saveFeedbackDraft(FROZEN);
    await settleFeedbackAttempt(feedbackDraftKey(), DRAFT.idempotencyKey, 'unfreeze');
    await expect(loadFeedbackDraft()).resolves.toEqual({ ...FROZEN, attempt: null });
  });

  it('settling against an empty scope writes nothing', async () => {
    await settleFeedbackAttempt(feedbackDraftKey(), DRAFT.idempotencyKey, 'unfreeze');
    expect(await AsyncStorage.getAllKeys()).toEqual([]);
  });
});
