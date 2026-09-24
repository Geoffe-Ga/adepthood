import { describe, expect, it } from '@jest/globals';

import { markdownRuns, parseJournalMarkdown, revealedDelimiters } from '../journalMarkdown';
import { buildMirrorModel, visibleMirrorRuns } from '../markdownMirror';

import { CORPUS } from './fixtures/journalMarkdownCorpus';

const NO_SELECTION = { start: 0, end: 0 };

describe('buildMirrorModel', () => {
  it.each(CORPUS)('styles exactly the runs read mode renders for %j', (body) => {
    const document = parseJournalMarkdown(body);
    const lines = buildMirrorModel(document, NO_SELECTION);
    for (const line of lines) {
      expect(visibleMirrorRuns(line)).toEqual(markdownRuns(document, line.start, line.end));
    }
  });

  it.each(CORPUS)('keeps every source character of %j, in order, on its own line', (body) => {
    const lines = buildMirrorModel(parseJournalMarkdown(body), NO_SELECTION);
    expect(lines.map((line) => line.runs.map((run) => run.text).join('')).join('\n')).toBe(body);
    for (const line of lines) {
      expect(line.runs.map((run) => run.text).join('')).toBe(
        Array.from(body).slice(line.start, line.end).join(''),
      );
    }
  });

  it('separates an indent, a marker, emphasis delimiters and content', () => {
    const [line] = buildMirrorModel(parseJournalMarkdown('  - **a**'), NO_SELECTION);
    expect(line!.runs.map((run) => [run.text, run.role])).toEqual([
      ['  ', 'indent'],
      ['- ', 'marker'],
      ['**', 'delimiter'],
      ['a', 'content'],
      ['**', 'delimiter'],
    ]);
    expect(line).toMatchObject({ kind: 'bullet', indentWidth: 2 });
  });

  it('dims a quote marker as a marker, never as content', () => {
    const [line] = buildMirrorModel(parseJournalMarkdown('> said'), NO_SELECTION);
    expect(line!.runs.map((run) => [run.text, run.role])).toEqual([
      ['> ', 'marker'],
      ['said', 'content'],
    ]);
    expect(line!.kind).toBe('quote');
  });

  it.each([
    ['a caret inside the span', { start: 5, end: 5 }],
    ['a caret outside it', { start: 0, end: 0 }],
    ['a selection across it', { start: 0, end: 9 }],
  ])('reveals exactly the delimiters revealedDelimiters names for %s', (_label, selection) => {
    const body = 'a **bold** <u>u</u>';
    const document = parseJournalMarkdown(body);
    const revealed = revealedDelimiters(document, selection);
    const flagged = buildMirrorModel(document, selection)
      .flatMap((line) => line.runs)
      .filter((run) => run.revealed)
      .map((run) => ({ start: run.start, end: run.end }));
    expect(flagged).toEqual(revealed);
  });

  it('never reveals content or a block marker', () => {
    const document = parseJournalMarkdown('- **a**');
    const runs = buildMirrorModel(document, { start: 0, end: 7 }).flatMap((line) => line.runs);
    expect(runs.filter((run) => run.revealed).every((run) => run.role === 'delimiter')).toBe(true);
  });
});
