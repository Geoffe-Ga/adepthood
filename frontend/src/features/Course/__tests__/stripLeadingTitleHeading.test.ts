/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import { stripLeadingTitleHeading } from '../stripLeadingTitleHeading';

describe('stripLeadingTitleHeading', () => {
  it('strips a leading H1 that exactly matches the title', () => {
    const input = '# Title\n\nProse.\n';
    expect(stripLeadingTitleHeading(input, 'Title')).toBe('Prose.\n');
  });

  it('consumes the single blank line after the stripped heading', () => {
    const input = '# Title\n\nProse.\n';
    const result = stripLeadingTitleHeading(input, 'Title');
    expect(result.startsWith('\n')).toBe(false);
  });

  it('preserves a differing heading unchanged (exact equality)', () => {
    const input = '# Other\n\nProse.\n';
    expect(stripLeadingTitleHeading(input, 'Title')).toBe(input);
  });

  it('returns whitespace-only input unchanged (exact equality)', () => {
    const input = '\n   \n\t\n';
    expect(stripLeadingTitleHeading(input, 'Title')).toBe(input);
  });

  it('preserves a body starting with an H2 unchanged (exact equality)', () => {
    const input = '## Sub\n\nProse.\n';
    expect(stripLeadingTitleHeading(input, 'Title')).toBe(input);
  });

  it('preserves a body starting with bare prose unchanged (exact equality)', () => {
    const input = 'Just prose, no heading.\n';
    expect(stripLeadingTitleHeading(input, 'Title')).toBe(input);
  });

  it('skips leading blank lines to find and strip the matching H1', () => {
    const input = '\n\n# Title\n\nProse.\n';
    expect(stripLeadingTitleHeading(input, 'Title')).toBe('Prose.\n');
  });

  it('removes only the heading line when no blank line follows', () => {
    const input = '# Title\nProse.\n';
    expect(stripLeadingTitleHeading(input, 'Title')).toBe('Prose.\n');
  });

  it('trims whitespace when comparing heading text to the title', () => {
    const input = '# Title \n\nProse.\n';
    expect(stripLeadingTitleHeading(input, 'Title')).toBe('Prose.\n');
  });
});
