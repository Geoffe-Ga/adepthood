import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  saveVoiceReadinessDismissed,
  loadVoiceReadinessDismissed,
} from '../voiceReadinessDismissalStorage';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('voiceReadinessDismissalStorage', () => {
  describe('saveVoiceReadinessDismissed', () => {
    test('stores true when the note is set aside', async () => {
      await saveVoiceReadinessDismissed(true);

      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
        '@adepthood/voice_readiness_dismissed',
        'true',
      );
    });

    test('stores false when the note is restored', async () => {
      await saveVoiceReadinessDismissed(false);

      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
        '@adepthood/voice_readiness_dismissed',
        'false',
      );
    });
  });

  describe('loadVoiceReadinessDismissed', () => {
    test('returns false when nothing is stored', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce(null);
      expect(await loadVoiceReadinessDismissed()).toBe(false);
    });

    test('returns true when the stored flag is true', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce('true');
      expect(await loadVoiceReadinessDismissed()).toBe(true);
    });

    test('returns false for a value that is not the stored flag', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce('false');
      expect(await loadVoiceReadinessDismissed()).toBe(false);
    });

    test('returns false on a storage error', async () => {
      // Unreadable storage means the note has not been declined, so the person
      // still gets the invitation. Failing towards silence would hide it for
      // good on the strength of one bad read.
      mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('storage error'));
      expect(await loadVoiceReadinessDismissed()).toBe(false);
    });

    test('propagates a write failure rather than swallowing it', async () => {
      mockAsyncStorage.setItem.mockRejectedValueOnce(new Error('disk full'));
      await expect(saveVoiceReadinessDismissed(true)).rejects.toThrow('disk full');
    });
  });
});
