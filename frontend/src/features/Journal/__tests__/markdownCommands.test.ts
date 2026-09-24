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
