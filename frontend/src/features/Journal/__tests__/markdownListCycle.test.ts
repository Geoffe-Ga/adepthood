/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import {
  LIST_CYCLE,
  blockStyleState,
  cycleListStyle,
  listKindAt,
  nextListKind,
  toggleBlockStyle,
  type BlockStyle,
} from '../markdownBlockToggle';
import { minimalReplacement } from '../markdownEditing';

/** A caret (or range) written into the text as ``|`` markers. */
function at(marked: string): { body: string; selection: { start: number; end: number } } {
  const first = marked.indexOf('|');
  const second = marked.indexOf('|', first + 1);
  const body = marked.replaceAll('|', '');
  if (second === -1) return { body, selection: { start: first, end: first } };
  return { body, selection: { start: first, end: second - 1 } };
}

/** Render an edit back with its selection as ``|`` markers. */
function show(text: string, selection?: { start: number; end: number }): string {
  if (selection == null) return text;
  const { start, end } = selection;
  if (start === end) return `${text.slice(0, start)}|${text.slice(start)}`;
  return `${text.slice(0, start)}|${text.slice(start, end)}|${text.slice(end)}`;
}

function cycle(marked: string): string | null {
  const { body, selection } = at(marked);
  const edit = cycleListStyle(body, selection);
  return edit == null ? null : show(edit.text, edit.selection);
}

function toggle(marked: string, style: BlockStyle): string | null {
  const { body, selection } = at(marked);
  const edit = toggleBlockStyle(body, selection, style);
  return edit == null ? null : show(edit.text, edit.selection);
}

/** Press the List control ``times`` times, feeding each result to the next press. */
function cycleTimes(marked: string, times: number): string[] {
  const seen: string[] = [];
  let current = marked;
  for (let press = 0; press < times; press += 1) {
    const next = cycle(current);
    if (next == null) throw new Error(`press ${String(press + 1)} changed nothing`);
    seen.push(next);
    current = next;
  }
  return seen;
}

describe('cycleListStyle -- one line (#3826)', () => {
  it('steps prose to a bullet, a number, a checkbox and back to prose', () => {
    expect(cycleTimes('buy o|ats', 4)).toEqual([
      '- buy o|ats',
      '1. buy o|ats',
      '- [ ] buy o|ats',
      'buy o|ats',
    ]);
  });

  it('names the order once, and the step after the last is prose', () => {
    expect(LIST_CYCLE).toEqual(['bullet', 'ordered', 'task']);
    expect(nextListKind(null)).toBe('bullet');
    expect(nextListKind('bullet')).toBe('ordered');
    expect(nextListKind('ordered')).toBe('task');
    expect(nextListKind('task')).toBeNull();
  });

  it('starts a bullet on an empty line with the caret after its marker', () => {
    expect(cycle('a\n|\nb')).toBe('a\n- |\nb');
  });

  it('keeps a nested item at its depth through every list kind, and flush as prose', () => {
    expect(cycleTimes('- a\n  - nest|ed', 3)).toEqual([
      '- a\n  1. nest|ed',
      '- a\n  - [ ] nest|ed',
      '- a\nnest|ed',
    ]);
  });

  it('writes the checkbox after a number with the default bullet', () => {
    expect(cycleTimes('* on|e', 2)).toEqual(['1. on|e', '- [ ] on|e']);
  });

  it('takes a checked box off whole when the task leaves the cycle', () => {
    expect(cycle('- [x] rest|')).toBe('rest|');
  });

  it('numbers on from a numbered item just above', () => {
    expect(cycle('1. a\n2. b\n- c|')).toBe('1. a\n2. b\n3. c|');
  });

  it('replaces a quote or heading marker with a bullet rather than stacking', () => {
    expect(cycle('> sa|id')).toBe('- sa|id');
    expect(cycle('## Da|y')).toBe('- Da|y');
  });

  it('leaves a horizontal rule alone', () => {
    expect(cycle('--|-')).toBeNull();
  });

  it('never deletes a character of the item’s words', () => {
    let body = 'buy **oats** and 2. tea';
    for (let press = 0; press < 8; press += 1) {
      const edit = cycleListStyle(body, { start: body.length, end: body.length });
      body = edit!.text;
      expect(body.endsWith('buy **oats** and 2. tea')).toBe(true);
    }
    expect(body).toBe('buy **oats** and 2. tea');
  });

  it('is one contiguous replacement, so an anchor below rides it out', () => {
    const before = '- buy oats\nlater words';
    const edit = cycleListStyle(before, { start: 4, end: 4 })!;
    expect(edit.text).toBe('1. buy oats\nlater words');
    const window = minimalReplacement(before, edit.text);
    expect(before.slice(window.start, window.end)).toBe('-');
    expect(window.text).toBe('1.');
    expect(before.indexOf('later')).toBeGreaterThanOrEqual(window.end);
  });
});

describe('cycleListStyle -- a range', () => {
  it('steps every touched line together, numbering a run from 1', () => {
    expect(cycleTimes('|a\nb\nc|', 4)).toEqual([
      '|- a\n- b\n- c|',
      '|1. a\n2. b\n3. c|',
      '|- [ ] a\n- [ ] b\n- [ ] c|',
      '|a\nb\nc|',
    ]);
  });

  it('brings a mixed range to the first line’s next step, then cycles it together', () => {
    // The first line is a bullet, so everything becomes a number.
    expect(cycleTimes('|- a\nb\n- [ ] c|', 2)).toEqual([
      '|1. a\n2. b\n3. c|',
      '|- [ ] a\n- [ ] b\n- [ ] c|',
    ]);
    // The first line is prose, so everything becomes a bullet.
    expect(cycle('|a\n1. b|')).toBe('|- a\n- b|');
  });

  it('leaves a checked item checked while the range becomes tasks, and clears it on the way out', () => {
    expect(cycleTimes('|1. a\n- [x] b|', 2)).toEqual(['|- [ ] a\n- [x] b|', '|a\nb|']);
  });

  it('skips blank lines inside the range', () => {
    expect(cycle('|one\n\ntwo|')).toBe('|- one\n\n- two|');
  });

  it('clears only list items when the cycle ends: a quote in the range is not a list', () => {
    expect(cycle('|- [ ] a\n> said|')).toBe('|a\n> said|');
  });
});

describe('cycleListStyle -- an item and its continuation lines (#3800)', () => {
  it('carries the continuation line through every kind, under the new marker’s text', () => {
    expect(cycleTimes('- a|\n  b', 4)).toEqual([
      '1. a|\n   b',
      '- [ ] a|\n      b',
      'a|\nb',
      // Prose again: the second line is a line of its own now, and stays one.
      '- a|\nb',
    ]);
  });

  it('acts on the item when the caret is on its continuation line', () => {
    expect(cycle('- a\n  b|')).toBe('1. a\n   b|');
    expect(cycle('1. a\n   b|\n2. c')).toBe('- [ ] a\n      b|\n2. c');
    expect(cycle('- [ ] a\n      b|')).toBe('a\nb|');
  });

  it('puts a caret inside a continuation line’s indent at its new text start', () => {
    expect(cycle('- a\n | b')).toBe('1. a\n   |b');
  });

  it('moves every continuation line of the item, and none of the next item’s', () => {
    expect(cycle('- a|\n  b\n  c\n- d\n  e')).toBe('1. a|\n   b\n   c\n- d\n  e');
  });

  it('re-indents under a two-digit number by its four characters', () => {
    const nine = Array.from({ length: 9 }, (_, index) => `${String(index + 1)}. x`).join('\n');
    expect(cycle(`${nine}\n- a|\n  b`)).toBe(`${nine}\n10. a|\n    b`);
  });

  it('keeps a nested item’s own indent in front of its continuation lines', () => {
    expect(cycleTimes('- p\n  - a|\n    b', 3)).toEqual([
      '- p\n  1. a|\n     b',
      '- p\n  - [ ] a|\n        b',
      '- p\na|\nb',
    ]);
  });

  it('keeps what a continuation line is indented beyond its item’s text column', () => {
    expect(cycle('- a|\n    b')).toBe('1. a|\n     b');
    expect(cycle('- [ ] a|\n        b')).toBe('a|\n  b');
  });

  it('counts a range that touches only a continuation line as touching its item', () => {
    expect(cycle('- a\n  |b|\n- c')).toBe('1. a\n   |b|\n- c');
  });

  it('counts on from a numbered item whose last line is a continuation line', () => {
    expect(cycle('1. a\n   b\n- c|')).toBe('1. a\n   b\n2. c|');
  });
});

describe('toggleBlockStyle -- an item and its continuation lines (#3800)', () => {
  it('no longer turns a continuation line into a nested item', () => {
    expect(toggle('- a\n  b|', 'ordered')).toBe('1. a\n   b|');
    expect(toggle('1. a\n   b|', 'task')).toBe('- [ ] a\n      b|');
  });

  it('leaves no indented prose behind when an item is un-listed', () => {
    expect(toggle('- a|\n  b', 'bullet')).toBe('a|\nb');
    expect(toggle('- [x] a\n      b|', 'task')).toBe('a\nb|');
  });

  it('pulls continuation lines flush when their item becomes a quote or heading', () => {
    expect(toggle('- a|\n  b', 'quote')).toBe('> a|\nb');
    expect(toggle('1. a|\n   b', 'heading')).toBe('# a|\nb');
  });

  it('re-indents when a task loses only its box', () => {
    expect(toggle('- [ ] a|\n      b', 'bullet')).toBe('- a|\n  b');
  });

  it('leaves a task and its continuation lines alone when a mixed range becomes a checklist', () => {
    expect(toggle('|- [x] a\n      b\n- c\n  d|', 'task')).toBe(
      '|- [x] a\n      b\n- [ ] c\n      d|',
    );
  });
});

describe('listKindAt and blockStyleState with continuation lines', () => {
  it.each([
    ['prose', 'wor|d', null],
    ['a bullet', '- wor|d', 'bullet'],
    ['a number', '1. wor|d', 'ordered'],
    ['a checkbox', '- [x] wor|d', 'task'],
    ['a quote', '> wor|d', null],
    ['a rule', '--|-', null],
    ['a continuation line', '1. a\n   wor|d', 'ordered'],
  ])('reads %s', (_name, marked, kind) => {
    const { body, selection } = at(marked);
    expect(listKindAt(body, selection)).toBe(kind);
  });

  it('reads a range by the first line it touches: the line the next press steps from', () => {
    const { body, selection } = at('|- a\n1. b|');
    expect(listKindAt(body, selection)).toBe('bullet');
  });

  it('reads the item’s style from a caret on its continuation line', () => {
    const { body, selection } = at('- [ ] a\n      b|');
    expect(blockStyleState(body, selection)).toMatchObject({ task: true, bullet: false });
  });
});
