/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import { stripFrontmatter } from '../stripFrontmatter';

describe('stripFrontmatter', () => {
  it('strips a leading YAML frontmatter block', () => {
    const input = '---\nslug: x\ntitle: "T"\nmedia: []\n---\n\n# Body\n\nProse.\n';
    const result = stripFrontmatter(input);
    expect(result).toContain('# Body');
    expect(result).toContain('Prose.');
    expect(result).not.toContain('slug:');
    expect(result).not.toContain('title:');
    expect(result).not.toContain('media:');
    expect(result.startsWith('---')).toBe(false);
  });

  it('returns frontmatter-free input unchanged (exact equality)', () => {
    const input = '# Heading\n\nProse.\n';
    expect(stripFrontmatter(input)).toBe(input);
  });

  it('preserves a mid-body thematic break (--- not on line 1)', () => {
    const input = '# H\n\nBefore.\n\n---\n\nAfter.\n';
    const result = stripFrontmatter(input);
    expect(result).toContain('---');
    expect(result).toContain('Before.');
    expect(result).toContain('After.');
  });

  it('returns an unterminated frontmatter block unchanged (exact equality)', () => {
    const input = '---\nslug: x\nno close\n';
    expect(stripFrontmatter(input)).toBe(input);
  });

  it('does not treat a fence preceded by a blank line as frontmatter', () => {
    const input = '\n---\nslug: x\n---\n\n# Body\n';
    const result = stripFrontmatter(input);
    // The leading blank means the --- is NOT on line 1; input returned unchanged.
    expect(result).toBe(input);
  });

  it('tolerates a leading UTF-8 BOM before the opening fence', () => {
    const input = '﻿---\nslug: x\n---\n\n# Body\n';
    const result = stripFrontmatter(input);
    expect(result).not.toContain('slug:');
    expect(result).toContain('# Body');
  });
});
