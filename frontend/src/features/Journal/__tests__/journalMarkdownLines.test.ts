/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import {
  BULLET_MARKERS,
  JOURNAL_TAB_COLUMNS,
  classifyLine,
  sourceLines,
} from '../journalMarkdownLines';
import type { JournalMarkdownLine } from '../journalMarkdownTypes';

/** Classify the single line of a one-line body. */
function classify(body: string): JournalMarkdownLine {
  const chars = Array.from(body);
  const [line] = sourceLines(chars);
  return classifyLine(chars, line!);
}

describe('classifyLine', () => {
  it('reads a flush bullet with its marker, separator, and content start', () => {
    expect(classify('- one')).toEqual({
      start: 0,
      end: 5,
      kind: 'bullet',
      marker: '-',
      markerFollowedBy: 'space',
      markerEnd: 2,
      contentStart: 2,
      indentEnd: 0,
      indentWidth: 0,
    });
  });

  it('measures a space indent in columns and keeps its source range', () => {
    const line = classify('  - nested');
    expect(line.kind).toBe('bullet');
    expect(line.indentEnd).toBe(2);
    expect(line.indentWidth).toBe(2);
    expect(line.contentStart).toBe(4);
  });

  it('counts a tab indent as JOURNAL_TAB_COLUMNS columns', () => {
    const line = classify('\t- tabbed');
    expect(line.kind).toBe('bullet');
    expect(line.indentEnd).toBe(1);
    expect(line.indentWidth).toBe(JOURNAL_TAB_COLUMNS);
    expect(line.contentStart).toBe(3);
  });

  it.each(['* star', '+ plus', '- dash'])('classifies %j as a bullet', (body) => {
    const line = classify(body);
    expect(line.kind).toBe('bullet');
    expect(BULLET_MARKERS).toContain(line.marker);
  });

  it('reports a tab separator without making the line a rendered bullet', () => {
    // The renderer honours a literal space only, exactly as it does for `>`.
    // The editor uses markerFollowedBy, so `-\tfoo` still continues on Return.
    const line = classify('-\tfoo');
    expect(line.kind).toBe('plain');
    expect(line.marker).toBe('-');
    expect(line.markerFollowedBy).toBe('tab');
    expect(line.markerEnd).toBe(2);
    expect(line.contentStart).toBe(0);
  });

  it('treats a marker with no separator as prose', () => {
    const line = classify('-no-space');
    expect(line.kind).toBe('plain');
    expect(line.markerFollowedBy).toBe('none');
    expect(line.contentStart).toBe(0);
  });

  it('classifies a quote line exactly as the renderer did before bullets', () => {
    expect(classify('> quoted')).toMatchObject({
      kind: 'quote',
      marker: '>',
      markerFollowedBy: 'space',
      contentStart: 2,
    });
  });

  it('keeps a bare > a quote whose content is empty', () => {
    expect(classify('>')).toMatchObject({
      kind: 'quote',
      marker: '>',
      markerFollowedBy: 'eol',
      contentStart: 1,
      end: 1,
    });
  });

  it.each(['>\tfoo', '>text', '  > indented'])(
    'leaves %j as prose, as it renders today',
    (body) => {
      expect(classify(body).kind).toBe('plain');
    },
  );

  it('does not mistake the underline delimiter for a bullet', () => {
    expect(classify('<u>x</u>')).toMatchObject({ kind: 'plain', marker: null });
  });

  it('does not continue an exotic whitespace separator', () => {
    expect(classify('- foo').markerFollowedBy).toBe('none');
  });
});
