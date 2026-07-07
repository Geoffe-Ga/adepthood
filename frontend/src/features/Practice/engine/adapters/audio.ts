// Audio adapter implementations for the ritual engine. Each cue resolves to a
// static asset bundled under `frontend/assets/sounds/` (interval_bell resolves
// per tone). If an asset is missing at load time, the adapter logs a single
// warning per sound and falls back to a no-op — a missing file must not break
// the practice session.

import { Audio } from 'expo-av';

import type { AudioAdapter, CueKind, IntervalBellTone } from '../types';

type SoundModule = number;

/** Default interval-bell tone applied when a play omits one; mirrors defaults.ts seeds. */
const DEFAULT_BELL_TONE: IntervalBellTone = 'bowl';

// Internal sound-table keys: tone-less cue kinds plus one entry per bell tone.
type SoundKey =
  | Exclude<CueKind, 'interval_bell'>
  | 'interval_bell_bowl'
  | 'interval_bell_chime'
  | 'interval_bell_gong';

/** Static asset map. `null` means "best-effort load; warn-then-noop if missing". */
const SOUND_ASSETS: Record<SoundKey, SoundModule | null> = {
  start_bell: require('../../../../../assets/sounds/bell-start.mp3') as SoundModule,
  halfway_bell: require('../../../../../assets/sounds/bell-half.mp3') as SoundModule,
  end_bell: require('../../../../../assets/sounds/bell-end.mp3') as SoundModule,
  interval_bell_bowl: require('../../../../../assets/sounds/bell-bowl.mp3') as SoundModule,
  interval_bell_chime: require('../../../../../assets/sounds/bell-chime.mp3') as SoundModule,
  interval_bell_gong: require('../../../../../assets/sounds/bell-gong.mp3') as SoundModule,
  // metronome-tick.wav is not yet shipped; load is best-effort.
  metronome_tick: null,
};

/**
 * Resolve a cue kind (and optional tone) to its internal sound-table key.
 * Tone-less kinds map to their own name; `interval_bell` maps to a
 * tone-specific key, defaulting a missing tone to {@link DEFAULT_BELL_TONE}.
 */
function soundKeyFor(kind: CueKind, tone?: IntervalBellTone): SoundKey {
  if (kind === 'interval_bell') return `interval_bell_${tone ?? DEFAULT_BELL_TONE}`;
  return kind;
}

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
  const entries = new Map<SoundKey, SoundEntry>();
  for (const key of Object.keys(SOUND_ASSETS) as SoundKey[]) {
    entries.set(key, makeEntry());
    void loadCue(key, entries);
  }

  return {
    play: (kind, tone) => playCue(soundKeyFor(kind, tone), entries),
    dispose: () => disposeAll(entries),
  };
}

async function loadCue(key: SoundKey, entries: Map<SoundKey, SoundEntry>): Promise<void> {
  const asset = SOUND_ASSETS[key];
  const entry = entries.get(key);
  if (!entry) return;
  if (asset === null) {
    markFailed(entry, key, 'asset not bundled');
    return;
  }
  try {
    const { sound } = await Audio.Sound.createAsync(asset);
    // expo-av's `Sound` class implements Playback's methods structurally but
    // TypeScript's class-side typing doesn't surface them as own members; cast
    // through unknown rather than tighten the structural contract.
    entry.sound = sound as unknown as PlayableSound;
  } catch (err) {
    markFailed(entry, key, err);
  }
}

function markFailed(entry: SoundEntry, key: SoundKey, reason: unknown): void {
  if (entry.failed) return;
  entry.failed = true;
  console.warn(`[ritual-audio] cue "${key}" unavailable — falling back to silent:`, reason);
}

async function playCue(key: SoundKey, entries: Map<SoundKey, SoundEntry>): Promise<void> {
  const entry = entries.get(key);
  if (!entry || entry.failed || !entry.sound) return;
  try {
    await entry.sound.replayAsync();
  } catch (err) {
    markFailed(entry, key, err);
  }
}

function disposeAll(entries: Map<SoundKey, SoundEntry>): void {
  for (const entry of entries.values()) {
    if (entry.sound) {
      void entry.sound.unloadAsync();
      entry.sound = null;
    }
  }
}
