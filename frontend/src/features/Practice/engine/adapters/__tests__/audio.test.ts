import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createAudioPlayer } from 'expo-audio';

import { createExpoAudioAdapter, createNoopAudioAdapter } from '../audio';

// The exact bundled assets each interval_bell tone must resolve to. Requiring
// the same module paths the adapter uses yields the identical cached asset
// reference, so a swapped tone-to-asset mapping fails the identity checks below.
const bowlAsset = require('../../../../../../assets/sounds/bell-bowl.mp3');
const chimeAsset = require('../../../../../../assets/sounds/bell-chime.mp3');
const gongAsset = require('../../../../../../assets/sounds/bell-gong.mp3');

const mockedCreatePlayer = createAudioPlayer as jest.MockedFunction<typeof createAudioPlayer>;

describe('createNoopAudioAdapter', () => {
  it('returns an adapter that resolves play without throwing and supports dispose', () => {
    const adapter = createNoopAudioAdapter();
    expect(() => adapter.play('start_bell')).not.toThrow();
    expect(() => adapter.dispose?.()).not.toThrow();
  });
});

describe('createExpoAudioAdapter', () => {
  let warnSpy: jest.SpiedFunction<typeof console.warn>;
  // expo-audio splits expo-av's replayAsync into a seek and a play, so a cue
  // restart is asserted as both: seekTo(0) proves it starts from the top rather
  // than resuming, which is what a ritual bell means.
  let seekMock: jest.Mock<(seconds: number) => Promise<void>>;
  let playMock: jest.Mock<() => void>;
  let removeMock: jest.Mock<() => void>;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    seekMock = jest.fn<(seconds: number) => Promise<void>>().mockResolvedValue(undefined);
    playMock = jest.fn<() => void>();
    removeMock = jest.fn<() => void>();
    mockedCreatePlayer.mockReset();
    // Synchronous by design: createAudioPlayer returns a player immediately and
    // loads in the background. Returning a promise here would let a broken
    // adapter pass.
    mockedCreatePlayer.mockReturnValue({
      seekTo: seekMock,
      play: playMock,
      remove: removeMock,
    } as unknown as ReturnType<typeof createAudioPlayer>);
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
    expect(playMock).not.toHaveBeenCalled();
  });

  it('plays loaded cues by seeking to zero then playing', async () => {
    const adapter = createExpoAudioAdapter();
    await new Promise((resolve) => setImmediate(resolve));

    await adapter.play('start_bell');
    await adapter.play('halfway_bell');
    await adapter.play('end_bell');
    expect(seekMock).toHaveBeenCalledTimes(3);
    expect(seekMock).toHaveBeenCalledWith(0);
    expect(playMock).toHaveBeenCalledTimes(3);
  });

  it('marks a cue as failed and warns once when load rejects', async () => {
    // createAudioPlayer is synchronous, so a load failure THROWS rather than
    // rejecting. A mockRejectedValueOnce here would return a rejected promise
    // the adapter never awaits, and the failure would go unnoticed.
    mockedCreatePlayer.mockImplementationOnce(() => {
      throw new Error('decode error');
    });
    const adapter = createExpoAudioAdapter();
    await new Promise((resolve) => setImmediate(resolve));

    // 1 warn from the decode failure + 1 from the missing metronome_tick asset.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    await adapter.play('start_bell');
    // First cue had its load fail → no replay.
    expect(playMock).not.toHaveBeenCalled();
  });

  describe('interval bell tone selection', () => {
    interface LoadedEntry {
      asset: unknown;
      // Tracks that this specific asset's player was PLAYED. seekTo alone is not
      // enough: the adapter seeks every player it restarts, so play is what
      // distinguishes the cue that actually sounded.
      play: jest.Mock<() => void>;
    }

    function mockDistinctSoundsPerLoad(): LoadedEntry[] {
      const created: LoadedEntry[] = [];
      mockedCreatePlayer.mockImplementation((asset) => {
        const entry: LoadedEntry = {
          asset: asset as unknown,
          play: jest.fn<() => void>(),
        };
        created.push(entry);
        // Returned, not resolved: createAudioPlayer is synchronous.
        return {
          seekTo: jest.fn<(seconds: number) => Promise<void>>().mockResolvedValue(undefined),
          play: entry.play,
          remove: jest.fn<() => void>(),
        } as unknown as ReturnType<typeof createAudioPlayer>;
      });
      return created;
    }

    it('plays the chime asset for the chime tone and the gong asset for the gong tone', async () => {
      const created = mockDistinctSoundsPerLoad();
      const adapter = createExpoAudioAdapter();
      await new Promise((resolve) => setImmediate(resolve));

      await adapter.play('interval_bell', 'chime');
      const chimeEntry = created.find((entry) => entry.play.mock.calls.length > 0);
      expect(chimeEntry?.asset).toBe(chimeAsset);

      await adapter.play('interval_bell', 'gong');
      const gongEntry = created.find(
        (entry) => entry !== chimeEntry && entry.play.mock.calls.length > 0,
      );
      expect(gongEntry?.asset).toBe(gongAsset);
    });

    it('defaults a toneless interval_bell play to the bowl asset', async () => {
      const created = mockDistinctSoundsPerLoad();
      const adapter = createExpoAudioAdapter();
      await new Promise((resolve) => setImmediate(resolve));

      await adapter.play('interval_bell');
      const bowlEntry = created.find((entry) => entry.play.mock.calls.length > 0);
      expect(bowlEntry?.asset).toBe(bowlAsset);
    });
  });

  it('disposes by unloading every loaded sound', async () => {
    const adapter = createExpoAudioAdapter();
    await new Promise((resolve) => setImmediate(resolve));

    adapter.dispose?.();
    // Six cues bundle real assets (start, halfway, bowl, chime, gong, end); metronome_tick was never loaded.
    expect(removeMock).toHaveBeenCalledTimes(6);
  });

  it('marks a cue as failed if replayAsync rejects, suppressing further warns', async () => {
    seekMock.mockRejectedValueOnce(new Error('decoder gone'));
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
