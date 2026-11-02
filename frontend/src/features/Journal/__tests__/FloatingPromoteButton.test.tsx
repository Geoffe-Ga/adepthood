/* eslint-env jest */
// RED: '../FloatingPromoteButton' does not exist yet (#3134).
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { X } from 'lucide-react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import FloatingPromoteButton, { FLOATING_PROMOTE_TEST_ID } from '../FloatingPromoteButton';
import { RESONANCE_BUTTON_CLEARANCE } from '../JournalEntry.styles';
import { CLOSE_PRESSED_COLOR, CLOSE_REST_COLOR } from '../ReflectionDismiss';

import { accent, colors, surface, touchTarget } from '@/design/tokens';
import { useReducedMotion } from '@/hooks/useReducedMotion';

jest.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: jest.fn(() => false) }));

const mockedReducedMotion = useReducedMotion as jest.MockedFunction<typeof useReducedMotion>;

const FAB = FLOATING_PROMOTE_TEST_ID;

type FabProps = React.ComponentProps<typeof FloatingPromoteButton>;

function renderFab(overrides: Partial<FabProps> = {}) {
  const onPress = jest.fn();
  const onCancel = jest.fn();
  const utils = render(
    <FloatingPromoteButton visible onPress={onPress} onCancel={onCancel} {...overrides} />,
  );
  return { ...utils, onPress, onCancel };
}

beforeEach(() => {
  mockedReducedMotion.mockReturnValue(false);
});

describe('FloatingPromoteButton -- presence', () => {
  it('renders nothing at all while there is no passage to promote', () => {
    const { queryByTestId } = renderFab({ visible: false });
    expect(queryByTestId(FAB, { includeHiddenElements: true })).toBeNull();
    expect(queryByTestId(`${FAB}-anchor`, { includeHiddenElements: true })).toBeNull();
  });

  it('is a labelled button that promotes on press', () => {
    const { getByTestId, getByText, onPress } = renderFab();
    const button = getByTestId(FAB);
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityLabel).toBe('Promote selection');
    expect(getByText('Promote selection')).toBeTruthy();
    fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('speaks a caller-chosen label and accessible name', () => {
    const { getByTestId, getByText } = renderFab({
      label: 'Promote',
      accessibilityLabel: 'Promote this passage',
    });
    expect(getByText('Promote')).toBeTruthy();
    expect(getByTestId(FAB).props.accessibilityLabel).toBe('Promote this passage');
  });

  it('leaves the reader at once and, its fade done, leaves the tree', async () => {
    const { getByTestId, queryByTestId, rerender, onPress, onCancel } = renderFab();
    rerender(<FloatingPromoteButton visible={false} onPress={onPress} onCancel={onCancel} />);
    // Hidden from assistive technology and inert the moment it is withdrawn...
    expect(queryByTestId(FAB)).toBeNull();
    const fading = queryByTestId(FAB, { includeHiddenElements: true });
    if (fading != null) {
      fireEvent.press(fading);
      expect(onPress).not.toHaveBeenCalled();
    }
    // ...and gone once the fade has run.
    await waitFor(() =>
      expect(queryByTestId(`${FAB}-anchor`, { includeHiddenElements: true })).toBeNull(),
    );
    rerender(<FloatingPromoteButton visible onPress={onPress} onCancel={onCancel} />);
    expect(getByTestId(FAB)).toBeTruthy();
  });

  it('under reduced motion appears at rest and leaves without a fade', () => {
    mockedReducedMotion.mockReturnValue(true);
    const { getByTestId, queryByTestId, rerender, onPress } = renderFab();
    const anchor = StyleSheet.flatten(getByTestId(`${FAB}-anchor`).props.style);
    expect(anchor.opacity).toBe(1);
    rerender(<FloatingPromoteButton visible={false} onPress={onPress} />);
    expect(queryByTestId(`${FAB}-anchor`, { includeHiddenElements: true })).toBeNull();
  });
});

describe('FloatingPromoteButton -- placement (#3134)', () => {
  it('floats centred above the bottom band, clear of the page flow', () => {
    const { getByTestId } = renderFab();
    const anchor = StyleSheet.flatten(getByTestId(`${FAB}-anchor`).props.style);
    expect(anchor.position).toBe('absolute');
    expect(anchor.bottom).toBe(RESONANCE_BUTTON_CLEARANCE);
    expect(anchor.left).toBe(0);
    expect(anchor.right).toBe(0);
    expect(anchor.alignItems).toBe('center');
    expect(anchor.zIndex).toBeGreaterThan(0);
  });

  it('lets a touch beside the pill reach the text beneath its band', () => {
    const { getByTestId } = renderFab();
    expect(getByTestId(`${FAB}-anchor`).props.pointerEvents).toBe('box-none');
  });
});

describe('FloatingPromoteButton -- Candle & Ink pill', () => {
  it('carries the one solid accent call to action, at least a touch target tall', () => {
    const { getByTestId, getByText } = renderFab();
    const pill = StyleSheet.flatten(getByTestId(FAB).props.style);
    expect(pill.backgroundColor).toBe(accent.primary);
    expect(pill.minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
    const label = StyleSheet.flatten(getByText('Promote selection').props.style);
    expect(label.color).toBe(accent.onPrimary);
  });

  it('draws the quote mark as decoration the label already names', () => {
    const { getByTestId } = renderFab();
    expect(getByTestId(`${FAB}-icon`, { includeHiddenElements: true })).toBeTruthy();
    expect(getByTestId(FAB).props.accessibilityLabel).toBe('Promote selection');
  });
});

describe('FloatingPromoteButton -- trailing clear', () => {
  it('offers a quiet glass X with its own name and a full touch target', () => {
    const { getByTestId, onCancel, onPress } = renderFab();
    const clear = getByTestId(`${FAB}-cancel`);
    expect(clear.props.accessibilityRole).toBe('button');
    expect(clear.props.accessibilityLabel).toBe('Clear selection');
    const style = StyleSheet.flatten(clear.props.style);
    expect(style.minWidth).toBeGreaterThanOrEqual(touchTarget.minimum);
    expect(style.minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
    expect(style.backgroundColor).toBe(colors.mystical.transparentLight);
    expect(style.borderColor).toBe(surface.hairline);
    fireEvent.press(clear);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('rests in soft ink and takes the accent while held, as the reflection cards do', () => {
    const { getByTestId, UNSAFE_getByType } = renderFab();
    const clear = getByTestId(`${FAB}-cancel`);
    expect(UNSAFE_getByType(X).props.color).toBe(CLOSE_REST_COLOR);
    fireEvent(clear, 'pressIn');
    expect(UNSAFE_getByType(X).props.color).toBe(CLOSE_PRESSED_COLOR);
    fireEvent(clear, 'pressOut');
    expect(UNSAFE_getByType(X).props.color).toBe(CLOSE_REST_COLOR);
  });

  it('takes a caller-chosen name for the X', () => {
    const { getByTestId } = renderFab({ cancelAccessibilityLabel: 'Not this passage' });
    expect(getByTestId(`${FAB}-cancel`).props.accessibilityLabel).toBe('Not this passage');
  });

  it('draws no X when the caller offers no way to clear', () => {
    const { queryByTestId } = renderFab({ onCancel: undefined });
    expect(queryByTestId(`${FAB}-cancel`, { includeHiddenElements: true })).toBeNull();
  });
});

describe('FloatingPromoteButton -- secondary action', () => {
  it('adds a second glass action beside the primary, pressed on its own', () => {
    const onSecondary = jest.fn();
    const { getByTestId, getByText, onPress } = renderFab({
      secondaryAction: {
        label: 'Write a note',
        accessibilityLabel: 'Write a note on this passage',
        onPress: onSecondary,
      },
    });
    const secondary = getByTestId(`${FAB}-secondary`);
    expect(secondary.props.accessibilityRole).toBe('button');
    expect(secondary.props.accessibilityLabel).toBe('Write a note on this passage');
    expect(getByText('Write a note')).toBeTruthy();
    expect(StyleSheet.flatten(secondary.props.style).backgroundColor).not.toBe(accent.primary);
    fireEvent.press(secondary);
    expect(onSecondary).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('honours a caller testID on the secondary action', () => {
    const { getByTestId } = renderFab({
      secondaryAction: { label: 'Write a note', onPress: jest.fn(), testID: 'write-note-fab' },
    });
    expect(getByTestId('write-note-fab').props.accessibilityLabel).toBe('Write a note');
  });
});

describe('FloatingPromoteButton -- busy', () => {
  it('announces busy, shows a working mark in place of the quote, and ignores presses', () => {
    const { getByTestId, queryByTestId, onPress } = renderFab({ busy: true });
    const button = getByTestId(FAB);
    expect(button.props.accessibilityState).toEqual(
      expect.objectContaining({ busy: true, disabled: true }),
    );
    expect(getByTestId(`${FAB}-busy`)).toBeTruthy();
    expect(queryByTestId(`${FAB}-icon`, { includeHiddenElements: true })).toBeNull();
    fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('keeps the X reachable while a promote is in flight', async () => {
    const { getByTestId, onCancel } = renderFab({ busy: true });
    await act(async () => {
      fireEvent.press(getByTestId(`${FAB}-cancel`));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
