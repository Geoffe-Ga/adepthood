/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getJsonArray, getJsonArrayForUpdate } from '../jsonStore';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
  removeItem: jest.fn(() => Promise.resolve()),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

const KEY = 'some-key';

interface Sample {
  id: number;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getJsonArrayForUpdate', () => {
  test('propagates a transient getItem rejection instead of swallowing it', async () => {
    mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('transient read'));

    await expect(getJsonArrayForUpdate<Sample>(KEY)).rejects.toThrow('transient read');
    expect(mockAsyncStorage.removeItem).not.toHaveBeenCalled();
  });

  test('self-heals corrupt JSON by clearing the key and resolving null', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce('not valid json{{{');

    const result = await getJsonArrayForUpdate<Sample>(KEY);
    expect(result).toBeNull();
    expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith(KEY);
  });

  test('self-heals a valid non-array payload by clearing the key and resolving null', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce(JSON.stringify({}));

    const result = await getJsonArrayForUpdate<Sample>(KEY);
    expect(result).toBeNull();
    expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith(KEY);
  });

  test('resolves null on a missing key without clearing anything', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce(null);

    const result = await getJsonArrayForUpdate<Sample>(KEY);
    expect(result).toBeNull();
    expect(mockAsyncStorage.removeItem).not.toHaveBeenCalled();
  });

  test('resolves the parsed array on a valid payload', async () => {
    const stored: Sample[] = [{ id: 1 }, { id: 2 }];
    mockAsyncStorage.getItem.mockResolvedValueOnce(JSON.stringify(stored));

    const result = await getJsonArrayForUpdate<Sample>(KEY);
    expect(result).toEqual(stored);
  });
});

describe('getJsonArray (shared parse-heal guard)', () => {
  test('a transient getItem rejection resolves null without clearing the key', async () => {
    mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('transient read'));

    const result = await getJsonArray<Sample>(KEY);
    expect(result).toBeNull();
    expect(mockAsyncStorage.removeItem).not.toHaveBeenCalled();
  });

  test('corrupt JSON resolves null and clears the key', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce('not valid json{{{');

    const result = await getJsonArray<Sample>(KEY);
    expect(result).toBeNull();
    expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith(KEY);
  });
});
