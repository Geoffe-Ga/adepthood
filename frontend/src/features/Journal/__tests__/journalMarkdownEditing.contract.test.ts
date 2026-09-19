/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import { parseJournalMarkdown } from '../journalMarkdown';
import { BULLET_MARKERS } from '../journalMarkdownLines';
import { continueMarkdownEdit } from '../markdownEditing';

/**
 * Read mode and edit mode must agree about what a bullet is.
 *
 * This loops the single exported marker set rather than listing markers by
 * hand, so adding a fourth marker to `BULLET_MARKERS` cannot leave one side
 * behind: the new marker is tested the moment it is declared.
 */
describe('bullet marker contract between the parser and the editor', () => {
  it('declares a non-empty marker set of single characters', () => {
    expect(BULLET_MARKERS.length).toBeGreaterThan(0);
    for (const marker of BULLET_MARKERS) expect(Array.from(marker)).toHaveLength(1);
  });

  it.each(['-', '*', '+'])('still names %j, which the editor has always continued', (marker) => {
    // The loops below are closed under ADDITIONS -- a fourth marker is tested
    // the moment it is declared. They cannot see a REMOVAL, because dropping a
    // marker simply runs one case fewer and stays green. This is that guard.
    expect(BULLET_MARKERS).toContain(marker);
  });

  it.each([...BULLET_MARKERS])('parses %j as a bullet and continues it on Return', (marker) => {
    const line = `${marker} a thought`;
    const document = parseJournalMarkdown(line);

    expect(document.blocks[0]!.kind).toBe('bullet');
    expect(document.blocks[0]!.lines[0]!.marker).toBe(marker);

    const caret = line.length;
    expect(continueMarkdownEdit(line, `${line}\n`, { start: caret, end: caret })).toEqual({
      text: `${line}\n${marker} `,
      selection: { start: caret + 3, end: caret + 3 },
    });
  });

  it.each([...BULLET_MARKERS])('exits an empty %j item on Return', (marker) => {
    const previous = `${marker} `;
    expect(continueMarkdownEdit(previous, `${previous}\n`, { start: 2, end: 2 })).toEqual({
      text: '',
      selection: { start: 0, end: 0 },
    });
  });
});
