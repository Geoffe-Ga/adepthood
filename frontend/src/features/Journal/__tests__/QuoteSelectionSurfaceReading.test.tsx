/* eslint-env jest */
// #3660: a Course chapter and a letter put the selection surface's floating
// pill to work -- Promote beside Write a note on a chapter, a busy mark that
// follows the promote rather than the press, a selection the host can clear
// once its promote settles, and a footer Cancel the host can name.
import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';
import { TextInput } from 'react-native';

import { FLOATING_PROMOTE_TEST_ID } from '../FloatingPromoteButton';
import QuoteSelectionSurface from '../QuoteSelectionSurface';

jest.mock('../webSelectionListener', () => ({
  useWebSelectionListener: jest.fn(),
  useInitialFieldSelection: jest.fn(),
}));

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
