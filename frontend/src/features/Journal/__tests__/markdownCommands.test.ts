import { describe, expect, it } from '@jest/globals';

import {
  IME_COMPOSITION_KEYCODE,
  applyMarkdownCommand,
  keyCommand,
  markdownCommandState,
  type MarkdownCommand,
  type MarkdownKeyEvent,
  type PrimaryModifier,
} from '../markdownCommands';

describe('keyCommand -- formatting shortcuts', () => {
  const SHORTCUTS: [key: string, command: MarkdownCommand][] = [
    ['b', 'bold'],
    ['i', 'italic'],
    ['u', 'underline'],
    ['B', 'bold'],
  ];
  it.each(SHORTCUTS)('maps the primary modifier plus %j to %s', (key, command) => {
    expect(keyCommand({ key, metaKey: true }, 'meta')).toBe(command);
    expect(keyCommand({ key, ctrlKey: true }, 'ctrl')).toBe(command);
  });

  const CROSSED: [primary: PrimaryModifier, event: MarkdownKeyEvent][] = [
    ['meta', { key: 'b', ctrlKey: true }],
    ['ctrl', { key: 'b', metaKey: true }],
  ];
  it.each(CROSSED)(
    'leaves the other modifier alone when the primary is %s (macOS Ctrl+B moves the caret)',
    (primary, event) => {
      expect(keyCommand(event, primary)).toBeNull();
    },
  );

  it.each([
    ['both modifiers', { key: 'b', metaKey: true, ctrlKey: true }],
    ['Alt', { key: 'b', metaKey: true, altKey: true }],
    ['Shift', { key: 'b', metaKey: true, shiftKey: true }],
    ['no modifier', { key: 'b' }],
    ['an unmapped key', { key: 'k', metaKey: true }],
  ])('ignores %s', (_label, event) => {
    expect(keyCommand(event, 'meta')).toBeNull();
  });

  it.each<[string, MarkdownKeyEvent]>([
    ['the physical 9 key (US Shift+9 reports "(")', { key: '(', code: 'Digit9' }],
    ['the physical 9 key on a layout that reports ")"', { key: ')', code: 'Digit9' }],
    ['a bare "9" with no code', { key: '9' }],
    ['a bare "(" with no code', { key: '(' }],
  ])('maps the primary modifier plus Shift and %s to the checklist', (_label, keys) => {
    expect(keyCommand({ ...keys, metaKey: true, shiftKey: true }, 'meta')).toBe('task');
    expect(keyCommand({ ...keys, ctrlKey: true, shiftKey: true }, 'ctrl')).toBe('task');
  });

  it.each<[string, MarkdownKeyEvent, MarkdownCommand]>([
    ['the physical 8 key (US Shift+8 reports "*")', { key: '*', code: 'Digit8' }, 'bullet'],
    ['the physical 8 key on a layout that reports "("', { key: '(', code: 'Digit8' }, 'bullet'],
    ['a bare "8" with no code', { key: '8' }, 'bullet'],
    ['a bare "*" with no code', { key: '*' }, 'bullet'],
    ['the physical 7 key (US Shift+7 reports "&")', { key: '&', code: 'Digit7' }, 'ordered'],
    ['the physical 7 key on a layout that reports "/"', { key: '/', code: 'Digit7' }, 'ordered'],
    ['a bare "7" with no code', { key: '7' }, 'ordered'],
    ['a bare "&" with no code', { key: '&' }, 'ordered'],
  ])(
    'maps the primary modifier plus Shift and %s straight to its list kind (#3826)',
    (_label, keys, command) => {
      expect(keyCommand({ ...keys, metaKey: true, shiftKey: true }, 'meta')).toBe(command);
      expect(keyCommand({ ...keys, ctrlKey: true, shiftKey: true }, 'ctrl')).toBe(command);
    },
  );

  it('never maps a key to the cycling List command: the keyboard names a kind directly', () => {
    for (const code of ['Digit7', 'Digit8', 'Digit9']) {
      expect(keyCommand({ key: code, code, metaKey: true, shiftKey: true }, 'meta')).not.toBe(
        'list',
      );
    }
  });

  it.each<[string, MarkdownKeyEvent]>([
    ['without Shift', { key: '9', code: 'Digit9', metaKey: true }],
    ['without the primary modifier', { key: '(', code: 'Digit9', shiftKey: true }],
    ['with Alt', { key: '(', code: 'Digit9', metaKey: true, shiftKey: true, altKey: true }],
    [
      'with both modifiers',
      { key: '(', code: 'Digit9', metaKey: true, ctrlKey: true, shiftKey: true },
    ],
    [
      'on another physical key that reports "("',
      { key: '(', code: 'Digit0', metaKey: true, shiftKey: true },
    ],
    ['on Shift+6', { key: '^', code: 'Digit6', metaKey: true, shiftKey: true }],
    ['on a bare "6" with no code', { key: '6', metaKey: true, shiftKey: true }],
    ['on Shift+7 without the primary modifier', { key: '&', code: 'Digit7', shiftKey: true }],
    ['on 8 without Shift', { key: '8', code: 'Digit8', metaKey: true }],
    ['on Shift+I', { key: 'I', code: 'KeyI', metaKey: true, shiftKey: true }],
    ['on Shift+U by physical key', { key: 'г', code: 'KeyU', metaKey: true, shiftKey: true }],
  ])('leaves the checklist chord alone %s', (_label, event) => {
    expect(keyCommand(event, 'meta')).toBeNull();
  });

  it('ignores every key while an IME composition is active', () => {
    expect(
      keyCommand(
        { key: '(', code: 'Digit9', metaKey: true, shiftKey: true, isComposing: true },
        'meta',
      ),
    ).toBeNull();
    expect(keyCommand({ key: 'b', metaKey: true, isComposing: true }, 'meta')).toBeNull();
    expect(
      keyCommand({ key: 'b', metaKey: true, keyCode: IME_COMPOSITION_KEYCODE }, 'meta'),
    ).toBeNull();
    expect(IME_COMPOSITION_KEYCODE).toBe(229);
  });
});

describe('applyMarkdownCommand -- inline styles', () => {
  it('returns the wrap as an edit', () => {
    expect(applyMarkdownCommand('a word', { start: 2, end: 6 }, 'bold')).toEqual({
      kind: 'edit',
      edit: { text: 'a **word**', selection: { start: 4, end: 8 } },
    });
  });

  it('consumes a toggle the dialect cannot express, so the browser does not act instead', () => {
    // Cmd+I would otherwise fall through to nothing useful; Cmd+B / Cmd+U to
    // the browser's own bookmark / view-source shortcuts.
    expect(applyMarkdownCommand('forward', { start: 3, end: 3 }, 'italic')).toEqual({
      kind: 'consumed',
    });
  });
});

describe('applyMarkdownCommand -- line styles', () => {
  it.each<[MarkdownCommand, string]>([
    ['bullet', '- note'],
    ['ordered', '1. note'],
    ['task', '- [ ] note'],
    ['quote', '> note'],
    ['heading', '# note'],
  ])('turns the caret line into a %s', (command, text) => {
    const result = applyMarkdownCommand('note', { start: 2, end: 2 }, command);
    expect(result).toMatchObject({ kind: 'edit', edit: { text } });
  });

  it('consumes a press with nothing to style, such as on a rule', () => {
    expect(applyMarkdownCommand('---', { start: 1, end: 1 }, 'bullet')).toEqual({
      kind: 'consumed',
    });
  });

  it('steps the caret line along the list cycle on the List command (#3826)', () => {
    const presses: string[] = [];
    let body = 'note';
    for (let press = 0; press < 4; press += 1) {
      const result = applyMarkdownCommand(body, { start: body.length, end: body.length }, 'list');
      if (result.kind !== 'edit') throw new Error('the List command did not edit');
      body = result.edit.text;
      presses.push(body);
    }
    expect(presses).toEqual(['- note', '1. note', '- [ ] note', 'note']);
  });

  it('consumes a List press with nothing to step, such as on a rule', () => {
    expect(applyMarkdownCommand('---', { start: 1, end: 1 }, 'list')).toEqual({
      kind: 'consumed',
    });
  });

  it('reports the list kind the List control steps from', () => {
    expect(markdownCommandState('note', { start: 1, end: 1 }).list).toBeNull();
    expect(markdownCommandState('- note', { start: 3, end: 3 }).list).toBe('bullet');
    expect(markdownCommandState('1. note', { start: 3, end: 3 }).list).toBe('ordered');
    expect(markdownCommandState('- [x] note', { start: 7, end: 7 }).list).toBe('task');
    expect(markdownCommandState('1. a\n   more', { start: 9, end: 9 })).toMatchObject({
      list: 'ordered',
      ordered: true,
      listLevel: 0,
    });
  });

  it('reports the line styles at the caret', () => {
    expect(markdownCommandState('> said', { start: 3, end: 3 })).toMatchObject({
      quote: true,
      bullet: false,
      ordered: false,
      task: false,
      heading: false,
    });
    expect(markdownCommandState('  - [x] said', { start: 9, end: 9 })).toMatchObject({
      task: true,
      bullet: false,
      listLevel: 1,
    });
  });
});

describe('markdownCommandState', () => {
  it('reports each style in force at the caret', () => {
    expect(markdownCommandState('**a** _b_ <u>c</u>', { start: 3, end: 3 })).toMatchObject({
      bold: true,
      italic: false,
      underline: false,
    });
    expect(markdownCommandState('**a** _b_ <u>c</u>', { start: 8, end: 8 })).toMatchObject({
      bold: false,
      italic: true,
      underline: false,
    });
    expect(markdownCommandState('**a** _b_ <u>c</u>', { start: 14, end: 14 })).toMatchObject({
      bold: false,
      italic: false,
      underline: true,
    });
  });
});

describe('keyCommand -- list nesting', () => {
  it('maps Tab to indent and Shift+Tab to outdent', () => {
    expect(keyCommand({ key: 'Tab' }, 'meta')).toBe('indent');
    expect(keyCommand({ key: 'Tab', shiftKey: true }, 'ctrl')).toBe('outdent');
  });

  it.each([
    ['Ctrl+Tab (switches browser tabs)', { key: 'Tab', ctrlKey: true }],
    ['Cmd+Tab', { key: 'Tab', metaKey: true }],
    ['Alt+Tab', { key: 'Tab', altKey: true }],
    ['a composing Tab', { key: 'Tab', isComposing: true }],
  ])('leaves %s alone', (_label, event) => {
    expect(keyCommand(event, 'meta')).toBeNull();
  });
});

describe('applyMarkdownCommand -- list nesting', () => {
  it('indents a list line as an edit', () => {
    expect(applyMarkdownCommand('- a', { start: 3, end: 3 }, 'indent')).toEqual({
      kind: 'edit',
      edit: { text: '  - a', selection: { start: 5, end: 5 } },
    });
  });

  it('passes Tab on prose through, so focus moves on', () => {
    expect(applyMarkdownCommand('prose', { start: 2, end: 2 }, 'indent')).toEqual({ kind: 'pass' });
  });

  it('passes Shift+Tab at level 0 through, so the keyboard is never trapped', () => {
    expect(applyMarkdownCommand('- a', { start: 3, end: 3 }, 'outdent')).toEqual({ kind: 'pass' });
  });
});

describe('markdownCommandState -- list level', () => {
  it.each([
    ['- a', 3, 0],
    ['- a\n  - b', 9, 1],
    ['prose', 2, null],
  ])('reports %j at %i as list level %j', (body, caret, level) => {
    expect(markdownCommandState(body, { start: caret, end: caret }).listLevel).toBe(level);
  });
});

describe('keyCommand -- non-Latin layouts', () => {
  it.each([
    ['Cyrillic', '\u0438', 'KeyB', 'bold'],
    ['Greek', '\u03b9', 'KeyI', 'italic'],
    ['Hebrew', '\u05d5', 'KeyU', 'underline'],
  ] as [string, string, string, MarkdownCommand][])(
    'reads the physical key on a %s layout, whose key is not a Latin letter',
    (_layout, key, code, command) => {
      expect(keyCommand({ key, code, ctrlKey: true }, 'ctrl')).toBe(command);
    },
  );

  it('trusts the letter a Latin layout reports over the physical key (Dvorak x on KeyB)', () => {
    expect(keyCommand({ key: 'x', code: 'KeyB', ctrlKey: true }, 'ctrl')).toBeNull();
  });

  it('still leaves a composing keystroke to the IME whatever its code', () => {
    expect(
      keyCommand({ key: '\u0438', code: 'KeyB', ctrlKey: true, isComposing: true }, 'ctrl'),
    ).toBeNull();
  });

  it('ignores an unmapped physical key', () => {
    expect(keyCommand({ key: '\u0438', code: 'KeyK', ctrlKey: true }, 'ctrl')).toBeNull();
    // A platform that reports no physical key at all (native) leaves it alone too.
    expect(keyCommand({ key: '\u0438', ctrlKey: true }, 'ctrl')).toBeNull();
  });
});
