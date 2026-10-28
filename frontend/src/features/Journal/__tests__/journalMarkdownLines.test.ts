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
      headingLevel: null,
      ordinal: null,
      taskChecked: null,
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

describe('classifyLine -- headings', () => {
  it.each([1, 2, 3, 4, 5, 6])('reads a level-%i ATX heading past its marker and space', (level) => {
    const body = `${'#'.repeat(level)} Morning`;
    expect(classify(body)).toMatchObject({
      kind: 'heading',
      headingLevel: level,
      contentStart: level + 1,
      ordinal: null,
      taskChecked: null,
    });
  });

  it('accepts a tab separator and an indent before the marker', () => {
    expect(classify('  ##\tTuesday')).toMatchObject({
      kind: 'heading',
      headingLevel: 2,
      indentEnd: 2,
      contentStart: 5,
    });
  });

  it.each(['#tag', '####### seven', '#', '##', 'a # b'])('leaves %j as prose', (body) => {
    expect(classify(body)).toMatchObject({ kind: 'plain', headingLevel: null, contentStart: 0 });
  });

  it('keeps a heading out of the continuable marker set, so Return does not repeat it', () => {
    // Return behaviour is the editor sibling's issue (#3249); the classifier
    // must not hand the current editor a marker it would carry forward.
    expect(classify('## Tuesday')).toMatchObject({ marker: null, markerEnd: 0 });
  });
});

describe('classifyLine -- ordered items', () => {
  it.each([
    ['1. walked', 1, 3],
    ['3) third', 3, 3],
    ['10. tenth', 10, 4],
    ['007.\tbond', 7, 5],
  ])('reads %j with its ordinal as typed', (body, ordinal, contentStart) => {
    expect(classify(body)).toMatchObject({ kind: 'ordered', ordinal, contentStart });
  });

  it('allows an indent before the digits', () => {
    expect(classify('  2. nested')).toMatchObject({
      kind: 'ordered',
      ordinal: 2,
      indentEnd: 2,
      indentWidth: 2,
      contentStart: 5,
    });
  });

  it.each(['3.14 is pi', '1.', '1.x', '12 apples', '.5 alone', `${'9'.repeat(10)}. huge`])(
    'leaves %j as prose',
    (body) => {
      expect(classify(body)).toMatchObject({ kind: 'plain', ordinal: null, contentStart: 0 });
    },
  );

  it('keeps an ordered marker out of the continuable marker set', () => {
    expect(classify('1. walked')).toMatchObject({ marker: null, markerEnd: 0 });
  });
});

describe('classifyLine -- task items', () => {
  it.each([
    ['- [ ] book the room', false],
    ['- [x] called Sam', true],
    ['* [X] shouted', true],
    ['+ [ ] plus', false],
  ])('reads %j past its checkbox', (body, checked) => {
    expect(classify(body)).toMatchObject({
      kind: 'task',
      taskChecked: checked,
      contentStart: 6,
      marker: body[0],
      markerFollowedBy: 'space',
      markerEnd: 2,
    });
  });

  it('reads a checkbox that ends the line as an empty task', () => {
    expect(classify('- [ ]')).toMatchObject({ kind: 'task', taskChecked: false, contentStart: 5 });
  });

  it('nests with an indent like a bullet', () => {
    expect(classify('\t- [x] sub')).toMatchObject({
      kind: 'task',
      indentWidth: JOURNAL_TAB_COLUMNS,
      contentStart: 7,
    });
  });

  it.each(['- [y] maybe', '- [ ]glued', '- [] empty', '-\t[ ] tab', '[ ] bare'])(
    'does not read %j as a task',
    (body) => {
      const line = classify(body);
      expect(line.kind).not.toBe('task');
      expect(line.taskChecked).toBeNull();
    },
  );
});

describe('classifyLine -- horizontal rules', () => {
  it.each(['---', '***', '___', '-----', '  ***  ', '\t___'])('reads %j as a rule', (body) => {
    const line = classify(body);
    expect(line.kind).toBe('rule');
    // Every character of a rule is hidden in read mode: nothing is content.
    expect(line.contentStart).toBe(line.end);
  });

  it('never calls *** a * bullet', () => {
    expect(classify('***').kind).toBe('rule');
    expect(classify('***').kind).not.toBe('bullet');
  });

  it.each(['--', '-*-', '- - -', '---x', '* * *', '__init__'])(
    'does not read %j as a rule',
    (body) => {
      expect(classify(body).kind).not.toBe('rule');
    },
  );
});
