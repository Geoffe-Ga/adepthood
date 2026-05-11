// Audio adapter implementations for the ritual engine. Each cue kind maps to
// a static asset bundled under `frontend/assets/sounds/`. If an asset is
// missing at load time, the adapter logs a single warning per cue and falls
// back to a no-op — a missing file must not break the practice session.

import { Audio } from 'expo-av';

import type { AudioAdapter, CueKind } from '../types';

type SoundModule = number;

/** Static asset map. `null` means "best-effort load; warn-then-noop if missing". */
const CUE_ASSETS: Record<CueKind, SoundModule | null> = {
  start_bell: require('../../../../../assets/sounds/bell-start.mp3') as SoundModule,
  halfway_bell: require('../../../../../assets/sounds/bell-half.mp3') as SoundModule,
  end_bell: require('../../../../../assets/sounds/bell-end.mp3') as SoundModule,
  // interval_bell reuses the mid-tone bell asset; future polish can swap in
  // tone-specific variants based on IntervalBellConfig.bell_tone.
  interval_bell: require('../../../../../assets/sounds/bell-half.mp3') as SoundModule,
  // metronome-tick.wav is not yet shipped; load is best-effort.
  metronome_tick: null,
};

// Structural type for the subset of expo-av's Sound surface this adapter uses.
// Avoids tangling with expo-av's class typing while keeping the contract clear.
interface PlayableSound {
  replayAsync: () => Promise<unknown>;
  unloadAsync: () => Promise<unknown>;
}

interface SoundEntry {
  sound: PlayableSound | null;
  failed: boolean;
}

function makeEntry(): SoundEntry {
  return { sound: null, failed: false };
}

/** No-op adapter for tests and when audio assets are intentionally absent. */
export function createNoopAudioAdapter(): AudioAdapter {
  return {
    play: () => undefined,
    dispose: () => undefined,
  };
}

/**
 * expo-av-backed adapter. Sound loading is fire-and-forget; if an asset
 * fails to load, that cue degrades to a no-op and a single warning is
 * emitted (subsequent plays do not re-warn).
 */
export function createExpoAudioAdapter(): AudioAdapter {
  const entries = new Map<CueKind, SoundEntry>();
  for (const kind of Object.keys(CUE_ASSETS) as CueKind[]) {
    entries.set(kind, makeEntry());
    void loadCue(kind, entries);
  }

  return {
    play: (kind) => playCue(kind, entries),
    dispose: () => disposeAll(entries),
  };
}

async function loadCue(kind: CueKind, entries: Map<CueKind, SoundEntry>): Promise<void> {
  const asset = CUE_ASSETS[kind];
  const entry = entries.get(kind);
  if (!entry) return;
  if (asset === null) {
    markFailed(entry, kind, 'asset not bundled');
    return;
  }
  try {
    const { sound } = await Audio.Sound.createAsync(asset);
    // expo-av's `Sound` class implements Playback's methods structurally but
    // TypeScript's class-side typing doesn't surface them as own members; cast
    // through unknown rather than tighten the structural contract.
    entry.sound = sound as unknown as PlayableSound;
  } catch (err) {
    markFailed(entry, kind, err);
  }
}

function markFailed(entry: SoundEntry, kind: CueKind, reason: unknown): void {
  if (entry.failed) return;
  entry.failed = true;
  console.warn(`[ritual-audio] cue "${kind}" unavailable — falling back to silent:`, reason);
}

async function playCue(kind: CueKind, entries: Map<CueKind, SoundEntry>): Promise<void> {
  const entry = entries.get(kind);
  if (!entry || entry.failed || !entry.sound) return;
  try {
    await entry.sound.replayAsync();
  } catch (err) {
    markFailed(entry, kind, err);
  }
}

function disposeAll(entries: Map<CueKind, SoundEntry>): void {
  for (const entry of entries.values()) {
    if (entry.sound) {
      void entry.sound.unloadAsync();
      entry.sound = null;
    }
  }
}
