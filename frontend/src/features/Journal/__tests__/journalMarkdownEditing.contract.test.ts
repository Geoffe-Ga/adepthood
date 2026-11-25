/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import { parseJournalMarkdown } from '../journalMarkdown';
import { BULLET_MARKERS } from '../journalMarkdownLines';
import { continueMarkdownEdit, deleteBackwardEdit } from '../markdownEditing';
import { listLevelAt, shiftListLines } from '../markdownIndent';
import { buildMirrorModel } from '../markdownMirror';

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

  it.each([...BULLET_MARKERS])(
    'steps an empty nested %j item out one level on Return',
    (marker) => {
      const previous = `${marker} a\n  ${marker} `;
      expect(
        continueMarkdownEdit(previous, `${previous}\n`, {
          start: previous.length,
          end: previous.length,
        }),
      ).toEqual({ text: `${marker} a\n${marker} `, selection: { start: 6, end: 6 } });
    },
  );

  it.each([...BULLET_MARKERS])('draws a %j item as a bullet in the live mirror', (marker) => {
    const [line] = buildMirrorModel(parseJournalMarkdown(`${marker} a`), { start: 0, end: 0 });
    expect(line!.kind).toBe('bullet');
    expect(line!.runs.map((run) => [run.text, run.role])).toEqual([
      [`${marker} `, 'marker'],
      ['a', 'content'],
    ]);
  });

  it.each([...BULLET_MARKERS])('exits an empty %j item on Return', (marker) => {
    const previous = `${marker} `;
    expect(continueMarkdownEdit(previous, `${previous}\n`, { start: 2, end: 2 })).toEqual({
      text: '',
      selection: { start: 0, end: 0 },
    });
  });
});

/** One list-item prefix per kind the dialect nests, and the prefix Return carries forward. */
const LIST_ITEM_PREFIXES: readonly (readonly [prefix: string, kind: string, next: string])[] = [
  ...BULLET_MARKERS.map((marker) => [`${marker} `, 'bullet', `${marker} `] as const),
  ...BULLET_MARKERS.map((marker) => [`${marker} [x] `, 'task', `${marker} [ ] `] as const),
  ['1. ', 'ordered', '2. '],
  ['1) ', 'ordered', '2) '],
];

/**
 * Every list kind the renderer draws is a list line to the editor: Return
 * continues it, Return on an empty one leaves it, and Tab, Shift+Tab and
 * Backspace nest it. Bullets, tasks and numbered items share one loop so a
 * kind cannot be continued but not nested, or the reverse.
 */
describe('list item contract between the parser and the editor', () => {
  it.each(LIST_ITEM_PREFIXES)('parses %j as a %s item and continues it on Return', (...row) => {
    const [prefix, kind, next] = row;
    const line = `${prefix}a thought`;
    expect(parseJournalMarkdown(line).blocks[0]!.kind).toBe(kind);
    const caret = line.length;
    const end = caret + 1 + next.length;
    expect(continueMarkdownEdit(line, `${line}\n`, { start: caret, end: caret })).toEqual({
      text: `${line}\n${next}`,
      selection: { start: end, end },
    });
  });

  it.each(LIST_ITEM_PREFIXES)('exits an empty %j item on Return', (prefix) => {
    const caret = prefix.length;
    expect(continueMarkdownEdit(prefix, `${prefix}\n`, { start: caret, end: caret })).toEqual({
      text: '',
      selection: { start: 0, end: 0 },
    });
  });

  it.each(LIST_ITEM_PREFIXES)('nests and un-nests a %j item', (prefix) => {
    const line = `${prefix}a`;
    const caret = { start: line.length, end: line.length };
    expect(listLevelAt(line, caret.start)).toBe(0);
    const nested = shiftListLines(line, caret, 'indent');
    expect(nested).toEqual({
      text: `  ${line}`,
      selection: { start: caret.start + 2, end: caret.end + 2 },
    });
    expect(shiftListLines(nested!.text, nested!.selection!, 'outdent')).toEqual({
      text: line,
      selection: caret,
    });
  });

  it.each(LIST_ITEM_PREFIXES)(
    'steps a nested %j item out on Backspace, then drops its prefix',
    (prefix) => {
      const nested = `  ${prefix}a`;
      const first = deleteBackwardEdit(nested, {
        start: 2 + prefix.length,
        end: 2 + prefix.length,
      });
      expect(first).toEqual({
        text: `${prefix}a`,
        selection: { start: prefix.length, end: prefix.length },
      });
      expect(deleteBackwardEdit(first!.text, first!.selection!)).toEqual({
        text: 'a',
        selection: { start: 0, end: 0 },
      });
    },
  );
});
