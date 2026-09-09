/**
 * Joining a transcribed page onto the writing already on the entry. The rule is
 * deliberately conservative: the existing prose is never re-wrapped or
 * re-punctuated, only separated from the new page by one blank line, so what a
 * writer typed comes back verbatim.
 */
import { describe, expect, it } from '@jest/globals';

import { TRANSCRIPT_SEPARATOR, appendTranscript } from '../appendTranscript';

describe('appendTranscript', () => {
  // Spelled out rather than composed from TRANSCRIPT_SEPARATOR: an assertion
  // built from the constant it is checking would hold for any value of it.
  it('separates the transcript from existing prose with one blank line', () => {
    expect(appendTranscript('The river.', 'Then the bank.')).toBe('The river.\n\nThen the bank.');
  });

  it('exports that blank line as the separator the entry screen shares', () => {
    expect(TRANSCRIPT_SEPARATOR).toBe('\n\n');
  });

  it('opens a blank page with the transcript alone, with no leading blank line', () => {
    expect(appendTranscript('', 'Only the photographed page.')).toBe('Only the photographed page.');
  });

  it('treats a whitespace-only page as blank', () => {
    expect(appendTranscript('   \n\n ', 'Only the photographed page.')).toBe(
      'Only the photographed page.',
    );
  });

  it('collapses trailing whitespace so a half-finished line gains exactly one gap', () => {
    expect(appendTranscript('The river.\n\n\n', 'Then the bank.')).toBe(
      'The river.\n\nThen the bank.',
    );
  });

  it('preserves the existing prose verbatim, including its interior blank lines', () => {
    const body = 'One.\n\nTwo.';

    expect(appendTranscript(body, 'Three.')).toBe('One.\n\nTwo.\n\nThree.');
  });

  it('leaves the page untouched when the transcript is empty', () => {
    expect(appendTranscript('The river.', '   ')).toBe('The river.');
  });
});
