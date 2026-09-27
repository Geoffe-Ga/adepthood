/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';
import { BackHandler } from 'react-native';
import type { NativeEventSubscription } from 'react-native';

import { useDismissKeys } from '../useDismissKeys';

const Platform = require('react-native').Platform as { OS: string };

interface MutableGlobal {
  document?: Document;
}

/** A document stand-in: real event dispatch plus a switchable aria-modal probe. */
function makeFakeDocument(): { doc: Document; setModalOpen: (_open: boolean) => void } {
  const target = new EventTarget();
  let modalOpen = false;
  const doc = Object.assign(target, {
    querySelector: (selector: string) =>
      selector === '[aria-modal="true"]' && modalOpen ? {} : null,
  }) as unknown as Document;
  return {
    doc,
    setModalOpen: (open: boolean) => {
      modalOpen = open;
    },
  };
}

function pressKey(key: string): void {
  const event = new Event('keydown');
  Object.defineProperty(event, 'key', { value: key });
  act(() => {
    globalThis.document.dispatchEvent(event);
  });
}

describe('useDismissKeys -- web', () => {
  const globalRef = globalThis as MutableGlobal;
  let originalOS: string;
  let setModalOpen: (_open: boolean) => void;

  beforeEach(() => {
    originalOS = Platform.OS;
    Platform.OS = 'web';
    const fake = makeFakeDocument();
    globalRef.document = fake.doc;
    setModalOpen = fake.setModalOpen;
  });

  afterEach(() => {
    Platform.OS = originalOS;
    delete globalRef.document;
    jest.restoreAllMocks();
  });

  it('dismisses on Escape', () => {
    const onDismiss = jest.fn();
    renderHook(() => useDismissKeys(onDismiss, true));
    pressKey('Escape');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('ignores every other key', () => {
    const onDismiss = jest.fn();
    renderHook(() => useDismissKeys(onDismiss, true));
    pressKey('Enter');
    pressKey('Esc ');
    pressKey('a');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does nothing while disabled', () => {
    const onDismiss = jest.fn();
    renderHook(() => useDismissKeys(onDismiss, false));
    pressKey('Escape');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('leaves Escape to an open modal dialog, which closes itself on keyup', () => {
    const onDismiss = jest.fn();
    renderHook(() => useDismissKeys(onDismiss, true));
    setModalOpen(true);
    pressKey('Escape');
    expect(onDismiss).not.toHaveBeenCalled();
    setModalOpen(false);
    pressKey('Escape');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('removes its listener on unmount', () => {
    const onDismiss = jest.fn();
    const { unmount } = renderHook(() => useDismissKeys(onDismiss, true));
    unmount();
    pressKey('Escape');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('calls the latest handler without re-subscribing', () => {
    const first = jest.fn();
    const second = jest.fn();
    const add = jest.spyOn(globalThis.document, 'addEventListener');
    const { rerender } = renderHook(({ cb }: { cb: () => void }) => useDismissKeys(cb, true), {
      initialProps: { cb: first },
    });
    rerender({ cb: second });
    pressKey('Escape');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('registers no BackHandler on web', () => {
    const add = jest.spyOn(BackHandler, 'addEventListener');
    renderHook(() => useDismissKeys(jest.fn(), true));
    expect(add).not.toHaveBeenCalled();
  });
});

describe('useDismissKeys -- native', () => {
  let handler: ((..._args: never[]) => boolean | null | undefined) | undefined;
  const remove = jest.fn();

  beforeEach(() => {
    handler = undefined;
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, cb) => {
      handler = cb;
      return { remove } as unknown as NativeEventSubscription;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('dismisses on the hardware back press and consumes it so the route stays', () => {
    const onDismiss = jest.fn();
    renderHook(() => useDismissKeys(onDismiss, true));
    expect(BackHandler.addEventListener).toHaveBeenCalledWith(
      'hardwareBackPress',
      expect.any(Function),
    );
    let consumed: boolean | null | undefined;
    act(() => {
      consumed = handler?.();
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(consumed).toBe(true);
  });

  it('registers nothing while disabled', () => {
    renderHook(() => useDismissKeys(jest.fn(), false));
    expect(BackHandler.addEventListener).not.toHaveBeenCalled();
  });

  it('removes the back subscription on unmount', () => {
    const { unmount } = renderHook(() => useDismissKeys(jest.fn(), true));
    expect(remove).not.toHaveBeenCalled();
    unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
