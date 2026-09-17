// Audio adapter implementations for the ritual engine. Each cue resolves to a
// bell rendered in-app as 16-bit mono PCM and handed to expo-audio as a
// `data:audio/wav;base64,…` URI (interval_bell resolves per tone); no audio is
// bundled. If a cue has no timbre, or its render comes back inaudible, the
// adapter logs a single warning per sound and falls back to a no-op — a cue that
// cannot sound must not break the practice session.
//
// Note the blast radius deliberately: the six timbres are one static table
// rendered together, so an inaudible render is a code defect rather than a
// per-device condition, and it degrades ALL SIX bell cues (each warning once)
// rather than one. Failing loudly and completely is the right answer to a
// programming error; it is not per-cue isolation, and nothing here pretends it is.
//
// Before #1419 this file required six `bell-*.mp3` assets that were 0 bytes.
// They resolved, constructed players, and played nothing, so `markFailed` was
// never reached and the failure was invisible in the logs as well as the room.

import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';

import type { AudioAdapter, CueKind, IntervalBellTone } from '../types';

import { BELL_TIMBRES, renderBellSource, type BellSpecKey } from './bellSynth';

/** Default interval-bell tone applied when a play omits one; mirrors defaults.ts seeds. */
const DEFAULT_BELL_TONE: IntervalBellTone = 'bowl';

// Internal sound-table keys: tone-less cue kinds plus one entry per bell tone.
type SoundKey =
  | Exclude<CueKind, 'interval_bell'>
  | 'interval_bell_bowl'
  | 'interval_bell_chime'
  | 'interval_bell_gong';

/**
 * Which timbre each cue rings. `null` means "no sound; warn once and no-op".
 *
 * The three boundary cues get their OWN timbres rather than following
 * `config.bell_tone`, because `Cue.tone` is absent on boundary cues by design
 * (`engine/types.ts`) and threading one on would change the cue shape across all
 * five mode builders. `end_bell` in particular is deliberately not any
 * selectable tone: under the shipped default `bell_tone: 'bowl'`
 * (`configurator/defaults.ts`), `cuesForIntervalBell` opens, marks and closes a
 * session with the same cue kinds, so a bowl end bell would be byte-identical to
 * every interval strike of that session — and "was that an interval or the end?"
 * is the one discrimination a meditation timer owes its user.
 *
 * Reversing the decision means editing the three values below — all three, not
 * one. Making boundary bells genuinely FOLLOW `config.bell_tone`, which is the
 * likelier reading of the instruction, is not a table edit at all: it needs a
 * `tone` on boundary cues, which `Cue` does not carry and all five builders emit.
 */
const SOUND_TIMBRES: Record<SoundKey, BellSpecKey | null> = {
  start_bell: 'open',
  halfway_bell: 'waypoint',
  end_bell: 'close',
  interval_bell_bowl: 'bowl',
  interval_bell_chime: 'chime',
  interval_bell_gong: 'gong',
  // The metronome is silent at HEAD and stays silent here: giving it a sound is
  // a new user-facing behaviour at up to 4 Hz that #1419 never asked for. Keeping
  // it timbre-less also keeps `markFailed` reachable from a real cue.
  metronome_tick: null,
};

let bellSourceCache: Record<BellSpecKey, string> | null = null;

/**
 * The six rendered bells, synthesized at most once per app session.
 *
 * Measured cold: ~85-95 ms for all six on optimized V8 (Node 22), producing
 * 22.05 kHz mono PCM — 7.7 s of audio, 443 KB of base64. Under Jest's
 * transformed, unoptimised runtime the same work takes ~450 ms, and neither
 * number is a Hermes measurement; this repo has no `frontend/ios` or
 * `frontend/android` to take one in.
 *
 * Deliberately NOT a module-level const. The import chain
 * `BottomTabs → PracticeScreen → ActiveRitualSession → adapters/audio` is static
 * and unconditional, so an eager const would pay that cost during bundle
 * evaluation, at app boot, for every user — including users who never open
 * Practice. Behind this accessor it is paid once, on the first adapter
 * construction, which happens on Practice screen mount and therefore seconds
 * before the `start_bell` at `atMs: 0`. Both construction sites
 * (ActiveRitualSession and RandomIntervalBellView) share the one cache.
 *
 * If a device measurement ever makes that too slow, the levers in order are:
 * shorten `close` (2400 ms is the longest), drop the lowest-gain partials, then
 * halve the sample rate. Never re-introduce a silent table entry.
 */
export function bellSources(): Record<BellSpecKey, string> {
  bellSourceCache ??= {
    bowl: renderBellSource(BELL_TIMBRES.bowl),
    chime: renderBellSource(BELL_TIMBRES.chime),
    gong: renderBellSource(BELL_TIMBRES.gong),
    open: renderBellSource(BELL_TIMBRES.open),
    waypoint: renderBellSource(BELL_TIMBRES.waypoint),
    close: renderBellSource(BELL_TIMBRES.close),
  };
  return bellSourceCache;
}

let audioSessionConfigured = false;

/**
 * Ask iOS to keep playing when the ringer switch is silent.
 *
 * expo-audio defaults `playsInSilentMode` to false, and nothing in this app ever
 * called this — so even with correct bytes the bells stay inaudible in a
 * meditation app's single most likely device state. `mixWithOthers` is
 * deliberate: a bell should ring over whatever ambient audio the user chose
 * rather than duck it. A no-op on web and Android.
 *
 * The `.catch` is load-bearing, not decoration: a bare `void` on a rejecting
 * promise is an unhandled rejection, and this is an optional convenience that
 * must never take the session down.
 */
function configureAudioSessionOnce(): void {
  if (audioSessionConfigured) return;
  audioSessionConfigured = true;
  void setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'mixWithOthers' }).catch(
    (err: unknown) => {
      console.warn(
        '[ritual-audio] audio session not configured; the ringer switch may mute the bells:',
        err,
      );
    },
  );
}

/**
 * Resolve a cue kind (and optional tone) to its internal sound-table key.
 * Tone-less kinds map to their own name; `interval_bell` maps to a
 * tone-specific key, defaulting a missing tone to {@link DEFAULT_BELL_TONE}.
 */
function soundKeyFor(kind: CueKind, tone?: IntervalBellTone): SoundKey {
  if (kind === 'interval_bell') return `interval_bell_${tone ?? DEFAULT_BELL_TONE}`;
  return kind;
}

// Structural type for the subset of expo-audio's AudioPlayer this adapter uses.
// Kept structural for the same reason it always was: the adapter should depend on
// the three operations it performs, not on the library's class typing.
//
// expo-av's `replayAsync` has no equivalent — expo-audio separates seeking from
// playing — so restarting a cue is `seekTo(0)` then `play()`. That ordering
// matters: a cue retriggered mid-playback must restart from the top, which is
// what a ritual bell means, rather than resuming wherever it was.
interface PlayableSound {
  seekTo: (seconds: number) => Promise<void>;
  play: () => void;
  remove: () => void;
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
 * expo-audio-backed adapter. Sound loading is fire-and-forget; if a cue has no
 * timbre, renders inaudible, or fails to construct a player, that cue degrades
 * to a no-op and a single warning is emitted (subsequent plays do not re-warn).
 */
export function createExpoAudioAdapter(): AudioAdapter {
  configureAudioSessionOnce();
  const entries = new Map<SoundKey, SoundEntry>();
  for (const key of Object.keys(SOUND_TIMBRES) as SoundKey[]) {
    entries.set(key, makeEntry());
    void loadCue(key, entries);
  }

  return {
    play: (kind, tone) => playCue(soundKeyFor(kind, tone), entries),
    dispose: () => disposeAll(entries),
  };
}

async function loadCue(key: SoundKey, entries: Map<SoundKey, SoundEntry>): Promise<void> {
  const timbre = SOUND_TIMBRES[key];
  const entry = entries.get(key);
  if (!entry) return;
  if (timbre === null) {
    markFailed(entry, key, 'no timbre is synthesized for this cue');
    return;
  }
  try {
    // expo-audio's createAudioPlayer is synchronous — it returns a player
    // immediately and loads in the background, where expo-av returned a promise.
    // The enclosing function stays async so every call site keeps its contract;
    // only the await disappears.
    //
    // A SilentRenderError from bellSources() lands in this same catch, so an
    // inaudible render warns exactly the way a missing asset always should have.
    // That is the hole #1419 fell through, closed at the only place a playable
    // source is born.
    entry.sound = createAudioPlayer(bellSources()[timbre]) as unknown as PlayableSound;
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
    await entry.sound.seekTo(0);
    entry.sound.play();
  } catch (err) {
    markFailed(entry, key, err);
  }
}

function disposeAll(entries: Map<SoundKey, SoundEntry>): void {
  for (const entry of entries.values()) {
    if (entry.sound) {
      entry.sound.remove();
      entry.sound = null;
    }
  }
}
