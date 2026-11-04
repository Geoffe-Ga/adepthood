/* eslint-env jest */
// #3660: a Course chapter and a letter put the selection surface's floating
// pill to work -- Promote beside Write a note on a chapter, a busy mark that
// follows the promote rather than the press, a selection the host can clear
// once its promote settles, a footer Cancel the host can name, and (on web) a
// passage chosen before the surface opened scrolled into view.
import { jest, describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';
import { TextInput } from 'react-native';

import { FLOATING_PROMOTE_TEST_ID } from '../FloatingPromoteButton';
import QuoteSelectionSurface, { SELECTION_FIELD_MIN_HEIGHT } from '../QuoteSelectionSurface';
import { revealWebOffset } from '../webSelectionReveal';

jest.mock('../webSelectionListener', () => ({
  useWebSelectionListener: jest.fn(),
  useInitialFieldSelection: jest.fn(),
}));
jest.mock('../webSelectionReveal', () => ({ revealWebOffset: jest.fn(() => true) }));

const mockReveal = revealWebOffset as jest.MockedFunction<typeof revealWebOffset>;

const FAB = FLOATING_PROMOTE_TEST_ID;
const BODY = 'A steady daily walk to the river.';
const WALK = { start: BODY.indexOf('walk'), end: BODY.indexOf('walk') + 'walk'.length };

interface CollapsibleMock {
  setSelection?: jest.Mock;
  focus: jest.Mock;
}

const fieldPrototype = TextInput.prototype as unknown as CollapsibleMock;

type SurfaceProps = React.ComponentProps<typeof QuoteSelectionSurface>;

function renderSurface(overrides: Partial<SurfaceProps> = {}) {
  const onSelectionChange = jest.fn();
  const onConfirm = jest.fn(() => Promise.resolve());
  const onCancel = jest.fn();
  const props: SurfaceProps = {
    body: BODY,
    onSelectionChange,
    onConfirm,
    onCancel,
    ...overrides,
  };
  const utils = render(<QuoteSelectionSurface {...props} />);
  return { ...utils, props, onSelectionChange, onConfirm };
}

function chooseWalk(getByTestId: ReturnType<typeof render>['getByTestId']): void {
  fireEvent(getByTestId('quote-select-input'), 'selectionChange', {
    nativeEvent: { selection: WALK },
  });
}

afterEach(() => {
  delete fieldPrototype.setSelection;
});

describe('QuoteSelectionSurface -- a second action beside the pill', () => {
  it('offers it on the pill once a passage is chosen, under its own label and testID', () => {
    const onPress = jest.fn();
    const { getByTestId, queryByTestId } = renderSurface({
      secondaryAction: {
        label: 'Write a note',
        accessibilityLabel: 'Write a note on this passage',
        onPress,
        testID: 'passage-select-confirm',
      },
    });
    expect(queryByTestId('passage-select-confirm')).toBeNull();

    chooseWalk(getByTestId);
    const secondary = getByTestId('passage-select-confirm');
    within(secondary).getByText('Write a note');
    expect(secondary.props.accessibilityLabel).toBe('Write a note on this passage');
    expect(secondary.props.accessibilityRole).toBe('button');
    fireEvent.press(secondary);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('names the primary apart from its visible label when the host asks', () => {
    const { getByTestId } = renderSurface({
      confirmLabel: 'Promote',
      confirmAccessibilityLabel: 'Promote this passage',
    });
    chooseWalk(getByTestId);

    within(getByTestId(FAB)).getByText('Promote');
    expect(getByTestId(FAB).props.accessibilityLabel).toBe('Promote this passage');
  });
});

describe('QuoteSelectionSurface -- busy follows the host promote', () => {
  it('shows the pill working while the host says its promote is in flight', () => {
    const { getByTestId, rerender, props } = renderSurface();
    chooseWalk(getByTestId);
    expect(getByTestId(FAB).props.accessibilityState).toEqual(
      expect.objectContaining({ busy: false }),
    );

    rerender(<QuoteSelectionSurface {...props} confirmBusy />);

    expect(getByTestId(FAB).props.accessibilityState).toEqual(
      expect.objectContaining({ busy: true, disabled: true }),
    );
  });
});

describe('QuoteSelectionSurface -- the host clears the selection after a promote', () => {
  it('collapses the field and withdraws the pill when the clear key moves on', () => {
    fieldPrototype.setSelection = jest.fn();
    const { getByTestId, queryByTestId, rerender, props, onSelectionChange } = renderSurface({
      clearSelectionKey: 0,
    });
    chooseWalk(getByTestId);
    expect(getByTestId(FAB)).toBeTruthy();

    act(() => {
      rerender(<QuoteSelectionSurface {...props} clearSelectionKey={1} />);
    });

    expect(fieldPrototype.setSelection).toHaveBeenCalledWith(WALK.end, WALK.end);
    expect(onSelectionChange).toHaveBeenLastCalledWith({ start: WALK.end, end: WALK.end });
    expect(queryByTestId('quote-select-preview')).toBeNull();
    expect(getByTestId('quote-select-input')).toBeTruthy();
  });

  it('leaves a selection alone on mount and on a render that keeps the key', () => {
    fieldPrototype.setSelection = jest.fn();
    const { getByTestId, rerender, props } = renderSurface({ clearSelectionKey: 3 });
    chooseWalk(getByTestId);

    rerender(<QuoteSelectionSurface {...props} clearSelectionKey={3} />);

    expect(fieldPrototype.setSelection).not.toHaveBeenCalled();
    expect(getByTestId('quote-select-preview').props.children).toBe('walk');
  });
});

describe('QuoteSelectionSurface -- the footer Cancel, named by the host', () => {
  it('keeps "Cancel promoting" by default', () => {
    const { getByTestId } = renderSurface();
    const cancel = getByTestId('quote-select-cancel');
    within(cancel).getByText('Cancel');
    expect(cancel.props.accessibilityLabel).toBe('Cancel promoting');
  });

  it('takes a label and an accessible name of its own', () => {
    const { getByTestId } = renderSurface({
      cancelLabel: 'Done',
      cancelAccessibilityLabel: 'Done choosing passages',
    });
    const cancel = getByTestId('quote-select-cancel');
    within(cancel).getByText('Done');
    expect(cancel.props.accessibilityLabel).toBe('Done choosing passages');
  });
});

/**
 * A Course quote's Open lands on a chapter screens long with its passage
 * chosen. The field grows to its text and never scrolls inside, so once it has
 * grown the surface asks the page to bring the passage into view -- once, so a
 * reader who scrolls away is never pulled back.
 */
describe('QuoteSelectionSurface -- a passage chosen before it opened is brought into view', () => {
  const EMOJI_BODY = '\u{1F3B8} '.concat(BODY);
  // "walk" past one astral emoji: code points {N, N+4} are UTF-16 {N+1, N+5}.
  const WALK_POINTS = { start: Array.from(EMOJI_BODY).indexOf('w'), end: 0 };
  WALK_POINTS.end = WALK_POINTS.start + 'walk'.length;
  const GROWN = SELECTION_FIELD_MIN_HEIGHT * 10;

  function grow(getByTestId: ReturnType<typeof render>['getByTestId'], height: number): void {
    fireEvent(getByTestId('quote-select-input'), 'contentSizeChange', {
      nativeEvent: { contentSize: { width: 300, height } },
    });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    mockReveal.mockClear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reveals the passage once the field has grown to hold it, at its UTF-16 start', () => {
    const { getByTestId } = renderSurface({ body: EMOJI_BODY, initialSelection: WALK_POINTS });
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(mockReveal).not.toHaveBeenCalled();

    grow(getByTestId, GROWN);
    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(mockReveal).toHaveBeenCalledTimes(1);
    const [, offset] = mockReveal.mock.calls[0] ?? [];
    expect(offset).toBe(EMOJI_BODY.indexOf('walk'));
  });

  it('reveals only once, however the field grows after', () => {
    const { getByTestId } = renderSurface({ body: EMOJI_BODY, initialSelection: WALK_POINTS });
    grow(getByTestId, GROWN);
    act(() => {
      jest.runOnlyPendingTimers();
    });
    grow(getByTestId, GROWN * 2);
    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(mockReveal).toHaveBeenCalledTimes(1);
  });

  it('reveals nothing when the surface opened with nothing chosen', () => {
    const { getByTestId } = renderSurface();
    grow(getByTestId, GROWN);
    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(mockReveal).not.toHaveBeenCalled();
  });
});
