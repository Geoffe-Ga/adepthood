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

  it('ignores every key while an IME composition is active', () => {
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
