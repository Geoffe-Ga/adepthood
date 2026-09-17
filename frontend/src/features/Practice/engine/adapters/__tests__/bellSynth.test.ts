import { describe, expect, it } from '@jest/globals';

import {
  BELL_SAMPLE_RATE_HZ,
  BELL_TIMBRES,
  SilentRenderError,
  encodeBytesToBase64,
  renderBellSource,
  renderBellWav,
  type BellSpecKey,
  type TimbreSpec,
} from '../bellSynth';

/**
 * The bytes these tests read are the whole point of #1419: six 0-byte mp3s
 * resolved to valid asset modules, constructed players without throwing, and
 * played silence. Nothing above the file could see it. So every assertion here
 * is on the rendered samples themselves, never on "a player was created".
 */

const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;
const RIFF_SIZE_PREFIX_BYTES = 8;

/** Offsets into the canonical 44-byte RIFF/WAVE header these tests read back. */
const RIFF_SIZE_OFFSET = 4;
const CHANNELS_OFFSET = 22;
const SAMPLE_RATE_OFFSET = 24;
const BITS_PER_SAMPLE_OFFSET = 34;

const TONE_KEYS = ['bowl', 'chime', 'gong'] as const;
const BOUNDARY_KEYS = ['open', 'waypoint', 'close'] as const;
const ALL_KEYS = [...TONE_KEYS, ...BOUNDARY_KEYS];

/** A bell that peaks below this is silence with extra steps. */
const MIN_PEAK_FRACTION = 0.25;
const INT16_MAX = 32_767;

/** A strike is a strike only if it has largely rung out by the end. */
const STRIKE_DECAY_RATIO = 10;
const EDGE_FRACTION = 0.05;
const TAIL_FRACTION = 0.01;

/** Two bells a meditator must not confuse have to differ by more than this. */
const MIN_FREQUENCY_SEPARATION_HZ = 10;

/** The Goertzel window: long enough to resolve 10 Hz, short enough to be strike, not tail. */
const ANALYSIS_WINDOW_SECONDS = 0.3;

const ASCII = (bytes: Uint8Array, from: number, to: number): string =>
  String.fromCodePoint(...bytes.slice(from, to));

function viewOf(wav: Uint8Array): DataView {
  return new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
}

/** The data chunk of a canonical 44-byte-header WAV, as signed samples. */
function pcmFromWav(wav: Uint8Array): Int16Array {
  const view = viewOf(wav);
  const count = (wav.byteLength - WAV_HEADER_BYTES) / BYTES_PER_SAMPLE;
  const samples = new Int16Array(count);
  for (let index = 0; index < count; index += 1) {
    samples[index] = view.getInt16(WAV_HEADER_BYTES + index * BYTES_PER_SAMPLE, true);
  }
  return samples;
}

function peakOf(samples: Int16Array, from = 0, to = samples.length): number {
  let peak = 0;
  for (let index = from; index < to; index += 1) {
    peak = Math.max(peak, Math.abs(samples[index] ?? 0));
  }
  return peak;
}

/**
 * Goertzel magnitude at one frequency.
 *
 * Buffer inequality proves two renders differ; it says nothing about whether a
 * human hears two different bells. This does: it reads the energy actually
 * present at a frequency, so a chime retuned onto the bowl's fundamental fails
 * here while every byte-comparison in the suite stays green.
 */
function goertzelMagnitude(samples: Int16Array, frequencyHz: number): number {
  const windowSize = Math.min(
    samples.length,
    Math.round(ANALYSIS_WINDOW_SECONDS * BELL_SAMPLE_RATE_HZ),
  );
  const omega = (2 * Math.PI * frequencyHz) / BELL_SAMPLE_RATE_HZ;
  const coefficient = 2 * Math.cos(omega);
  let previous = 0;
  let beforePrevious = 0;
  for (let index = 0; index < windowSize; index += 1) {
    const current = (samples[index] ?? 0) + coefficient * previous - beforePrevious;
    beforePrevious = previous;
    previous = current;
  }
  return Math.sqrt(
    previous * previous + beforePrevious * beforePrevious - coefficient * previous * beforePrevious,
  );
}

/** Which of the six declared fundamentals carries the most energy in this render. */
function dominantFundamental(key: BellSpecKey): number {
  const samples = pcmFromWav(renderBellWav(BELL_TIMBRES[key]));
  const candidates = ALL_KEYS.map((name) => BELL_TIMBRES[name].fundamentalHz);
  let best = candidates[0] ?? 0;
  let bestMagnitude = -1;
  for (const candidate of candidates) {
    const magnitude = goertzelMagnitude(samples, candidate);
    if (magnitude > bestMagnitude) {
      bestMagnitude = magnitude;
      best = candidate;
    }
  }
  return best;
}

function silencedSpec(spec: TimbreSpec): TimbreSpec {
  return { ...spec, partials: spec.partials.map((partial) => ({ ...partial, gain: 0 })) };
}

describe('renderBellWav', () => {
  it('renders a valid 16-bit mono RIFF/WAVE per bell spec', () => {
    for (const key of ALL_KEYS) {
      const wav = renderBellWav(BELL_TIMBRES[key]);
      const view = viewOf(wav);
      expect(ASCII(wav, 0, 4)).toBe('RIFF');
      expect(ASCII(wav, 8, 12)).toBe('WAVE');
      expect(view.getUint32(RIFF_SIZE_OFFSET, true)).toBe(wav.byteLength - RIFF_SIZE_PREFIX_BYTES);
      expect(view.getUint16(CHANNELS_OFFSET, true)).toBe(1);
      expect(view.getUint32(SAMPLE_RATE_OFFSET, true)).toBe(BELL_SAMPLE_RATE_HZ);
      expect(view.getUint16(BITS_PER_SAMPLE_OFFSET, true)).toBe(16);
    }
  });

  it('renders non-silent PCM for every bell spec', () => {
    // This is #1419 expressed in bytes. A 0-byte mp3 fails nothing above this line.
    for (const key of ALL_KEYS) {
      const samples = pcmFromWav(renderBellWav(BELL_TIMBRES[key]));
      expect(samples.length).toBeGreaterThan(0);
      expect(peakOf(samples)).toBeGreaterThan(MIN_PEAK_FRACTION * INT16_MAX);
    }
  });

  it('gives every bell a percussive strike and a clean tail', () => {
    for (const key of ALL_KEYS) {
      const samples = pcmFromWav(renderBellWav(BELL_TIMBRES[key]));
      const edge = Math.floor(samples.length * EDGE_FRACTION);
      const head = peakOf(samples, 0, edge);
      const tail = peakOf(samples, samples.length - edge, samples.length);
      expect(head).toBeGreaterThanOrEqual(STRIKE_DECAY_RATIO * tail);
      // A non-zero final sample is an audible click when playback stops.
      expect(Math.abs(samples[samples.length - 1] ?? 0)).toBeLessThan(TAIL_FRACTION * head);
    }
  });
});

describe('bell distinguishability', () => {
  it('makes the three selectable tones spectrally distinguishable, not merely different bytes', () => {
    for (const key of TONE_KEYS) {
      expect(dominantFundamental(key)).toBe(BELL_TIMBRES[key].fundamentalHz);
    }
    for (const key of TONE_KEYS) {
      for (const other of TONE_KEYS) {
        if (key === other) continue;
        expect(
          Math.abs(BELL_TIMBRES[key].fundamentalHz - BELL_TIMBRES[other].fundamentalHz),
        ).toBeGreaterThan(MIN_FREQUENCY_SEPARATION_HZ);
      }
    }
  });

  it('never lets a boundary bell collide with a selectable interval tone', () => {
    // Under the shipped default `bell_tone: 'bowl'`, an end bell that reused the
    // bowl would be byte-identical to every interval strike of the same session:
    // the meditator could not tell "another interval" from "your sit is over".
    const toneSources = TONE_KEYS.map((key) => renderBellSource(BELL_TIMBRES[key]));
    for (const key of BOUNDARY_KEYS) {
      const dominant = dominantFundamental(key);
      expect(dominant).toBe(BELL_TIMBRES[key].fundamentalHz);
      for (const tone of TONE_KEYS) {
        expect(Math.abs(dominant - BELL_TIMBRES[tone].fundamentalHz)).toBeGreaterThan(
          MIN_FREQUENCY_SEPARATION_HZ,
        );
      }
      expect(toneSources).not.toContain(renderBellSource(BELL_TIMBRES[key]));
    }
  });
});

describe('renderBellSource', () => {
  it('hands back a data URI a bare createAudioPlayer(string) accepts on every platform', () => {
    for (const key of ALL_KEYS) {
      expect(renderBellSource(BELL_TIMBRES[key])).toMatch(/^data:audio\/wav;base64,[\w+/]+=*$/);
    }
  });

  it('refuses to hand back a silent source', () => {
    expect(() => renderBellSource(silencedSpec(BELL_TIMBRES.bowl))).toThrow(SilentRenderError);
  });
});

describe('encodeBytesToBase64', () => {
  it('encodes base64 without btoa or Buffer, including both padding cases', () => {
    // RFC 4648 §10. Hermes has neither `btoa` nor `Buffer`, so these vectors are
    // the only thing standing between the encoder and a silently wrong data URI.
    const vectors: readonly (readonly [string, string])[] = [
      ['', ''],
      ['f', 'Zg=='],
      ['fo', 'Zm8='],
      ['foo', 'Zm9v'],
      ['foob', 'Zm9vYg=='],
      ['fooba', 'Zm9vYmE='],
      ['foobar', 'Zm9vYmFy'],
    ];
    for (const [plain, encoded] of vectors) {
      const bytes = Uint8Array.from([...plain].map((char) => char.codePointAt(0) ?? 0));
      expect(encodeBytesToBase64(bytes)).toBe(encoded);
    }
  });

  it('encodes every byte value, so no high bit is lost on the way to a data URI', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_unused, index) => index);
    const encoded = encodeBytesToBase64(bytes);
    // Decoded through a path that is not the encoder under test.
    const decoded = Uint8Array.from(Buffer.from(encoded, 'base64'));
    expect([...decoded]).toEqual([...bytes]);
  });
});
