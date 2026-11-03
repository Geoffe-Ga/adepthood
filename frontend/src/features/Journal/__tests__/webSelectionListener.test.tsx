/* eslint-env jest */
// RED: '../webSelectionListener' does not exist yet, so this import fails to resolve.
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, render } from '@testing-library/react-native';
import React from 'react';
import type { TextInput } from 'react-native';

import { useInitialFieldSelection, useWebSelectionListener } from '../webSelectionListener';

const Platform = require('react-native').Platform as { OS: string };

interface MutableGlobal {
  document?: Document;
}

interface FakeSelectionNode {
  selectionStart: number | null | undefined;
  selectionEnd: number | null | undefined;
}

function makeRef(node: FakeSelectionNode | null): React.RefObject<TextInput> {
  return { current: node as unknown as TextInput | null } as React.RefObject<TextInput>;
}

interface HarnessProps {
  nodeRef: React.RefObject<TextInput | null>;
  emitSpan: (startUtf16: number, endUtf16: number) => void;
}

function Harness({ nodeRef, emitSpan }: HarnessProps): null {
  useWebSelectionListener(nodeRef, emitSpan);
  return null;
}

function dispatchSelectionChange() {
  act(() => {
    globalThis.document.dispatchEvent(new Event('selectionchange'));
  });
}

describe('useWebSelectionListener', () => {
  let originalOS: string;
  const globalRef = globalThis as MutableGlobal;

  beforeEach(() => {
    originalOS = Platform.OS;
    globalRef.document = new EventTarget() as unknown as Document;
  });

  afterEach(() => {
    Platform.OS = originalOS;
    delete globalRef.document;
  });

  it('emits the raw UTF-16 selection on web when selectionchange fires', () => {
    Platform.OS = 'web';
    const emitSpan = jest.fn();
    const nodeRef = makeRef({ selectionStart: 2, selectionEnd: 8 });

    render(<Harness nodeRef={nodeRef} emitSpan={emitSpan} />);
    dispatchSelectionChange();

    expect(emitSpan).toHaveBeenCalledWith(2, 8);
  });

  it('never emits on native platforms even though document exists', () => {
    Platform.OS = 'ios';
    const emitSpan = jest.fn();
    const nodeRef = makeRef({ selectionStart: 2, selectionEnd: 8 });

    render(<Harness nodeRef={nodeRef} emitSpan={emitSpan} />);
    dispatchSelectionChange();

    expect(emitSpan).not.toHaveBeenCalled();
  });

  it('stops emitting once unmounted', () => {
    Platform.OS = 'web';
    const emitSpan = jest.fn();
    const nodeRef = makeRef({ selectionStart: 2, selectionEnd: 8 });

    const { unmount } = render(<Harness nodeRef={nodeRef} emitSpan={emitSpan} />);
    unmount();
    dispatchSelectionChange();

    expect(emitSpan).not.toHaveBeenCalled();
  });

  it('is a no-op on web when the DOM is unavailable', () => {
    Platform.OS = 'web';
    delete globalRef.document;
    const emitSpan = jest.fn();
    const nodeRef = makeRef({ selectionStart: 2, selectionEnd: 8 });

    expect(() => render(<Harness nodeRef={nodeRef} emitSpan={emitSpan} />)).not.toThrow();
    expect(emitSpan).not.toHaveBeenCalled();
  });

  it('does not emit and does not throw when the ref has no node', () => {
    Platform.OS = 'web';
    const emitSpan = jest.fn();
    const nodeRef = makeRef(null);

    render(<Harness nodeRef={nodeRef} emitSpan={emitSpan} />);
    expect(() => dispatchSelectionChange()).not.toThrow();

    expect(emitSpan).not.toHaveBeenCalled();
  });

  it('does not emit when selectionStart or selectionEnd is not a number', () => {
    Platform.OS = 'web';
    const emitSpanA = jest.fn();
    const nullStartRef = makeRef({ selectionStart: null, selectionEnd: 8 });
    render(<Harness nodeRef={nullStartRef} emitSpan={emitSpanA} />);
    dispatchSelectionChange();
    expect(emitSpanA).not.toHaveBeenCalled();

    const emitSpanB = jest.fn();
    const undefinedEndRef = makeRef({ selectionStart: 2, selectionEnd: undefined });
    render(<Harness nodeRef={undefinedEndRef} emitSpan={emitSpanB} />);
    dispatchSelectionChange();
    expect(emitSpanB).not.toHaveBeenCalled();
  });
});

describe('useInitialFieldSelection (#3659)', () => {
  let originalOS: string;
  beforeEach(() => {
    originalOS = Platform.OS;
  });
  afterEach(() => {
    Platform.OS = originalOS;
  });

  function Seed({
    nodeRef,
    span,
  }: {
    nodeRef: React.RefObject<TextInput | null>;
    span: { start: number; end: number } | null;
  }): null {
    useInitialFieldSelection(nodeRef, span);
    return null;
  }

  function nodeWith(methods: Record<string, unknown>): React.RefObject<TextInput | null> {
    return { current: methods as unknown as TextInput };
  }

  it('selects the passage in the web textarea as it mounts', () => {
    Platform.OS = 'web';
    const setSelectionRange = jest.fn();
    render(<Seed nodeRef={nodeWith({ setSelectionRange })} span={{ start: 8, end: 12 }} />);
    expect(setSelectionRange).toHaveBeenCalledWith(8, 12);
  });

  it('selects the passage through the native field on iOS and Android', () => {
    Platform.OS = 'ios';
    const setSelection = jest.fn();
    render(<Seed nodeRef={nodeWith({ setSelection })} span={{ start: 8, end: 12 }} />);
    expect(setSelection).toHaveBeenCalledWith(8, 12);
  });

  it('touches nothing when no passage was chosen, or the chosen one is empty', () => {
    Platform.OS = 'web';
    const setSelectionRange = jest.fn();
    const nodeRef = nodeWith({ setSelectionRange });
    render(<Seed nodeRef={nodeRef} span={null} />);
    render(<Seed nodeRef={nodeRef} span={{ start: 4, end: 4 }} />);
    render(<Seed nodeRef={{ current: null }} span={{ start: 1, end: 2 }} />);
    expect(setSelectionRange).not.toHaveBeenCalled();
  });
});
