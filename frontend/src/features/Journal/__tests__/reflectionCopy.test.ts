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
  it('titles a week reflection from its week-number scope key', () => {
    expect(reflectionTitle('week', 'c1:w14')).toBe('Week 14 Reflection');
  });

  it('titles a stage reflection with the stage title appended', () => {
    const title = reflectionTitle('stage', 'c1:s1', 'Survival');
    expect(title).toContain('Stage Reflection');
    expect(title).toContain('Survival');
  });

  it('still returns a usable stage title with no stageTitle supplied', () => {
    const title = reflectionTitle('stage', 'c1:s1');
    expect(title).toContain('Stage Reflection');
  });

  it('titles a component reflection', () => {
    expect(reflectionTitle('component', 'c1:p2')).toBe('Component Reflection');
  });

  it('titles a tier reflection', () => {
    expect(reflectionTitle('tier', 'c1:t1')).toBe('Tier Reflection');
  });

  it('titles a program reflection', () => {
    expect(reflectionTitle('program', 'c1:prog')).toBe('Program Reflection');
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
