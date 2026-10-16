import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { LEGACY_DECLINE_OWNER_KEY } from '../declineOwnership';
import {
  _resetDeviceOwnerStampForTests,
  readDeviceOwner,
  stampDeviceOwner,
} from '../deviceOwnerStamp';
import { DEVICE_OWNER_KEY } from '../userScope';

const mockRows = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockRows.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockRows.set(key, value);
  }),
}));

const USER_A = 1;
const USER_B = 2;
const USER_C = 3;

beforeEach(() => {
  mockRows.clear();
  jest.clearAllMocks();
  _resetDeviceOwnerStampForTests();
});
afterEach(() => {
  _resetDeviceOwnerStampForTests();
});

describe('readDeviceOwner', () => {
  it('reports the stamp as the live owner when nothing is pending', async () => {
    mockRows.set(DEVICE_OWNER_KEY, String(USER_A));
    expect(await readDeviceOwner()).toEqual({
      stamp: USER_A,
      liveOwner: USER_A,
      provenanceSaved: true,
    });
    expect(JSON.parse(mockRows.get(LEGACY_DECLINE_OWNER_KEY)!)).toEqual({
      version: 1,
      owner: USER_A,
    });
  });

  it('reports a failed provenance write without touching the stamp', async () => {
    mockRows.set(DEVICE_OWNER_KEY, String(USER_A));
    jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
    expect(await readDeviceOwner()).toEqual({
      stamp: USER_A,
      liveOwner: USER_A,
      provenanceSaved: false,
    });
    expect(mockRows.get(DEVICE_OWNER_KEY)).toBe(String(USER_A));
  });
});

describe('stampDeviceOwner', () => {
  it('keeps the stamp and remembers the live owner while provenance is missing', async () => {
    mockRows.set(DEVICE_OWNER_KEY, String(USER_A));
    await stampDeviceOwner(USER_B, false);
    expect(mockRows.get(DEVICE_OWNER_KEY)).toBe(String(USER_A));
    expect((await readDeviceOwner()).liveOwner).toBe(USER_B);
  });

  it('forgets the live owner once the stamp lands', async () => {
    await stampDeviceOwner(USER_B, false);
    await stampDeviceOwner(USER_B, true);
    mockRows.set(DEVICE_OWNER_KEY, String(USER_C));
    expect((await readDeviceOwner()).liveOwner).toBe(USER_C);
  });

  it('remembers the live owner when the stamp write itself rejects', async () => {
    mockRows.set(DEVICE_OWNER_KEY, String(USER_A));
    jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('quota'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await stampDeviceOwner(USER_B, true);
    warn.mockRestore();
    expect(mockRows.get(DEVICE_OWNER_KEY)).toBe(String(USER_A));
    expect((await readDeviceOwner()).liveOwner).toBe(USER_B);
  });

  it('does not let a held stamp write erase a newer live owner', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.mocked(AsyncStorage.setItem).mockImplementationOnce(async (key, value) => {
      await held;
      mockRows.set(key, value);
    });
    const slow = stampDeviceOwner(USER_B, true);
    await stampDeviceOwner(USER_C, false);
    release();
    await slow;
    expect((await readDeviceOwner()).liveOwner).toBe(USER_C);
  });
});
