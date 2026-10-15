import { expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React, { createRef } from 'react';
import { Platform, TouchableOpacity } from 'react-native';
import type { ScrollView, View } from 'react-native';

import HighlightedBody from '../HighlightedBody';
import {
  MarginNavigationProvider,
  noteNavigationAllowed,
  useMarginNavigation,
} from '../marginNavigation';
import MarginNote from '../MarginNote';
import { drawnNoteIds } from '../renderedSpans';

import { note } from './resonanceTestKit';

it('refuses a still-active note whose saved offsets now address different words', () => {
  const body = 'The gate is open.';
  const old = note({ id: 1, anchor_start: 0, anchor_end: 8, anchor_text: 'The lake' });
  expect(noteNavigationAllowed(old, body, [old], drawnNoteIds(body, [old], []))).toBe(false);
});
it('accepts the exact current passage in code-point space', () => {
  const body = '🌿 The lake is still.';
  const current = note({ id: 1, anchor_start: 2, anchor_end: 10, anchor_text: 'The lake' });
  expect(noteNavigationAllowed(current, body, [current], drawnNoteIds(body, [current], []))).toBe(
    true,
  );
});
it('refuses stale, detached and old page objects even if an old element remains clickable', () => {
  const body = 'The lake is still.';
  const current = note({ id: 1, anchor_start: 0, anchor_end: 8, anchor_text: 'The lake' });
  const stale = { ...current, status: 'stale' as const };
  expect(noteNavigationAllowed(stale, body, [stale], new Set([1]))).toBe(false);
  expect(noteNavigationAllowed(current, body, [current], new Set())).toBe(false);
  expect(noteNavigationAllowed(current, body, [{ ...current }], new Set([1]))).toBe(false);
});

it('keeps a locally broken note visible and stale without drawing a wrong-passage link', async () => {
  const oldOS = Platform.OS;
  Platform.OS = 'web';
  try {
    const body = 'The gate is open.';
    const old = note({ id: 1, anchor_start: 0, anchor_end: 8, anchor_text: 'The lake' });
    const notes = [old];
    const view = render(
      <MarginNavigationProvider
        body={body}
        notes={notes}
        quotes={[]}
        pageRef={createRef<View>()}
        scrollRef={createRef<ScrollView>()}
      >
        <MarginNote note={old} onOpen={() => {}} />
        <HighlightedBody body={body} notes={notes} onOpen={() => {}} />
      </MarginNavigationProvider>,
    );
    expect(await view.findByTestId('margin-note-stale-1')).toBeTruthy();
    expect(view.queryByTestId('highlight-1')).toBeNull();
    expect(view.getByTestId('margin-note-1')).toBeTruthy();
  } finally {
    Platform.OS = oldOS;
  }
});

it('retains the original Open action while read-mode navigation is disabled for editing', async () => {
  const oldOS = Platform.OS;
  Platform.OS = 'web';
  try {
    const body = 'The lake is still.';
    const current = note({ id: 1, anchor_start: 0, anchor_end: 8, anchor_text: 'The lake' });
    const opened = jest.fn();
    const view = render(
      <MarginNavigationProvider
        enabled={false}
        body={body}
        notes={[current]}
        quotes={[]}
        pageRef={createRef<View>()}
        scrollRef={createRef<ScrollView>()}
      >
        <MarginNote note={current} onOpen={opened} />
      </MarginNavigationProvider>,
    );
    await act(async () => {});
    expect(view.getByTestId('margin-note-1').props.accessibilityLabel).toBe(
      `Open ${current.kind} note`,
    );
    expect(view.queryByTestId('margin-note-open-1')).toBeNull();
    fireEvent.press(view.getByTestId('margin-note-1'));
    expect(opened).toHaveBeenCalledWith(current);
  } finally {
    Platform.OS = oldOS;
  }
});

it.each(['new snapshot', 'unmount'] as const)(
  'ignores retained navigation and card callbacks after %s',
  async (transition) => {
    const previousOS = Platform.OS;
    Platform.OS = 'web';
    try {
      const current = note({ id: 1, anchor_start: 0, anchor_end: 8, anchor_text: 'The lake' });
      const next = { ...current, anchor_text: 'The gate' };
      const scroll = {
        scrollTop: 0,
        scrollHeight: 2000,
        clientHeight: 600,
        scroll: jest.fn(),
        getBoundingClientRect: () => ({ top: 0 }),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      };
      const pageRef = {
        current: {
          querySelector: () => ({ getBoundingClientRect: () => ({ top: 800 }) }),
        } as unknown as View,
      };
      const scrollRef = { current: { getScrollableNode: () => scroll } as unknown as ScrollView };
      let navigation: ReturnType<typeof useMarginNavigation>;
      function Probe() {
        navigation = useMarginNavigation();
        return null;
      }
      const opened = jest.fn();
      const tree = (body: string, n: typeof current) => (
        <MarginNavigationProvider
          body={body}
          notes={[n]}
          quotes={[]}
          pageRef={pageRef}
          scrollRef={scrollRef}
        >
          <Probe />
          <MarginNote note={n} onOpen={opened} />
        </MarginNavigationProvider>
      );
      const view = render(tree('The lake is still.', current));
      await act(async () => {});
      const retained = navigation!;
      const press = view
        .UNSAFE_getAllByType(TouchableOpacity)
        .find((button) => button.props.testID === 'margin-note-1')!.props.onPress;
      if (transition === 'unmount') view.unmount();
      else view.rerender(tree('The gate is open.', next));
      act(() => {
        retained?.fromNote(current);
        retained?.fromPassage(current, opened);
        press();
      });
      expect(scroll.scroll).not.toHaveBeenCalled();
      expect(opened).not.toHaveBeenCalled();
      if (transition !== 'unmount') expect(navigation!.selectedId).toBeNull();
    } finally {
      Platform.OS = previousOS;
    }
  },
);
