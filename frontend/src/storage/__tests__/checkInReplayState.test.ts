import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  clearCheckInReplayState,
  loadCheckInReplayState,
  saveCheckInReplayState,
  type ReplayHeadState,
} from '@/storage/checkInReplayState';
import { _resetSerializedWriteForTests } from '@/storage/serializedWrite';
import { scopedKey, setActiveUser } from '@/storage/userScope';

const KEY_BASE = '@adepthood/pending_checkin_replay_state';
const USER = 7;
const OTHER_USER = 8;

const STATE: ReplayHeadState = {
  identity: 'op-1',
  attempts: 3,
  first_rejected_at: '2025-05-20T12:00:00.000Z',
  last_status: 500,
};

let warn: jest.SpiedFunction<typeof console.warn>;

beforeEach(async () => {
  _resetSerializedWriteForTests();
  setActiveUser(USER);
  await AsyncStorage.clear();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  jest.restoreAllMocks();
  setActiveUser(null);
});

describe('checkInReplayState', () => {
  it('round-trips the head record', async () => {
    await saveCheckInReplayState(STATE);
    await expect(loadCheckInReplayState()).resolves.toEqual(STATE);
  });

  it('reads nothing stored as no record', async () => {
    await expect(loadCheckInReplayState()).resolves.toBeNull();
  });

  it('reads malformed JSON as no record, so the count restarts', async () => {
    await AsyncStorage.setItem(scopedKey(KEY_BASE), '{not json');
    await expect(loadCheckInReplayState()).resolves.toBeNull();
  });

  it('reads a record of the wrong shape as no record', async () => {
    await AsyncStorage.setItem(scopedKey(KEY_BASE), JSON.stringify({ ...STATE, attempts: 'many' }));
    await expect(loadCheckInReplayState()).resolves.toBeNull();
  });

  it('reads a failed storage read as no record instead of throwing', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
    await expect(loadCheckInReplayState()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('swallows a failed write, warning without the record', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
    await expect(saveCheckInReplayState(STATE)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(STATE.identity);
  });

  it('swallows a failed clear', async () => {
    jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValueOnce(new Error('disk'));
    await expect(clearCheckInReplayState()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('clear removes the record', async () => {
    await saveCheckInReplayState(STATE);
    await clearCheckInReplayState();
    await expect(AsyncStorage.getItem(scopedKey(KEY_BASE))).resolves.toBeNull();
  });

  it('keeps each account’s record in its own namespace', async () => {
    await saveCheckInReplayState(STATE);
    expect(await AsyncStorage.getItem(`${KEY_BASE}#u${USER}`)).not.toBeNull();

    setActiveUser(OTHER_USER);
    await expect(loadCheckInReplayState()).resolves.toBeNull();
  });
});
