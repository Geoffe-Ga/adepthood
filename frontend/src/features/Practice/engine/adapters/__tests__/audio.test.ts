import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createAudioPlayer } from 'expo-audio';
import type { setAudioModeAsync } from 'expo-audio';

import type { CueKind, IntervalBellTone } from '../../types';
import { bellSources, createExpoAudioAdapter, createNoopAudioAdapter } from '../audio';
import { BELL_TIMBRES, SilentRenderError, renderBellSource } from '../bellSynth';
import type { TimbreSpec } from '../bellSynth';

// The exact source each interval_bell tone must resolve to. Rendering the same
// timbre the adapter renders yields the identical data URI, so a swapped
// tone-to-timbre mapping fails the identity checks below.
//
// This replaces three `require('.../bell-*.mp3')` calls that asserted identity
// against 0-byte modules -- an assertion that is equally true of silence, which
// is exactly why the suite stayed green while every bell was inaudible (#1419).
const bowlSource = renderBellSource(BELL_TIMBRES.bowl);
const chimeSource = renderBellSource(BELL_TIMBRES.chime);
const gongSource = renderBellSource(BELL_TIMBRES.gong);

const mockedCreatePlayer = createAudioPlayer as jest.MockedFunction<typeof createAudioPlayer>;

/** Every bell cue is rendered; `metronome_tick` alone has no timbre. */
const BELL_CUE_COUNT = 6;
const DATA_URI = /^data:audio\/wav;base64,/;

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

  // metronome_tick is deliberately the ONLY cue without a timbre, so it stays the
  // one cue that can reach markFailed. That is not a statement that the other six
  // are healthy -- at HEAD they were six 0-byte files and warned about nothing.
  // They are now audibility-checked at render time instead (SilentRenderError).
  it('warns once for the timbre-less metronome_tick cue and degrades to no-op', async () => {
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

    // 1 warn from the decode failure + 1 from the timbre-less metronome_tick cue.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    await adapter.play('start_bell');
    // First cue had its load fail → no replay.
    expect(playMock).not.toHaveBeenCalled();
  });

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

  it('routes every cue to the timbre the user actually hears', async () => {
    // The SOUND_TIMBRES table is the mapping a meditator hears, and asserting on
    // the table itself would only restate it. This drives each cue through the
    // adapter and reads back the source that reached the player, so a one-token
    // edit to any of the six entries -- `end_bell: 'close'` to `'bowl'`, say --
    // is caught here rather than discovered in a session.
    const created = mockDistinctSoundsPerLoad();
    const adapter = createExpoAudioAdapter();
    await new Promise((resolve) => setImmediate(resolve));

    const sounded = async (kind: CueKind, tone?: IntervalBellTone): Promise<unknown> => {
      const already = new Set(created.filter((entry) => entry.play.mock.calls.length > 0));
      await adapter.play(kind, tone);
      return created.find((entry) => entry.play.mock.calls.length > 0 && !already.has(entry))
        ?.asset;
    };

    const heard = {
      start: await sounded('start_bell'),
      halfway: await sounded('halfway_bell'),
      end: await sounded('end_bell'),
      bowl: await sounded('interval_bell', 'bowl'),
      chime: await sounded('interval_bell', 'chime'),
      gong: await sounded('interval_bell', 'gong'),
    };

    expect(heard.start).toBe(renderBellSource(BELL_TIMBRES.open));
    expect(heard.halfway).toBe(renderBellSource(BELL_TIMBRES.waypoint));
    // Not any selectable tone: under the shipped default `bell_tone: 'bowl'` an
    // end bell that reused one would be byte-identical to every interval strike
    // of the same session. bellSynth.test.ts holds the other half of this claim --
    // that `close` is more than 10 Hz from all three tones.
    expect(heard.end).toBe(renderBellSource(BELL_TIMBRES.close));
    expect(heard.bowl).toBe(bowlSource);
    expect(heard.chime).toBe(chimeSource);
    expect(heard.gong).toBe(gongSource);
    expect(new Set(Object.values(heard)).size).toBe(BELL_CUE_COUNT);
  });

  it('renders each bell once per app session, not once per adapter', async () => {
    // The record-identity check above proves `bellSources()` memoises. It does
    // NOT prove the adapter goes through it: inlining
    // `renderBellSource(BELL_TIMBRES[timbre])` at the createAudioPlayer call
    // type-checks, keeps every other assertion green, and re-synthesizes all six
    // bells on every adapter construction. Only a spy on the render can see that.
    jest.resetModules();
    const actual = jest.requireActual('../bellSynth') as Record<string, unknown>;
    const renderSpy = jest.fn(actual['renderBellSource'] as (spec: TimbreSpec) => string);
    jest.doMock('../bellSynth', () => ({ ...actual, renderBellSource: renderSpy }));
    const freshAudio = require('../audio') as {
      createExpoAudioAdapter: typeof createExpoAudioAdapter;
    };

    freshAudio.createExpoAudioAdapter();
    freshAudio.createExpoAudioAdapter();
    await new Promise((resolve) => setImmediate(resolve));

    expect(renderSpy).toHaveBeenCalledTimes(BELL_CUE_COUNT);
    jest.dontMock('../bellSynth');
  });

  describe('interval bell tone selection', () => {
    it('plays the chime source for the chime tone and the gong source for the gong tone', async () => {
      const created = mockDistinctSoundsPerLoad();
      const adapter = createExpoAudioAdapter();
      await new Promise((resolve) => setImmediate(resolve));

      await adapter.play('interval_bell', 'chime');
      const chimeEntry = created.find((entry) => entry.play.mock.calls.length > 0);
      expect(chimeEntry?.asset).toBe(chimeSource);

      await adapter.play('interval_bell', 'gong');
      const gongEntry = created.find(
        (entry) => entry !== chimeEntry && entry.play.mock.calls.length > 0,
      );
      expect(gongEntry?.asset).toBe(gongSource);
      // Two tones, two genuinely different sounds -- not two names for one.
      expect(chimeSource).not.toBe(gongSource);
    });

    it('defaults a toneless interval_bell play to the bowl source', async () => {
      const created = mockDistinctSoundsPerLoad();
      const adapter = createExpoAudioAdapter();
      await new Promise((resolve) => setImmediate(resolve));

      await adapter.play('interval_bell');
      const bowlEntry = created.find((entry) => entry.play.mock.calls.length > 0);
      expect(bowlEntry?.asset).toBe(bowlSource);
    });
  });

  it('disposes by unloading every loaded sound', async () => {
    const adapter = createExpoAudioAdapter();
    await new Promise((resolve) => setImmediate(resolve));

    adapter.dispose?.();
    // Six cues render a timbre (start, halfway, bowl, chime, gong, end);
    // metronome_tick has none and was never loaded.
    expect(removeMock).toHaveBeenCalledTimes(BELL_CUE_COUNT);
  });

  it('hands createAudioPlayer a synthesized data URI for every bell cue', async () => {
    createExpoAudioAdapter();
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockedCreatePlayer).toHaveBeenCalledTimes(BELL_CUE_COUNT);
    expect(mockedCreatePlayer).toHaveBeenCalledWith(expect.stringMatching(DATA_URI));
    for (const call of mockedCreatePlayer.mock.calls) {
      expect(call[0]).toEqual(expect.stringMatching(DATA_URI));
    }
  });

  it('synthesizes once per app session, not once per adapter', () => {
    // Object identity on the RECORD. A `toBe` on two source strings is
    // `Object.is` over primitives, which is true for two equal strings that were
    // rendered independently -- so it could not detect a deleted memo at all.
    expect(bellSources()).toBe(bellSources());
  });

  it('enables playback in silent mode once, however many adapters are built', async () => {
    // `audioSessionConfigured` is module-level mutable state that outlives an
    // `it()`, while `clearMocks` wipes the call record -- so this assertion is
    // order-dependent unless the module is rebuilt here.
    jest.resetModules();
    const freshAudio = require('../audio') as {
      createExpoAudioAdapter: typeof createExpoAudioAdapter;
    };
    const freshExpoAudio = require('expo-audio') as {
      setAudioModeAsync: jest.MockedFunction<typeof setAudioModeAsync>;
    };
    const freshSetAudioMode = freshExpoAudio.setAudioModeAsync;

    freshAudio.createExpoAudioAdapter();
    freshAudio.createExpoAudioAdapter();
    await new Promise((resolve) => setImmediate(resolve));

    // Without playsInSilentMode a meditation app is inaudible in exactly the
    // device state its users are most likely to be in: ringer switch silent.
    expect(freshSetAudioMode).toHaveBeenCalledTimes(1);
    expect(freshSetAudioMode).toHaveBeenCalledWith(
      expect.objectContaining({ playsInSilentMode: true }),
    );
  });

  it('warns instead of going quiet when a bell renders silent', async () => {
    // The hole #1419 fell through: a 0-byte mp3 resolved to a valid module and
    // constructed a player without throwing, so `markFailed` was unreachable for
    // all six bell cues and the app was silent in the room AND in the logs.
    // Rendering is now the single place a playable source is born, and an
    // inaudible one throws into the try that was always there.
    jest.resetModules();
    jest.doMock('../bellSynth', () => {
      const actual = jest.requireActual('../bellSynth') as Record<string, unknown>;
      return {
        ...actual,
        renderBellSource: () => {
          throw new SilentRenderError(0);
        },
      };
    });
    // Everything asserted below has to be read off the module instance the fresh
    // adapter actually uses. `playMock` and `mockedCreatePlayer` belong to the
    // registry that resetModules just discarded, so an assertion against them
    // here could never fail and would read as coverage while proving nothing.
    const freshExpoAudio = require('expo-audio') as {
      createAudioPlayer: jest.MockedFunction<typeof createAudioPlayer>;
    };
    const freshPlay = jest.fn<() => void>();
    freshExpoAudio.createAudioPlayer.mockReturnValue({
      seekTo: jest.fn<(seconds: number) => Promise<void>>().mockResolvedValue(undefined),
      play: freshPlay,
      remove: jest.fn<() => void>(),
    } as unknown as ReturnType<typeof createAudioPlayer>);
    const freshAudio = require('../audio') as {
      createExpoAudioAdapter: typeof createExpoAudioAdapter;
    };

    const adapter = freshAudio.createExpoAudioAdapter();
    await new Promise((resolve) => setImmediate(resolve));

    const silentWarn = warnSpy.mock.calls.find((call) => call[1] instanceof SilentRenderError);
    expect(silentWarn).toBeDefined();
    expect(String(silentWarn?.[0])).toContain('falling back to silent');
    // No player is built on a source that never became audible -- a degraded
    // source handed to createAudioPlayer would be the silent failure all over again.
    expect(freshExpoAudio.createAudioPlayer).not.toHaveBeenCalled();
    // All six bell cues report it, not one: the timbres are a single static table
    // rendered together, so an inaudible render is a code defect and is meant to
    // be loud. Plus the standing metronome_tick warning.
    expect(warnSpy).toHaveBeenCalledTimes(BELL_CUE_COUNT + 1);
    await adapter.play('end_bell');
    expect(freshPlay).not.toHaveBeenCalled();
    jest.dontMock('../bellSynth');
  });

  it('warns rather than rejecting when the audio session cannot be configured', async () => {
    jest.resetModules();
    const freshExpoAudio = require('expo-audio') as {
      setAudioModeAsync: jest.MockedFunction<typeof setAudioModeAsync>;
    };
    freshExpoAudio.setAudioModeAsync.mockRejectedValueOnce(new Error('no audio session'));
    const freshAudio = require('../audio') as {
      createExpoAudioAdapter: typeof createExpoAudioAdapter;
    };

    freshAudio.createExpoAudioAdapter();
    await new Promise((resolve) => setImmediate(resolve));

    // A bare `void` on a rejecting promise is an unhandled rejection, which RN
    // surfaces as a redbox in dev -- over an optional convenience.
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('audio session'))).toBe(true);
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
