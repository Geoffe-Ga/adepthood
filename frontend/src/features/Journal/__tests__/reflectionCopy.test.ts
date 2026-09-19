import { describe, it, expect } from '@jest/globals';

import {
  reflectionTitle,
  formatBlockquote,
  formatQuotePrefill,
  sourceAttribution,
} from '../reflectionCopy';

import type { ReflectionSourceItem } from '@/api';

function sourceItem(overrides: Partial<ReflectionSourceItem> = {}): ReflectionSourceItem {
  return {
    kind: 'entry',
    id: 1,
    title: null,
    timestamp: '2026-06-15T12:00:00Z',
    body: 'went for a daily walk',
    reflection_level: null,
    promoted_quotes: [],
    ...overrides,
  };
}

describe('reflectionTitle', () => {
  it('titles a weekly review from its week-number scope key', () => {
    expect(reflectionTitle('week', 'c1:w14')).toBe('Weekly Review — Week 14');
  });

  it('falls back to a bare weekly label when the key is not the w<n> shape', () => {
    expect(reflectionTitle('week', 'c1:course')).toBe('Weekly Review');
  });

  it('titles a stage review with the stage title appended', () => {
    expect(reflectionTitle('stage', 'c1:s1', 'Survival')).toBe('Stage Review — Survival');
  });

  it('still returns a usable stage title with no stageTitle supplied', () => {
    expect(reflectionTitle('stage', 'c1:s1')).toBe('Stage Review');
  });

  // The colour is derived from STAGE_ORDER at the section's closing stage
  // (3n), so these three cases also pin that the derivation walks the
  // curriculum rather than a hand-written list of three names.
  it('names section one after the Wavelength turn it closes', () => {
    expect(reflectionTitle('section', 'c1:x1')).toBe('Section Review — Red');
  });

  it('names section two after the Wavelength turn it closes', () => {
    expect(reflectionTitle('section', 'c1:x2')).toBe('Section Review — Green');
  });

  it('names section three after the Wavelength turn it closes', () => {
    expect(reflectionTitle('section', 'c1:x3')).toBe('Section Review — Ultraviolet');
  });

  it('falls back to a bare section label for a section the curriculum has no stage for', () => {
    expect(reflectionTitle('section', 'c1:x9')).toBe('Section Review');
  });

  it('falls back to a bare section label when the key is not the x<n> shape', () => {
    expect(reflectionTitle('section', 'c1:course')).toBe('Section Review');
  });

  it('titles the whole-course review', () => {
    expect(reflectionTitle('course', 'c1:course')).toBe('Course Review');
  });
});

describe('formatBlockquote', () => {
  it('opens on a fresh line with a blockquote marker before the anchor text', () => {
    const block = formatBlockquote('went for a daily walk', 'Runs');
    expect(block.startsWith('\n>')).toBe(true);
    expect(block).toContain('> went for a daily walk');
  });

  it('includes the attribution on its own quoted line', () => {
    const block = formatBlockquote('went for a daily walk', 'Runs');
    expect(block).toContain('Runs');
  });

  it('closes with a blank line so the inserted quote never runs into surrounding prose', () => {
    const block = formatBlockquote('went for a daily walk', 'Runs');
    expect(block.endsWith('\n\n')).toBe(true);
  });
});

describe('formatQuotePrefill', () => {
  it('formats a single-line passage as an exact blockquote prefill', () => {
    const prefill = formatQuotePrefill(
      'To open your heart not just to yourself, but to others.',
      'The Mood of Blue',
    );
    expect(prefill).toBe(
      '> To open your heart not just to yourself, but to others.\n> — The Mood of Blue\n\n',
    );
  });

  it('prefixes every line of a multi-line passage with its own marker', () => {
    const prefill = formatQuotePrefill('line one\nline two', 'Src');
    expect(prefill).toBe('> line one\n> line two\n> — Src\n\n');
  });

  it('includes the attribution on its own quoted line', () => {
    const prefill = formatQuotePrefill('a passage', 'The Mood of Blue');
    expect(prefill).toContain('> — The Mood of Blue');
  });

  it('ends with a trailing blank line', () => {
    const prefill = formatQuotePrefill('a passage', 'Src');
    expect(prefill.endsWith('\n\n')).toBe(true);
  });

  it('does not open with a leading newline', () => {
    const prefill = formatQuotePrefill('a passage', 'Src');
    expect(prefill.startsWith('\n')).toBe(false);
  });
});

describe('sourceAttribution', () => {
  it('uses the source title when one is present', () => {
    expect(sourceAttribution(sourceItem({ title: 'Morning Pages' }))).toBe('Morning Pages');
  });

  it('falls back to a formatted date attribution when no title is given', () => {
    const attribution = sourceAttribution(sourceItem({ title: null }));
    expect(attribution).toContain('Jun');
    expect(attribution).toContain('2026');
  });

  it('treats a whitespace-only title as no title and falls back to the date', () => {
    const attribution = sourceAttribution(sourceItem({ title: '   ' }));
    expect(attribution).toContain('Jun');
    expect(attribution).toContain('2026');
  });
});
