import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';
import { useEffect } from 'react';

import { useGrowingFieldHeight } from '../useGrowingFieldHeight';

function grow(height: number) {
  return { nativeEvent: { contentSize: { height } } };
}

describe('useGrowingFieldHeight', () => {
  it('leaves an unmeasured field with no minimum unsized', () => {
    const { result } = renderHook(() => useGrowingFieldHeight());
    expect(result.current.style).toEqual({ minHeight: undefined, height: undefined });
  });

  it('starts at its minimum and never shrinks below it', () => {
    const { result } = renderHook(() => useGrowingFieldHeight(100));
    expect(result.current.style).toEqual({ minHeight: 100, height: 100 });
    act(() => result.current.onContentSizeChange(grow(40)));
    expect(result.current.style.height).toBe(100);
  });

  it('grows to the measured content, rounded up to a whole pixel', () => {
    const { result } = renderHook(() => useGrowingFieldHeight(100));
    act(() => result.current.onContentSizeChange(grow(240.2)));
    expect(result.current.style.height).toBe(241);
  });

  it('keeps the same state object when the measurement repeats', () => {
    const { result } = renderHook(() => useGrowingFieldHeight(0));
    act(() => result.current.onContentSizeChange(grow(50)));
    const before = result.current.style;
    act(() => result.current.onContentSizeChange(grow(50)));
    expect(result.current.style).toEqual(before);
    expect(result.current.style.height).toBe(50);
  });
});

const Platform = require('react-native').Platform as { OS: string };

const MIN = 100;
/** A fractional scrollHeight above MIN, so the whole-pixel rounding is observable. */
const MEASURED = 640.2;
const MEASURED_CEIL = 641;
const NATIVE_GROWTH = 300;

interface TrackedProps {
  value: string;
  ref: { current: unknown };
}

/** A host node whose scrollHeight read is observable. */
function spyNode(height: number) {
  const read = jest.fn(() => height);
  const node = {};
  Object.defineProperty(node, 'scrollHeight', { get: read });
  return { node, read };
}

describe('useGrowingFieldHeight value-keyed remeasure (#3001)', () => {
  let originalOS: string;
  let commits: number;
  beforeEach(() => {
    originalOS = Platform.OS;
    Platform.OS = 'web';
    commits = 0;
  });
  afterEach(() => {
    Platform.OS = originalOS;
  });

  function renderTracked(ref: { current: unknown }) {
    return renderHook(
      ({ value, ref: inputRef }: TrackedProps) => {
        const growth = useGrowingFieldHeight(MIN, { value, inputRef });
        useEffect(() => {
          commits += 1;
        });
        return growth;
      },
      { initialProps: { value: 'a', ref } },
    );
  }

  it('re-reads the web field when its value changes without an input event', () => {
    const ref = { current: null as unknown };
    const { result, rerender } = renderTracked(ref);
    expect(result.current.style.height).toBe(MIN);
    ref.current = { scrollHeight: MEASURED };
    rerender({ value: 'a\nb', ref });
    expect(result.current.style.height).toBe(MEASURED_CEIL);
  });

  it('reads nothing on native, where onContentSizeChange already follows the value', () => {
    Platform.OS = 'ios';
    const { node, read } = spyNode(MEASURED);
    const ref = { current: node as unknown };
    const { result, rerender } = renderTracked(ref);
    rerender({ value: 'a\nb', ref });
    expect(read).not.toHaveBeenCalled();
    expect(result.current.style.height).toBe(MIN);
    act(() => result.current.onContentSizeChange(grow(NATIVE_GROWTH)));
    expect(result.current.style.height).toBe(NATIVE_GROWTH);
  });

  it('commits nothing extra when a new value measures the same height', () => {
    const ref = { current: { scrollHeight: MEASURED } as unknown };
    const { result, rerender } = renderTracked(ref);
    rerender({ value: 'a\nb', ref });
    expect(result.current.style.height).toBe(MEASURED_CEIL);
    const before = commits;
    rerender({ value: 'a\nb\nc', ref });
    // The rerender's own commit, and no second one from re-measuring the same height.
    expect(commits - before).toBe(1);
    expect(result.current.style.height).toBe(MEASURED_CEIL);
  });

  it('keeps a grown height when a hidden field reports no scrollHeight', () => {
    const ref = { current: { scrollHeight: MEASURED } as unknown };
    const { result, rerender } = renderTracked(ref);
    rerender({ value: 'a\nb', ref });
    ref.current = { scrollHeight: 0 };
    rerender({ value: 'a\nb\nc', ref });
    expect(result.current.style.height).toBe(MEASURED_CEIL);
  });

  it('measures on a value change, not on every render', () => {
    const { node, read } = spyNode(MEASURED);
    const ref = { current: node as unknown };
    const { rerender } = renderTracked(ref);
    const mounted = read.mock.calls.length;
    rerender({ value: 'a', ref });
    expect(read.mock.calls.length).toBe(mounted);
    rerender({ value: 'b', ref });
    expect(read.mock.calls.length).toBe(mounted + 1);
  });
});

const NARROW = 320;
const WIDE = 900;
const WRAPPED = 410.5;
const WRAPPED_CEIL = 411;
const UNWRAPPED = 150;

/** A twinnable host textarea whose copy reports ``natural`` as its text's height. */
function twinnableNode(scrollHeight: number, natural: { height: number }) {
  const twins: Array<{ style: Record<string, string>; value: string }> = [];
  const appended: unknown[] = [];
  const node = {
    scrollHeight,
    value: 'a title long enough to wrap',
    ownerDocument: {
      body: { appendChild: (child: unknown) => appended.push(child) },
      defaultView: { getComputedStyle: () => ({ width: '358px' }) },
    },
    cloneNode: () => {
      const twin = {
        style: {} as Record<string, string>,
        value: '',
        get scrollHeight() {
          return natural.height;
        },
        removeAttribute: jest.fn(),
        setAttribute: jest.fn(),
        remove: jest.fn(),
      };
      twins.push(twin);
      return twin;
    },
  };
  return { node, twins, appended };
}

function layout(width: number) {
  return { nativeEvent: { layout: { width, height: 0, x: 0, y: 0 } } };
}

describe('useGrowingFieldHeight follows a width change (#3325)', () => {
  let originalOS: string;
  beforeEach(() => {
    originalOS = Platform.OS;
    Platform.OS = 'web';
  });
  afterEach(() => {
    Platform.OS = originalOS;
  });

  function renderAt(node: unknown) {
    const ref = { current: node };
    return renderHook(() => useGrowingFieldHeight(MIN, { value: 'v', inputRef: ref }));
  }

  it('re-measures the natural height when a narrowed field rewraps', () => {
    const natural = { height: UNWRAPPED };
    const { node } = twinnableNode(UNWRAPPED, natural);
    const { result } = renderAt(node);
    act(() => result.current.onLayout(layout(WIDE)));
    expect(result.current.style.height).toBe(UNWRAPPED);
    natural.height = WRAPPED;
    act(() => result.current.onLayout(layout(NARROW)));
    expect(result.current.style.height).toBe(WRAPPED_CEIL);
  });

  it('gives the height back when a widened field needs fewer lines', () => {
    const natural = { height: WRAPPED };
    const { node } = twinnableNode(WRAPPED, natural);
    const { result } = renderAt(node);
    act(() => result.current.onLayout(layout(NARROW)));
    expect(result.current.style.height).toBe(WRAPPED_CEIL);
    natural.height = UNWRAPPED;
    act(() => result.current.onLayout(layout(WIDE)));
    expect(result.current.style.height).toBe(UNWRAPPED);
  });

  it('ignores a layout that only changes the height it set itself', () => {
    const natural = { height: WRAPPED };
    const { node, twins } = twinnableNode(WRAPPED, natural);
    const { result } = renderAt(node);
    act(() => result.current.onLayout(layout(NARROW)));
    const measured = twins.length;
    act(() => result.current.onLayout(layout(NARROW)));
    expect(twins.length).toBe(measured);
  });

  it('re-measures once a font face finishes loading', () => {
    const listeners: Array<() => void> = [];
    const fonts = {
      addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
      removeEventListener: jest.fn(),
    };
    (globalThis as { document?: unknown }).document = { fonts };
    try {
      const natural = { height: UNWRAPPED };
      const { node } = twinnableNode(UNWRAPPED, natural);
      const { result, unmount } = renderAt(node);
      expect(listeners).toHaveLength(1);
      natural.height = WRAPPED;
      act(() => listeners[0]!());
      expect(result.current.style.height).toBe(WRAPPED_CEIL);
      unmount();
      expect(fonts.removeEventListener).toHaveBeenCalledWith('loadingdone', listeners[0]);
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });

  it('measures nothing on a layout for an untracked field', () => {
    const { result } = renderHook(() => useGrowingFieldHeight(MIN));
    act(() => result.current.onLayout(layout(NARROW)));
    expect(result.current.style.height).toBe(MIN);
  });
});
