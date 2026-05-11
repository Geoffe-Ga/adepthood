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

  it('disposes by unloading every loaded sound', async () => {
    const adapter = createExpoAudioAdapter();
    await new Promise((resolve) => setImmediate(resolve));

    adapter.dispose?.();
    // Four cues bundle real assets; metronome_tick was never loaded.
    expect(unloadMock).toHaveBeenCalledTimes(4);
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
