/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';
import React from 'react';

/**
 * The promote gate's timing, with the stored flag's read held open by hand.
 *
 * A press can land before the warm read at mount has settled. It must then
 * wait for the stored answer — never default one way (skipping the note for a
 * new reader) or the other (flashing it at someone who turned it off).
 */
import { usePromoteExplainer } from '../usePromoteExplainer';

const mockLoad = jest.fn<() => Promise<boolean>>();
const mockSave = jest.fn<(_value: boolean) => Promise<void>>();

jest.mock('@/storage/promoteExplainerStorage', () => ({
  loadPromoteExplainerDismissed: () => mockLoad(),
  savePromoteExplainerDismissed: (value: boolean) => mockSave(value),
}));

/** A stored read the test settles when it chooses. */
function holdRead(): (_dismissed: boolean) => Promise<void> {
  let settle: (_v: boolean) => void = () => undefined;
  const promise = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  mockLoad.mockReturnValue(promise);
  return async (dismissed: boolean) => {
    settle(dismissed);
    await promise;
  };
}

function renderGate() {
  const startSelecting = jest.fn();
  const hook = renderHook(() => usePromoteExplainer(startSelecting));
  return { ...hook, startSelecting };
}

beforeEach(() => {
  mockLoad.mockReset();
  mockSave.mockReset();
  mockSave.mockResolvedValue(undefined);
});

describe('usePromoteExplainer — a press before the stored flag has loaded waits for it', () => {
  it('a new reader: the press opens the note once the read says not dismissed', async () => {
    const settle = holdRead();
    const { result, startSelecting } = renderGate();

    act(() => result.current.onPress());
    expect(result.current.visible).toBe(false);
    expect(startSelecting).not.toHaveBeenCalled();

    await act(async () => settle(false));

    expect(result.current.visible).toBe(true);
    expect(startSelecting).not.toHaveBeenCalled();
  });

  it('a reader who turned it off: the press goes straight to selecting, with no flash', async () => {
    const settle = holdRead();
    const { result, startSelecting } = renderGate();
    const seen: boolean[] = [];

    act(() => result.current.onPress());
    seen.push(result.current.visible);
    await act(async () => settle(true));
    seen.push(result.current.visible);

    expect(seen).toEqual([false, false]);
    expect(startSelecting).toHaveBeenCalledTimes(1);
  });

  it('a read landing after StrictMode replays the mount effects still opens the note', async () => {
    // StrictMode runs every effect's cleanup and setup once more on mount; that
    // replay is not an unmount, so the late read must still be acted on.
    const settle = holdRead();
    const startSelecting = jest.fn();
    const { result } = renderHook(() => usePromoteExplainer(startSelecting), {
      wrapper: React.StrictMode,
    });

    act(() => result.current.onPress());
    await act(async () => settle(false));

    expect(result.current.visible).toBe(true);
    expect(startSelecting).not.toHaveBeenCalled();
  });

  it('a read landing after the screen has gone does nothing', async () => {
    const settle = holdRead();
    const { result, startSelecting, unmount } = renderGate();

    act(() => result.current.onPress());
    unmount();
    await settle(true);

    expect(startSelecting).not.toHaveBeenCalled();
  });
});

describe('usePromoteExplainer — the arms', () => {
  async function openNote() {
    mockLoad.mockResolvedValue(false);
    const gate = renderGate();
    await act(async () => {
      await Promise.resolve();
    });
    act(() => gate.result.current.onPress());
    expect(gate.result.current.visible).toBe(true);
    return gate;
  }

  it('"Choose the passage" closes the note and starts selecting', async () => {
    const { result, startSelecting } = await openNote();

    act(() => result.current.onContinue());

    expect(result.current.visible).toBe(false);
    expect(startSelecting).toHaveBeenCalledTimes(1);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('"Not now" closes the note, selects nothing, and stores nothing', async () => {
    const { result, startSelecting } = await openNote();

    act(() => result.current.onCancel());

    expect(result.current.visible).toBe(false);
    expect(startSelecting).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('ticked then declined: the dismissal is stored', async () => {
    const { result } = await openNote();

    act(() => result.current.onToggleDontShowAgain());
    act(() => result.current.onCancel());

    expect(mockSave).toHaveBeenCalledWith(true);
  });

  it('ticked then continued: a fast second press goes straight through while the write is still out', async () => {
    const { result, startSelecting } = await openNote();
    mockSave.mockReturnValue(new Promise<void>(() => undefined));

    act(() => result.current.onToggleDontShowAgain());
    act(() => result.current.onContinue());
    act(() => result.current.onPress());

    expect(result.current.visible).toBe(false);
    expect(startSelecting).toHaveBeenCalledTimes(2);
  });

  it('the box starts unticked and toggles both ways', async () => {
    const { result } = await openNote();
    expect(result.current.dontShowAgain).toBe(false);

    act(() => result.current.onToggleDontShowAgain());
    expect(result.current.dontShowAgain).toBe(true);
    act(() => result.current.onToggleDontShowAgain());
    expect(result.current.dontShowAgain).toBe(false);
  });
});
