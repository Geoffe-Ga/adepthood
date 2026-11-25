/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import {
  HEADING_CYCLE_DEPTH,
  blockStyleState,
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

function toggle(marked: string, style: BlockStyle): string | null {
  const { body, selection } = at(marked);
  const edit = toggleBlockStyle(body, selection, style);
  return edit == null ? null : show(edit.text, edit.selection);
}

describe('toggleBlockStyle -- turning a line into a block', () => {
  it.each<[BlockStyle, string]>([
    ['bullet', '- wor|d'],
    ['ordered', '1. wor|d'],
    ['task', '- [ ] wor|d'],
    ['quote', '> wor|d'],
    ['heading', '# wor|d'],
  ])('makes the caret line a %s, keeping the caret on its word', (style, expected) => {
    expect(toggle('wor|d', style)).toBe(expected);
  });

  it('starts a block on an empty line with the caret after its marker', () => {
    expect(toggle('a\n|\nb', 'bullet')).toBe('a\n- |\nb');
    expect(toggle('|', 'quote')).toBe('> |');
  });

  it('turns every touched line of a range, skipping blank lines', () => {
    expect(toggle('|one\n\ntwo|\nthree', 'bullet')).toBe('|- one\n\n- two|\nthree');
  });

  it('numbers a range 1, 2, 3', () => {
    expect(toggle('|a\nb\nc|', 'ordered')).toBe('|1. a\n2. b\n3. c|');
  });

  it('continues the numbering of an item just above', () => {
    expect(toggle('1. a\n2. b\n|c', 'ordered')).toBe('1. a\n2. b\n3. |c');
  });

  it('swaps one block kind for another rather than stacking markers', () => {
    expect(toggle('- it|em', 'ordered')).toBe('1. it|em');
    expect(toggle('1. it|em', 'quote')).toBe('> it|em');
    expect(toggle('> it|em', 'heading')).toBe('# it|em');
    expect(toggle('## it|em', 'bullet')).toBe('- it|em');
  });

  it('keeps a nested list item at its depth when it changes list kind', () => {
    expect(toggle('- a\n  - |b', 'ordered')).toBe('- a\n  1. |b');
  });

  it('pulls a quote or heading flush, as the dialect only reads them there', () => {
    expect(toggle('  - |b', 'quote')).toBe('> |b');
    expect(toggle('  - |b', 'heading')).toBe('# |b');
  });

  it('leaves a horizontal rule alone', () => {
    expect(toggle('|---|', 'bullet')).toBeNull();
  });
});

describe('toggleBlockStyle -- turning a block back into prose', () => {
  it.each<[BlockStyle, string]>([
    ['bullet', '- wor|d'],
    ['ordered', '7. wor|d'],
    ['quote', '> wor|d'],
  ])('removes the %s marker when every touched line already has it', (style, marked) => {
    expect(toggle(marked, style)).toBe('wor|d');
  });

  it('removes a nested item’s indent with its marker', () => {
    expect(toggle('- a\n  - |b', 'bullet')).toBe('- a\n|b');
  });

  it('turns a task item into a plain bullet, dropping only its box', () => {
    expect(toggle('- [x] do|ne', 'bullet')).toBe('- do|ne');
    expect(toggle('  * [ ] do|ne', 'bullet')).toBe('  * do|ne');
  });

  it('applies to a mixed range rather than removing', () => {
    expect(toggle('|- a\nb|', 'bullet')).toBe('|- a\n- b|');
  });

  it('puts a caret inside a removed marker at the content start', () => {
    expect(toggle('-| a', 'bullet')).toBe('|a');
  });
});

describe('toggleBlockStyle -- checklists', () => {
  it.each([
    ['buy oa|ts', '- [ ] buy oa|ts'],
    ['- buy oa|ts', '- [ ] buy oa|ts'],
    ['2. buy oa|ts', '- [ ] buy oa|ts'],
    ['- [x] buy oa|ts', 'buy oa|ts'],
    ['- [ ] buy oa|ts', 'buy oa|ts'],
    ['> buy oa|ts', '- [ ] buy oa|ts'],
  ])('turns %j into %j', (marked, expected) => {
    expect(toggle(marked, 'task')).toBe(expected);
  });

  it('starts an unchecked box on an empty line with the caret after it', () => {
    expect(toggle('a\n|', 'task')).toBe('a\n- [ ] |');
  });

  it('keeps a list item at its depth, and a bullet on its own marker', () => {
    expect(toggle('- a\n  - |b', 'task')).toBe('- a\n  - [ ] |b');
    expect(toggle('1. a\n   1. |b', 'task')).toBe('1. a\n   - [ ] |b');
    expect(toggle('* |b', 'task')).toBe('* [ ] |b');
  });

  it('leaves no stray ordinals when a numbered run becomes tasks', () => {
    expect(toggle('|1. a\n2. b\n10. c|', 'task')).toBe('|- [ ] a\n- [ ] b\n- [ ] c|');
  });

  it('numbers tasks from 1. when they become a numbered list', () => {
    expect(toggle('|- [ ] a\n- [x] b\n- [ ] c|', 'ordered')).toBe('|1. a\n2. b\n3. c|');
  });

  it('clears a range of tasks, checked or not, without touching their words', () => {
    expect(toggle('|- [x] a\n  - [ ] b|', 'task')).toBe('|a\nb|');
  });

  it('leaves a checked item checked when a mixed range becomes a checklist', () => {
    expect(toggle('|- [x] a\nb\n- c|', 'task')).toBe('|- [x] a\n- [ ] b\n- [ ] c|');
  });

  it('puts a caret inside a replaced marker at the content start', () => {
    expect(toggle('1|. a', 'task')).toBe('- [ ] |a');
    expect(toggle('- [|x] a', 'task')).toBe('|a');
  });

  it('is one contiguous edit that an anchor below rides out on its own words', () => {
    const before = 'Morning\n1. buy oats\nThe willow leans.';
    const edit = toggleBlockStyle(before, { start: 14, end: 14 }, 'task');
    const after = edit!.text;
    expect(after).toBe('Morning\n- [ ] buy oats\nThe willow leans.');

    // Everything but the prefix is byte-identical, so the server's one-window
    // re-anchor moves an anchor after the line by the net change in length.
    const window = minimalReplacement(before, after);
    expect(before.slice(window.start, window.end)).toBe('1.');
    expect(window.text).toBe('- [ ]');
    const anchorStart = before.indexOf('willow');
    expect(anchorStart).toBeGreaterThanOrEqual(window.end);
    const shifted = anchorStart + window.text.length - (window.end - window.start);
    expect(after.slice(shifted, shifted + 'willow'.length)).toBe('willow');
  });
});

describe('toggleBlockStyle -- heading levels', () => {
  it('steps a heading one level deeper each press, then back to prose', () => {
    expect(toggle('# ti|tle', 'heading')).toBe('## ti|tle');
    expect(toggle('## ti|tle', 'heading')).toBe('### ti|tle');
    expect(toggle(`${'#'.repeat(HEADING_CYCLE_DEPTH)} ti|tle`, 'heading')).toBe('ti|tle');
  });

  it('turns a heading deeper than the cycle back into prose', () => {
    expect(toggle('##### ti|tle', 'heading')).toBe('ti|tle');
  });
});

describe('toggleBlockStyle -- Unicode', () => {
  it('works in code points, so an emoji before the caret does not skew it', () => {
    expect(toggle('😀 a|b', 'bullet')).toBe('- 😀 a|b');
    expect(toggle('- 😀 a|b', 'bullet')).toBe('😀 a|b');
  });
});

describe('blockStyleState', () => {
  function state(marked: string) {
    const { body, selection } = at(marked);
    return blockStyleState(body, selection);
  }

  it('is all off on prose', () => {
    expect(state('wo|rd')).toEqual({
      bullet: false,
      ordered: false,
      task: false,
      quote: false,
      heading: false,
    });
  });

  it.each<[string, BlockStyle]>([
    ['- a|', 'bullet'],
    ['- [ ] a|', 'task'],
    ['* [x] a|', 'task'],
    ['3) a|', 'ordered'],
    ['> a|', 'quote'],
    ['### a|', 'heading'],
  ])('reads %j as %s', (marked, style) => {
    expect(state(marked)[style]).toBe(true);
  });

  it('never reads a task as a bullet, or a bullet as a task', () => {
    expect(state('- [ ] a|')).toMatchObject({ bullet: false, task: true });
    expect(state('- a|')).toMatchObject({ bullet: true, task: false });
    expect(state('|- [ ] a\n- b|')).toMatchObject({ bullet: false, task: false });
  });

  it('is on for a range only when every non-blank touched line has the style', () => {
    expect(state('|- a\n\n- b|').bullet).toBe(true);
    expect(state('|- a\nb|').bullet).toBe(false);
  });
});
