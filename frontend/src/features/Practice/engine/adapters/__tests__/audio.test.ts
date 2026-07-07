import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Audio } from 'expo-av';

import { createExpoAudioAdapter, createNoopAudioAdapter } from '../audio';

const mockedCreateAsync = Audio.Sound.createAsync as jest.MockedFunction<
  typeof Audio.Sound.createAsync
>;

describe('createNoopAudioAdapter', () => {
  it('returns an adapter that resolves play without throwing and supports dispose', () => {
    const adapter = createNoopAudioAdapter();
    expect(() => adapter.play('start_bell')).not.toThrow();
    expect(() => adapter.dispose?.()).not.toThrow();
  });
});

describe('createExpoAudioAdapter', () => {
  let warnSpy: jest.SpiedFunction<typeof console.warn>;
  let replayMock: jest.Mock<() => Promise<void>>;
  let unloadMock: jest.Mock<() => Promise<void>>;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    replayMock = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    unloadMock = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    mockedCreateAsync.mockReset();
    mockedCreateAsync.mockResolvedValue({
      sound: { replayAsync: replayMock, unloadAsync: unloadMock },
    } as unknown as Awaited<ReturnType<typeof Audio.Sound.createAsync>>);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('warns once for the missing metronome_tick asset and degrades to no-op', async () => {
    const adapter = createExpoAudioAdapter();
    // Flush microtasks so the eager loaders settle.
    await new Promise((resolve) => setImmediate(resolve));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('metronome_tick');

    await adapter.play('metronome_tick');
    await adapter.play('metronome_tick');
    // Second play does not produce a second warning.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // No replay attempted for the failed cue.
    expect(replayMock).not.toHaveBeenCalled();
  });

  it('plays loaded cues via replayAsync', async () => {
    const adapter = createExpoAudioAdapter();
    await new Promise((resolve) => setImmediate(resolve));

    await adapter.play('start_bell');
    await adapter.play('halfway_bell');
    await adapter.play('end_bell');
    expect(replayMock).toHaveBeenCalledTimes(3);
  });

  it('marks a cue as failed and warns once when load rejects', async () => {
    mockedCreateAsync.mockRejectedValueOnce(new Error('decode error'));
    const adapter = createExpoAudioAdapter();
    await new Promise((resolve) => setImmediate(resolve));

    // 1 warn from the decode failure + 1 from the missing metronome_tick asset.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    await adapter.play('start_bell');
    // First cue had its load fail → no replay.
    expect(replayMock).not.toHaveBeenCalled();
  });

  describe('interval bell tone selection', () => {
    interface LoadedEntry {
      asset: unknown;
      replayAsync: jest.Mock<() => Promise<void>>;
    }

    function mockDistinctSoundsPerLoad(): LoadedEntry[] {
      const created: LoadedEntry[] = [];
      mockedCreateAsync.mockImplementation((asset) => {
        const entry: LoadedEntry = {
          asset: asset as unknown,
          replayAsync: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        };
        created.push(entry);
        return Promise.resolve({
          sound: {
            replayAsync: entry.replayAsync,
            unloadAsync: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
          },
        } as unknown as Awaited<ReturnType<typeof Audio.Sound.createAsync>>);
      });
      return created;
    }

    it('replays a distinct sound instance per interval_bell tone, loaded from distinct assets', async () => {
      const created = mockDistinctSoundsPerLoad();
      const adapter = createExpoAudioAdapter();
      await new Promise((resolve) => setImmediate(resolve));

      await adapter.play('interval_bell', 'chime');
      const chimeEntry = created.find((entry) => entry.replayAsync.mock.calls.length > 0);
      expect(chimeEntry).toBeDefined();

      await adapter.play('interval_bell', 'gong');
      const gongEntry = created.find(
        (entry) => entry !== chimeEntry && entry.replayAsync.mock.calls.length > 0,
      );
      expect(gongEntry).toBeDefined();
      expect(gongEntry?.asset).not.toBe(chimeEntry?.asset);
    });

    it('defaults a toneless interval_bell play to the bowl asset, distinct from other tones', async () => {
      const created = mockDistinctSoundsPerLoad();
      const adapter = createExpoAudioAdapter();
      await new Promise((resolve) => setImmediate(resolve));

      await adapter.play('interval_bell');
      const bowlEntry = created.find((entry) => entry.replayAsync.mock.calls.length > 0);
      expect(bowlEntry).toBeDefined();

      await adapter.play('interval_bell', 'chime');
      const chimeEntry = created.find(
        (entry) => entry !== bowlEntry && entry.replayAsync.mock.calls.length > 0,
      );
      expect(chimeEntry).toBeDefined();
      expect(chimeEntry).not.toBe(bowlEntry);
    });
  });

  it('disposes by unloading every loaded sound', async () => {
    const adapter = createExpoAudioAdapter();
    await new Promise((resolve) => setImmediate(resolve));

    adapter.dispose?.();
    // Six cues bundle real assets (start, halfway, bowl, chime, gong, end); metronome_tick was never loaded.
    expect(unloadMock).toHaveBeenCalledTimes(6);
  });

  it('marks a cue as failed if replayAsync rejects, suppressing further warns', async () => {
    replayMock.mockRejectedValueOnce(new Error('decoder gone'));
    const adapter = createExpoAudioAdapter();
    await new Promise((resolve) => setImmediate(resolve));

    // 1 startup warn (metronome_tick).
    expect(warnSpy).toHaveBeenCalledTimes(1);
    await adapter.play('start_bell');
    // +1 warn for the replay failure on start_bell.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    await adapter.play('start_bell');
    // Subsequent plays are silenced — total warn count unchanged.
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
