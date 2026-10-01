import { describe, expect, it } from '@jest/globals';

import { HIGHER_SELF_COPY_ENTRIES, HIGHER_SELF_GAIN } from '../higherSelfCopy';

import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';
import { readBackendSource } from '@/testing/backendSource';

/**
 * What saying yes to sorting gives somebody, held to what the grounding code does.
 *
 * ``services/higher_self_grounding.py`` decides what one reflection reads: a few
 * passages from the sorted corpus, biased toward the reader's position in the
 * course, or -- when the corpus is empty -- the few most recent other entries.
 * Never both, never more than ``GROUNDING_LIMIT``, never an Intimate entry. The
 * gain line may say exactly that much and no more, so these guards ban every
 * stronger claim the issue warned against by name.
 */

/** Claims the grounding code cannot back: it reads a few passages, not a life. */
const OVERCLAIMS =
  /perfect|all of your writing is read|has read (all|everything)|every reflection reads|best resonance|knows everything|knows how you coach|every Aspect|\bmore than your\b/iu;

/** Plumbing words the reader never needs to learn to make this decision. */
const JARGON = /system prompt|retrieval|fragment|ontolog|corpus store|embedding/iu;

/** The grounding bound, read from the module that enforces it. */
function groundingLimit(): number {
  const match = /^GROUNDING_LIMIT = (\d+)$/mu.exec(
    readBackendSource('src', 'services', 'higher_self_grounding.py'),
  );
  expect(match).not.toBeNull();
  return Number(match?.[1]);
}

describe('higherSelfCopy — the gain, verbatim', () => {
  it('HIGHER_SELF_GAIN frames the gain as the sorting decision and bounds it', () => {
    expect(HIGHER_SELF_GAIN).toBe(
      'Say yes to sorting, and everything you write here, apart from Intimate entries and ' +
        'including what you have already written, is sorted by Aspect. Each reflection from ' +
        'your Higher Self can then draw on a few of those passages, leaning toward where you ' +
        'stand in the course, rather than only on your last few entries.',
    );
  });

  it('exposes every line it owns to the sweeps', () => {
    expect(HIGHER_SELF_COPY_ENTRIES).toEqual([HIGHER_SELF_GAIN]);
  });
});

describe('higherSelfCopy — says what it gives', () => {
  it('names the Higher Self and the Aspects, and contrasts with recent entries', () => {
    expect(HIGHER_SELF_GAIN).toMatch(/Higher Self/u);
    expect(HIGHER_SELF_GAIN).toMatch(/by Aspect/u);
    expect(HIGHER_SELF_GAIN).toMatch(/rather than only on your last few entries/u);
  });

  it('is the corpus decision, not a consequence of anything else', () => {
    expect(HIGHER_SELF_GAIN).toMatch(/^Say yes to sorting/u);
    expect(HIGHER_SELF_GAIN).not.toMatch(/vault/iu);
  });

  it('names the Intimate exclusion, because it speaks of everything you write', () => {
    expect(HIGHER_SELF_GAIN).toMatch(/everything you write/u);
    expect(HIGHER_SELF_GAIN).toMatch(/apart from Intimate entries/u);
  });

  it('says a few passages, because the grounding reads a bounded handful', () => {
    expect(HIGHER_SELF_GAIN).toMatch(/a few of those passages/u);
  });
});

describe('higherSelfCopy — claims nothing the grounding code lacks', () => {
  for (const line of HIGHER_SELF_COPY_ENTRIES) {
    it(`"${line.slice(0, 32)}..." makes no stronger claim than the code`, () => {
      expect(line).not.toMatch(OVERCLAIMS);
    });

    it(`"${line.slice(0, 32)}..." uses none of the plumbing vocabulary`, () => {
      expect(line).not.toMatch(JARGON);
    });

    it(`"${line.slice(0, 32)}..." neither ranks nor pressures`, () => {
      expect(ranksOrShames(line)).toBe(false);
      expect(line).not.toMatch(/anonym|encrypt|\bprivate\b/iu);
      expect(line).not.toMatch(/[‘’“”]/u);
    });

    it(`"${line.slice(0, 32)}..." states no count but the published one`, () => {
      const limit = groundingLimit();
      for (const digits of line.match(/\d+/gu) ?? []) {
        expect(Number(digits)).toBe(limit);
      }
    });
  }

  it('reads a real grounding limit, so the count check is not vacuous', () => {
    expect(groundingLimit()).toBeGreaterThan(0);
  });
});
