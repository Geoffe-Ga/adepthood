/* eslint-env jest */
import { jest, describe, it, expect, afterEach } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook } from '@testing-library/react-native';

/**
 * A dismissal whose disk write fails (quota exceeded, storage blocked) must
 * still hold for this session, say why it did not persist, and never surface
 * as an unhandled promise rejection. Driven through the real storage modules
 * of both first-press explainers, over a rejecting ``setItem``.
 */
import { useStoredDismissal } from '../useStoredDismissal';

import {
  loadPromoteExplainerDismissed,
  savePromoteExplainerDismissed,
} from '@/storage/promoteExplainerStorage';
import {
  loadResonanceExplainerDismissed,
  saveResonanceExplainerDismissed,
} from '@/storage/resonanceExplainerStorage';

type Emitter = {
  on: (_event: 'unhandledRejection', _listener: (_reason: unknown) => void) => void;
  off: (_event: 'unhandledRejection', _listener: (_reason: unknown) => void) => void;
};

type FlagCase = [
  name: string,
  load: () => Promise<boolean>,
  save: (_value: boolean) => Promise<void>,
];

const FLAGS: FlagCase[] = [
  ['promote', loadPromoteExplainerDismissed, savePromoteExplainerDismissed],
  ['resonance', loadResonanceExplainerDismissed, saveResonanceExplainerDismissed],
];

afterEach(() => {
  jest.restoreAllMocks();
});

describe.each(FLAGS)(
  'the %s explainer dismissal, when the disk write fails',
  (_name, load, save) => {
    it('keeps the dismissal in memory, warns, and leaves no unhandled rejection', async () => {
      // Cast through `unknown`: process is a real EventEmitter at runtime, but
      // this project's tsconfig omits ambient Node types.
      const emitter = process as unknown as Emitter;
      const rejections: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        rejections.push(reason);
      };
      emitter.on('unhandledRejection', onUnhandled);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      jest.spyOn(AsyncStorage, 'setItem').mockRejectedValue(new Error('QuotaExceededError'));
      try {
        const { result } = renderHook(() => useStoredDismissal(load, save));
        await act(async () => {
          await result.current.read();
        });

        act(() => result.current.markDismissed());
        // Give the real event loop full turns so a rejection would surface.
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(rejections).toEqual([]);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('failed to save the dismissal flag'),
          expect.any(Error),
        );
        expect(result.current.known()).toBe(true);
      } finally {
        emitter.off('unhandledRejection', onUnhandled);
      }
    });
  },
);
