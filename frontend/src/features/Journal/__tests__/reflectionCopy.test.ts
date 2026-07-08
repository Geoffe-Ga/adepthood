// RED: `reflectionCopy` does not exist yet -- these imports fail until the
// implementation-specialist adds `reflectionTitle` and `formatBlockquote`.
import { describe, it, expect } from '@jest/globals';

import { reflectionTitle, formatBlockquote } from '../reflectionCopy';

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

  it('falls back to a formatted date attribution when no title is given', () => {
    const block = formatBlockquote('went for a daily walk', 'Jun 1, 2026');
    expect(block).toContain('Jun 1, 2026');
  });
});
