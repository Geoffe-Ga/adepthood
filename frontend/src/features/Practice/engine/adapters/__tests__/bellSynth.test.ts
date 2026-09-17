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

/**
 * Thresholds below are floors chosen from the measured spectra with roughly 2x
 * headroom, not round numbers: the smallest overtone any bell actually carries is
 * 0.0375 of its fundamental, the brightest any bell stays into its second half is
 * 0.19 of its own opening brightness, and the weakest sustain and RMS measured
 * are 0.19 and 0.17 of peak.
 */
const MIN_OVERTONE_FRACTION = 0.02;
const MAX_LATE_BRIGHTNESS_FRACTION = 0.5;
const MIN_SUSTAIN_FRACTION = 0.08;
const MIN_RMS_FRACTION = 0.08;
const SUSTAIN_WINDOW_FRACTION = 0.05;

/** How far from a whole number a ratio has to sit before it is worth calling inharmonic. */
const MIN_INHARMONIC_OFFSET = 0.1;
/** And how decisively it must out-shout the harmonic slot it sits beside. */
const INHARMONIC_DOMINANCE = 5;

/**
 * The four bells that claim to be struck metal clusters.
 *
 * `chime` and `waypoint` are deliberately NEAR-harmonic -- that is what makes them
 * read as bright and light rather than as heavy metal -- so the inharmonicity
 * assertion does not apply to them. They are held by the overtone and
 * highs-die-first assertions instead, which cover every bell.
 */
const METAL_CLUSTER_KEYS = ['bowl', 'gong', 'open', 'close'] as const;

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
function goertzelMagnitude(samples: Int16Array, frequencyHz: number, startIndex = 0): number {
  const windowSize = Math.min(
    samples.length - startIndex,
    Math.round(ANALYSIS_WINDOW_SECONDS * BELL_SAMPLE_RATE_HZ),
  );
  const omega = (2 * Math.PI * frequencyHz) / BELL_SAMPLE_RATE_HZ;
  const coefficient = 2 * Math.cos(omega);
  let previous = 0;
  let beforePrevious = 0;
  for (let index = 0; index < windowSize; index += 1) {
    const current = (samples[startIndex + index] ?? 0) + coefficient * previous - beforePrevious;
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

function rmsOf(samples: Int16Array, from: number, to: number): number {
  let total = 0;
  for (let index = from; index < to; index += 1) {
    const sample = samples[index] ?? 0;
    total += sample * sample;
  }
  return Math.sqrt(total / (to - from));
}

function pcmFor(key: BellSpecKey): Int16Array {
  return pcmFromWav(renderBellWav(BELL_TIMBRES[key]));
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

describe('bell timbre', () => {
  // A pure sine at the right fundamental passes spectral separation, non-silence
  // and the strike envelope. The whole partial table can collapse to six sine
  // tones with every one of those still green -- and "game-console tones" is the
  // exact ground on which an earlier synthesis round was rejected. These three
  // tests are what stand between this feature and that recurrence.

  it('gives every bell overtones rather than a single sine', () => {
    for (const key of ALL_KEYS) {
      const samples = pcmFor(key);
      const spec = BELL_TIMBRES[key];
      const fundamental = goertzelMagnitude(samples, spec.fundamentalHz);
      for (const partial of spec.partials.filter((candidate) => candidate.ratio !== 1)) {
        const overtone = goertzelMagnitude(samples, spec.fundamentalHz * partial.ratio);
        expect(overtone / fundamental).toBeGreaterThan(MIN_OVERTONE_FRACTION);
      }
    }
  });

  it('lets the highs die first, as struck metal does and a beep does not', () => {
    // One decay rate shared by every partial is a beep that fades. A bell grows
    // DARKER as it rings out, so its brightness relative to its own fundamental
    // must fall between the strike and the second half of the sound.
    for (const key of ALL_KEYS) {
      const samples = pcmFor(key);
      const spec = BELL_TIMBRES[key];
      const highest = spec.partials[spec.partials.length - 1];
      const highestHz = spec.fundamentalHz * (highest?.ratio ?? 1);
      const late = Math.floor(samples.length / 2);
      const earlyBrightness =
        goertzelMagnitude(samples, highestHz) / goertzelMagnitude(samples, spec.fundamentalHz);
      const lateBrightness =
        goertzelMagnitude(samples, highestHz, late) /
        goertzelMagnitude(samples, spec.fundamentalHz, late);
      expect(lateBrightness).toBeLessThan(MAX_LATE_BRIGHTNESS_FRACTION * earlyBrightness);
    }
  });

  it('puts its energy off the harmonic grid for the bells that claim to be metal', () => {
    // The ratios come from the table; the energy is measured. A table snapped to
    // whole-number ratios -- a harmonic stack, which is what a console beep is --
    // moves the energy to the slot this asserts is the quieter of the two.
    for (const key of METAL_CLUSTER_KEYS) {
      const samples = pcmFor(key);
      const spec = BELL_TIMBRES[key];
      const inharmonic = spec.partials.filter(
        (partial) =>
          Math.abs(partial.ratio - Math.round(partial.ratio)) >= MIN_INHARMONIC_OFFSET &&
          Math.round(partial.ratio) >= 2,
      );
      expect(inharmonic.length).toBeGreaterThan(0);
      for (const partial of inharmonic) {
        const atPartial = goertzelMagnitude(samples, spec.fundamentalHz * partial.ratio);
        const atNearestHarmonic = goertzelMagnitude(
          samples,
          spec.fundamentalHz * Math.round(partial.ratio),
        );
        expect(atPartial).toBeGreaterThan(INHARMONIC_DOMINANCE * atNearestHarmonic);
      }
    }
  });

  it('rings for its whole length instead of clicking and stopping', () => {
    // The strike assertion bounds the sound from above -- it must decay. Nothing
    // bounded it from below, so a 40 ms click padded with silence satisfied
    // non-silence AND the strike envelope AND spectral separation. A bell is the
    // part between those two bounds.
    for (const key of ALL_KEYS) {
      const samples = pcmFor(key);
      const overall = peakOf(samples);
      const middle = Math.floor(samples.length / 2);
      const halfWindow = Math.floor(samples.length * SUSTAIN_WINDOW_FRACTION);
      const sustained = peakOf(samples, middle - halfWindow, middle + halfWindow);
      expect(sustained).toBeGreaterThan(MIN_SUSTAIN_FRACTION * overall);
      expect(rmsOf(samples, 0, samples.length)).toBeGreaterThan(MIN_RMS_FRACTION * overall);
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
