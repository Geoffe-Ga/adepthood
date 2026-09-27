/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
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
