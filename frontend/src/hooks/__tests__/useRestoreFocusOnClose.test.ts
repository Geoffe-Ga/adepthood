/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { renderHook } from '@testing-library/react-native';
import type React from 'react';

import { useRestoreFocusOnClose } from '../useRestoreFocusOnClose';

type Focusable = { focus: () => void };

function focusableRef(): { ref: React.RefObject<Focusable | null>; focus: jest.Mock } {
  const focus = jest.fn();
  return { ref: { current: { focus } }, focus };
}

describe('useRestoreFocusOnClose', () => {
  it('does not move focus on first mount, open or closed', () => {
    const closed = focusableRef();
    renderHook(() => useRestoreFocusOnClose(false, closed.ref));
    const open = focusableRef();
    renderHook(() => useRestoreFocusOnClose(true, open.ref));
    expect(closed.focus).not.toHaveBeenCalled();
    expect(open.focus).not.toHaveBeenCalled();
  });

  it('returns focus once when the surface closes', () => {
    const { ref, focus } = focusableRef();
    const { rerender } = renderHook(
      ({ open }: { open: boolean }) => useRestoreFocusOnClose(open, ref),
      {
        initialProps: { open: false },
      },
    );
    rerender({ open: true });
    expect(focus).not.toHaveBeenCalled();
    rerender({ open: false });
    expect(focus).toHaveBeenCalledTimes(1);
    rerender({ open: false });
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('is safe when the target is not mounted', () => {
    const ref: React.RefObject<Focusable | null> = { current: null };
    const { rerender } = renderHook(
      ({ open }: { open: boolean }) => useRestoreFocusOnClose(open, ref),
      {
        initialProps: { open: true },
      },
    );
    expect(() => rerender({ open: false })).not.toThrow();
  });
});

// #2883: closing from inside a text field (Escape while typing in the editor)
// must not pull the writer out of their text.
describe('useRestoreFocusOnClose -- a text field that still holds focus keeps it', () => {
  const Platform = require('react-native').Platform as { OS: string };
  const globalRef = globalThis as { document?: Document };
  let originalOS: string;

  beforeEach(() => {
    originalOS = Platform.OS;
  });

  afterEach(() => {
    Platform.OS = originalOS;
    delete globalRef.document;
    jest.restoreAllMocks();
  });

  function closeWith(): jest.Mock {
    const { ref, focus } = focusableRef();
    const { rerender } = renderHook(
      ({ open }: { open: boolean }) => useRestoreFocusOnClose(open, ref),
      {
        initialProps: { open: true },
      },
    );
    rerender({ open: false });
    return focus;
  }

  it.each(['TEXTAREA', 'INPUT'])('leaves web focus in a connected %s', (tagName) => {
    Platform.OS = 'web';
    globalRef.document = { activeElement: { tagName, isConnected: true } } as unknown as Document;
    expect(closeWith()).not.toHaveBeenCalled();
  });

  it('leaves web focus in a contenteditable', () => {
    Platform.OS = 'web';
    globalRef.document = {
      activeElement: { tagName: 'DIV', isConnected: true, isContentEditable: true },
    } as unknown as Document;
    expect(closeWith()).not.toHaveBeenCalled();
  });

  it('restores on web when focus fell to the body (the closed surface took it away)', () => {
    Platform.OS = 'web';
    globalRef.document = {
      activeElement: { tagName: 'BODY', isConnected: true },
    } as unknown as Document;
    expect(closeWith()).toHaveBeenCalledTimes(1);
  });

  it('restores on web when the focused field was inside the closed surface', () => {
    Platform.OS = 'web';
    globalRef.document = {
      activeElement: { tagName: 'TEXTAREA', isConnected: false },
    } as unknown as Document;
    expect(closeWith()).toHaveBeenCalledTimes(1);
  });

  it('leaves native focus in a focused TextInput', () => {
    const { TextInput } = require('react-native');
    jest.spyOn(TextInput.State, 'currentlyFocusedInput').mockReturnValue({});
    expect(closeWith()).not.toHaveBeenCalled();
  });
});
