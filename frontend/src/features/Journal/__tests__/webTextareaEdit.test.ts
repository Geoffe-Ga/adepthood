import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { applyEditToTextarea } from '../webTextareaEdit';

interface MutableGlobal {
  document?: unknown;
}

/**
 * A stand-in for the textarea react-native-web renders. ``execCommand`` is
 * modelled as the browser does it: it replaces the node's current selection
 * and moves the caret to the end of the inserted text.
 */
function fakeTextarea(value: string) {
  const node = {
    value,
    selectionStart: value.length,
    selectionEnd: value.length,
    setSelectionRange: jest.fn((start: number, end: number) => {
      node.selectionStart = start;
      node.selectionEnd = end;
    }),
  };
  return node;
}

function installDocument(node: ReturnType<typeof fakeTextarea>, result = true) {
  const execCommand = jest.fn((command: string, _ui: boolean, text?: string) => {
    if (!result) return false;
    const inserted = command === 'insertText' ? (text ?? '') : '';
    node.value = `${node.value.slice(0, node.selectionStart)}${inserted}${node.value.slice(node.selectionEnd)}`;
    node.selectionStart = node.selectionStart + inserted.length;
    node.selectionEnd = node.selectionStart;
    return true;
  });
  (globalThis as MutableGlobal).document = { execCommand };
  return execCommand;
}

describe('applyEditToTextarea', () => {
  afterEach(() => {
    delete (globalThis as MutableGlobal).document;
  });

  it('inserts through the browser so its undo stack records the command', () => {
    const node = fakeTextarea('a word');
    const execCommand = installDocument(node);

    const applied = applyEditToTextarea(node, {
      text: 'a **word**',
      selection: { start: 4, end: 8 },
    });

    expect(applied).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('insertText', false, '**word**');
    expect(node.value).toBe('a **word**');
    expect([node.selectionStart, node.selectionEnd]).toEqual([4, 8]);
  });

  it('deletes through the browser when the replacement is empty', () => {
    const node = fakeTextarea('  - a');
    const execCommand = installDocument(node);

    expect(applyEditToTextarea(node, { text: '- a', selection: { start: 3, end: 3 } })).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('delete', false);
    expect(node.value).toBe('- a');
    expect([node.selectionStart, node.selectionEnd]).toEqual([3, 3]);
  });

  it('leaves the browser caret where the insertion put it when the edit names none', () => {
    const node = fakeTextarea('ab');
    installDocument(node);
    expect(applyEditToTextarea(node, { text: 'axb' })).toBe(true);
    expect(node.setSelectionRange).toHaveBeenCalledTimes(1);
  });

  it('only moves the selection when the text is already right', () => {
    const node = fakeTextarea('same');
    const execCommand = installDocument(node);
    expect(applyEditToTextarea(node, { text: 'same', selection: { start: 1, end: 2 } })).toBe(true);
    expect(execCommand).not.toHaveBeenCalled();
    expect([node.selectionStart, node.selectionEnd]).toEqual([1, 2]);
  });

  it('reports failure when the browser refuses the command, so the caller falls back', () => {
    const node = fakeTextarea('a word');
    installDocument(node, false);
    expect(applyEditToTextarea(node, { text: 'a **word**' })).toBe(false);
  });

  it('reports failure when the browser produced some other text', () => {
    const node = fakeTextarea('a word');
    (globalThis as MutableGlobal).document = {
      execCommand: jest.fn(() => {
        node.value = 'something else';
        return true;
      }),
    };
    expect(applyEditToTextarea(node, { text: 'a **word**' })).toBe(false);
  });

  it('reports failure with no document or no execCommand', () => {
    const node = fakeTextarea('a');
    expect(applyEditToTextarea(node, { text: 'b' })).toBe(false);
    (globalThis as MutableGlobal).document = {};
    expect(applyEditToTextarea(node, { text: 'b' })).toBe(false);
  });

  it('reports failure for a node that is not a text field', () => {
    installDocument(fakeTextarea('a'));
    expect(applyEditToTextarea(null, { text: 'b' })).toBe(false);
    expect(applyEditToTextarea({ value: 'a' }, { text: 'b' })).toBe(false);
  });
});
