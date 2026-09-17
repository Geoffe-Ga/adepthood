// In-app bell synthesis for the ritual engine.
//
// #1419 shipped six 0-byte `bell-*.mp3` placeholders. They resolved to valid
// asset modules, constructed players without throwing, and played silence — so
// the failure was invisible to the user AND to the logs. The owner's decision of
// 2026-09-15 is to generate the bells in code instead of sourcing recordings,
// which removes the licensing dependency and makes audibility a checkable
// property rather than a property of a binary nobody opened.
//
// Everything here is pure TypeScript arithmetic over typed arrays. Deliberately
// NOT used, because none of them exist on all three targets:
//   - Web Audio (`OfflineAudioContext`, oscillators): absent under Hermes, and
//     expo-audio ships only AudioPlayer / AudioRecorder / AudioStream.
//   - `expo-file-system`: its whole File/Directory API is a `console.warn` stub
//     on web, and web is the platform this bug was reported from.
//   - `btoa` / `Buffer`: neither exists in the React Native runtime.
// The output is a `data:audio/wav;base64,…` string, which `createAudioPlayer`
// accepts bare on iOS (explicit `data:` decode), Android (DefaultDataSource)
// and web (HTMLMediaElement.src) with no `Platform.OS` branch.

import type { IntervalBellTone } from '../types';

/** Bells are short and percussive; 22.05 kHz is transparent for them and halves the bytes. */
export const BELL_SAMPLE_RATE_HZ = 22_050;
const BELL_BITS_PER_SAMPLE = 16;
const BELL_CHANNELS = 1;
const BYTES_PER_SAMPLE = BELL_BITS_PER_SAMPLE / 8;
const INT16_MAX = 32_767;
const MS_PER_SECOND = 1000;
const MS_PER_SAMPLE = MS_PER_SECOND / BELL_SAMPLE_RATE_HZ;
const TWO_PI = 2 * Math.PI;
const HALVING_BASE = 2;

/** Headroom below full scale, so a device's own limiter never has to clip the strike. */
const BELL_PEAK_FRACTION = 0.8;

/**
 * Below this the render is silence with extra steps — the exact condition six
 * empty mp3s satisfied for months. {@link renderBellSource} refuses to return one.
 */
const MIN_AUDIBLE_PEAK = 0.05 * INT16_MAX;

/** A struck bell reaches full amplitude almost instantly; 4 ms reads as a strike, not a fade-in. */
const BELL_ATTACK_SECONDS = 0.004;
/** And is ramped to exactly zero at the end, so stopping playback cannot click. */
const BELL_RELEASE_SECONDS = 0.02;
const BELL_ATTACK_SAMPLES = Math.round(BELL_ATTACK_SECONDS * BELL_SAMPLE_RATE_HZ);
const BELL_RELEASE_SAMPLES = Math.round(BELL_RELEASE_SECONDS * BELL_SAMPLE_RATE_HZ);

/** Canonical 44-byte RIFF/WAVE header: RIFF(12) + fmt (24) + data(8). */
const WAV_HEADER_BYTES = 44;
const WAV_RIFF_SIZE_PREFIX_BYTES = 8;
const WAV_FMT_CHUNK_BYTES = 16;
const WAV_PCM_FORMAT_TAG = 1;
const UINT16_BYTES = 2;
const UINT32_BYTES = 4;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_PAD = '=';
const BASE64_CHARS_PER_GROUP = 4;
const BITS_PER_BYTE = 8;
const BITS_PER_BASE64_CHAR = 6;
const BASE64_CHAR_MASK = 0b11_1111;

const WAV_DATA_URI_PREFIX = 'data:audio/wav;base64,';

/** One inharmonic partial of a struck bell. */
export interface BellPartial {
  /** Multiple of the fundamental. Non-integer ratios are what make metal sound like metal. */
  readonly ratio: number;
  /** Amplitude relative to the fundamental at the instant of the strike. */
  readonly gain: number;
  /** Time for this partial to halve. Shorter on the highs — that is the "ring out". */
  readonly decayHalfLifeMs: number;
}

/** A bell, entirely as data: change these numbers and the bell changes. */
export interface TimbreSpec {
  readonly fundamentalHz: number;
  readonly partials: readonly BellPartial[];
  readonly durationMs: number;
}

/**
 * The six bells this app rings: the three the user selects, and three the
 * engine chooses for the boundaries of a session.
 *
 * Boundary cues carry no `tone` (see `engine/types.ts` — `Cue.tone` is absent on
 * boundary and tick cues), so they cannot follow `config.bell_tone` without
 * changing the cue shape across all five mode builders. They get their own
 * timbres instead.
 */
export type BellSpecKey = IntervalBellTone | 'open' | 'waypoint' | 'close';

/**
 * Timbre is data, not code.
 *
 * The 2026-09-06 review rejected an earlier synthesis round as "game-console
 * tones". The cure is the partial structure, not the synthesis method: a
 * console beep is one harmonic stack decaying together, while struck metal is an
 * INHARMONIC cluster whose highs die several times faster than its fundamental,
 * with a pair of near-twin partials beating slowly against each other. All three
 * of those are numbers below. Retuning the bells is an edit to this table.
 *
 * Every decay half-life is kept under ~28% of its bell's duration, so each bell
 * has demonstrably rung out before the file ends rather than being cut off.
 */
export const BELL_TIMBRES: Record<BellSpecKey, TimbreSpec> = {
  /** The default interval tone. A Himalayan-style bowl: low, slow, two near-twin
   *  partials an octave up beating ~1.5 Hz against each other as a struck bowl does. */
  bowl: {
    fundamentalHz: 220,
    durationMs: 1200,
    partials: [
      { ratio: 1, gain: 1, decayHalfLifeMs: 300 },
      { ratio: 2, gain: 0.55, decayHalfLifeMs: 230 },
      { ratio: 2.0068, gain: 0.5, decayHalfLifeMs: 230 },
      { ratio: 2.74, gain: 0.32, decayHalfLifeMs: 170 },
      { ratio: 5.38, gain: 0.16, decayHalfLifeMs: 110 },
    ],
  },
  /** The light interval tone. Sparse, bright, near-harmonic, highs gone quickly. */
  chime: {
    fundamentalHz: 880,
    durationMs: 800,
    partials: [
      { ratio: 1, gain: 1, decayHalfLifeMs: 200 },
      { ratio: 2.01, gain: 0.42, decayHalfLifeMs: 120 },
      { ratio: 3.03, gain: 0.22, decayHalfLifeMs: 80 },
      { ratio: 4.97, gain: 0.1, decayHalfLifeMs: 50 },
    ],
  },
  /** The heavy interval tone. A dense low inharmonic cluster with the longest ring. */
  gong: {
    fundamentalHz: 110,
    durationMs: 1900,
    partials: [
      { ratio: 1, gain: 1, decayHalfLifeMs: 480 },
      { ratio: 1.48, gain: 0.6, decayHalfLifeMs: 400 },
      { ratio: 2.31, gain: 0.45, decayHalfLifeMs: 330 },
      { ratio: 3.17, gain: 0.3, decayHalfLifeMs: 260 },
      { ratio: 4.22, gain: 0.2, decayHalfLifeMs: 200 },
    ],
  },
  /** `start_bell`. Bowl family so it belongs to the same instrument, a fifth and
   *  an octave up from the bowl and shorter: warm, and clearly an opening. */
  open: {
    fundamentalHz: 330,
    durationMs: 900,
    partials: [
      { ratio: 1, gain: 1, decayHalfLifeMs: 230 },
      { ratio: 2, gain: 0.5, decayHalfLifeMs: 170 },
      { ratio: 2.0045, gain: 0.45, decayHalfLifeMs: 170 },
      { ratio: 2.74, gain: 0.28, decayHalfLifeMs: 120 },
      { ratio: 5.38, gain: 0.12, decayHalfLifeMs: 80 },
    ],
  },
  /** `halfway_bell`. Chime family, briefest of the six: a marker that ends nothing. */
  waypoint: {
    fundamentalHz: 550,
    durationMs: 500,
    partials: [
      { ratio: 1, gain: 1, decayHalfLifeMs: 120 },
      { ratio: 2.01, gain: 0.38, decayHalfLifeMs: 80 },
      { ratio: 3.03, gain: 0.18, decayHalfLifeMs: 55 },
    ],
  },
  /** `end_bell`. Gong family, the longest decay of all, and a fifth below the
   *  gong. It must never be mistaken for an interval strike: under the shipped
   *  default `bell_tone: 'bowl'` an end bell that reused a selectable tone would
   *  be byte-identical to every interval strike of the same session. */
  close: {
    fundamentalHz: 165,
    durationMs: 2400,
    partials: [
      { ratio: 1, gain: 1, decayHalfLifeMs: 620 },
      { ratio: 1.48, gain: 0.6, decayHalfLifeMs: 520 },
      { ratio: 2.31, gain: 0.45, decayHalfLifeMs: 420 },
      { ratio: 3.17, gain: 0.3, decayHalfLifeMs: 330 },
      { ratio: 4.22, gain: 0.2, decayHalfLifeMs: 250 },
    ],
  },
};

/**
 * Thrown when a render comes back inaudible.
 *
 * This is the invariant the six empty mp3s walked past. It lives at the single
 * place a playable source is born, so a future all-zero regression becomes a
 * thrown error the adapter already catches and warns about, not silence.
 */
export class SilentRenderError extends Error {
  constructor(peak: number) {
    super(`rendered bell peaked at ${peak}, below the audible floor of ${MIN_AUDIBLE_PEAK}`);
    this.name = 'SilentRenderError';
  }
}

interface RenderedPcm {
  readonly samples: Int16Array;
  readonly peak: number;
}

/**
 * Add one partial's decaying sine into the accumulating buffer.
 *
 * Per-partial decay is the whole difference between a bell and a beep. A beep's
 * harmonics fade together; a struck bell loses its highs first, which is why it
 * grows darker as it rings out — and why the half-lives in {@link BELL_TIMBRES}
 * shorten as the ratios climb.
 *
 * The decay is carried as a per-sample multiplier rather than recomputed as
 * `2 ** (-elapsed / halfLife)` at every sample. Same curve, one multiply instead
 * of a `Math.pow`: measured at 103 ms → 19 ms for all six bells, which is the
 * difference between a visible hitch on Practice screen mount and none.
 */
function addPartial(into: Float64Array, fundamentalHz: number, partial: BellPartial): void {
  const radiansPerSample = (TWO_PI * fundamentalHz * partial.ratio) / BELL_SAMPLE_RATE_HZ;
  const decayPerSample = HALVING_BASE ** (-MS_PER_SAMPLE / partial.decayHalfLifeMs);
  let amplitude = partial.gain;
  for (let index = 0; index < into.length; index += 1) {
    into[index] = (into[index] ?? 0) + amplitude * Math.sin(radiansPerSample * index);
    amplitude *= decayPerSample;
  }
}

/**
 * The strike envelope: a near-instant linear attack, and a short linear release
 * that reaches exactly zero on the final sample so playback cannot end in a click.
 */
function envelopeAt(sampleIndex: number, totalSamples: number): number {
  if (sampleIndex < BELL_ATTACK_SAMPLES) return sampleIndex / BELL_ATTACK_SAMPLES;
  const fromEnd = totalSamples - 1 - sampleIndex;
  if (fromEnd < BELL_RELEASE_SAMPLES) return fromEnd / BELL_RELEASE_SAMPLES;
  return 1;
}

/**
 * Render one bell to normalised 16-bit mono samples, reporting the peak.
 *
 * The peak is measured here and nowhere else: this is the invariant's home, and
 * {@link renderBellSource} is the only caller allowed to decide what to do about it.
 */
function renderBellPcm(spec: TimbreSpec): RenderedPcm {
  const totalSamples = Math.round((spec.durationMs / MS_PER_SECOND) * BELL_SAMPLE_RATE_HZ);
  const raw = new Float64Array(totalSamples);
  for (const partial of spec.partials) {
    addPartial(raw, spec.fundamentalHz, partial);
  }

  let rawPeak = 0;
  raw.forEach((value, index) => {
    const shaped = value * envelopeAt(index, totalSamples);
    raw[index] = shaped;
    rawPeak = Math.max(rawPeak, Math.abs(shaped));
  });

  const samples = new Int16Array(totalSamples);
  if (rawPeak === 0) return { samples, peak: 0 };

  const scale = (BELL_PEAK_FRACTION * INT16_MAX) / rawPeak;
  let peak = 0;
  raw.forEach((value, index) => {
    const sample = Math.round(value * scale);
    samples[index] = sample;
    peak = Math.max(peak, Math.abs(sample));
  });
  return { samples, peak };
}

/** Write a canonical 44-byte RIFF/WAVE header followed by little-endian int16 samples. */
function encodeWavPcm16(samples: Int16Array): Uint8Array {
  const dataBytes = samples.length * BYTES_PER_SAMPLE;
  const view = new DataView(new ArrayBuffer(WAV_HEADER_BYTES + dataBytes));
  let at = 0;
  // charCodeAt, not codePointAt: every chunk name here is ASCII, and charCodeAt
  // is typed `number` rather than `number | undefined`, so this stays free of a
  // fallback branch that could never be taken.
  const ascii = (text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(at, text.charCodeAt(index));
      at += 1;
    }
  };
  const uint32 = (value: number): void => {
    view.setUint32(at, value, true);
    at += UINT32_BYTES;
  };
  const uint16 = (value: number): void => {
    view.setUint16(at, value, true);
    at += UINT16_BYTES;
  };

  ascii('RIFF');
  uint32(WAV_HEADER_BYTES - WAV_RIFF_SIZE_PREFIX_BYTES + dataBytes);
  ascii('WAVE');
  ascii('fmt ');
  uint32(WAV_FMT_CHUNK_BYTES);
  uint16(WAV_PCM_FORMAT_TAG);
  uint16(BELL_CHANNELS);
  uint32(BELL_SAMPLE_RATE_HZ);
  uint32(BELL_SAMPLE_RATE_HZ * BELL_CHANNELS * BYTES_PER_SAMPLE);
  uint16(BELL_CHANNELS * BYTES_PER_SAMPLE);
  uint16(BELL_BITS_PER_SAMPLE);
  ascii('data');
  uint32(dataBytes);
  samples.forEach((sample) => {
    view.setInt16(at, sample, true);
    at += BYTES_PER_SAMPLE;
  });
  return new Uint8Array(view.buffer);
}

/**
 * Base64, first-party.
 *
 * Hermes provides neither `btoa` nor `Buffer`, and `base64-js` is present in
 * `node_modules` only transitively — importing it would be a phantom dependency
 * that a lockfile change could remove without anything failing until a bell went
 * quiet on a device. Exported so its padding branches are reachable from a test:
 * the six bell buffers happen to exercise only some of them.
 *
 * Bits are shifted through a small accumulator rather than read three at a time,
 * so the remainder cases fall out of the same loop instead of being a second
 * hand-written code path.
 */
export function encodeBytesToBase64(bytes: Uint8Array): string {
  let encoded = '';
  let bitBuffer = 0;
  let pendingBits = 0;
  for (const byte of bytes) {
    // Only the low `pendingBits + 8` bits are ever read back, so the 32-bit
    // overflow this accumulates past is unobservable.
    bitBuffer = (bitBuffer << BITS_PER_BYTE) | byte;
    pendingBits += BITS_PER_BYTE;
    while (pendingBits >= BITS_PER_BASE64_CHAR) {
      pendingBits -= BITS_PER_BASE64_CHAR;
      encoded += BASE64_ALPHABET.charAt((bitBuffer >> pendingBits) & BASE64_CHAR_MASK);
    }
  }
  if (pendingBits > 0) {
    const shift = BITS_PER_BASE64_CHAR - pendingBits;
    encoded += BASE64_ALPHABET.charAt((bitBuffer << shift) & BASE64_CHAR_MASK);
  }
  while (encoded.length % BASE64_CHARS_PER_GROUP !== 0) {
    encoded += BASE64_PAD;
  }
  return encoded;
}

/** Render one bell to a complete WAV byte stream. */
export function renderBellWav(spec: TimbreSpec): Uint8Array {
  return encodeWavPcm16(renderBellPcm(spec).samples);
}

/**
 * Render one bell to the `data:audio/wav;base64,…` URI `createAudioPlayer`
 * accepts as a bare string on iOS, Android and web alike.
 *
 * Throws {@link SilentRenderError} rather than returning an inaudible source.
 * The adapter calls this inside its existing `try`, so a silent render warns
 * exactly the way a missing asset always should have.
 */
export function renderBellSource(spec: TimbreSpec): string {
  const { samples, peak } = renderBellPcm(spec);
  if (peak < MIN_AUDIBLE_PEAK) throw new SilentRenderError(peak);
  return WAV_DATA_URI_PREFIX + encodeBytesToBase64(encodeWavPcm16(samples));
}
