/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

/**
 * ``RenderedSelectionPill`` (#3661): #3134's pill in its dock, over a passage
 * highlighted on the rendered page. The pill itself is pinned by
 * ``FloatingPromoteButton.test.tsx``; this pins what the rendered page adds.
 */
import { FLOATING_PROMOTE_TEST_ID } from '../FloatingPromoteButton';
import { RESONANCE_BUTTON_CLEARANCE } from '../JournalEntry.styles';
import { floatingDockStyle } from '../readingSurfaceStyles';
import RenderedSelectionPill from '../RenderedSelectionPill';
import { clearRenderedSelection } from '../useRenderedSelection';
import { useLiftClearOfPill } from '../webSelectionLift';

jest.mock('../useRenderedSelection', () => ({ clearRenderedSelection: jest.fn() }));
jest.mock('../webSelectionLift', () => ({ useLiftClearOfPill: jest.fn() }));
jest.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => true }));

const Platform = require('react-native').Platform as { OS: string };
const FAB = FLOATING_PROMOTE_TEST_ID;
const DOCK = `${FAB}-dock`;
const PASSAGE = { start: 4, end: 19 };

describe('RenderedSelectionPill', () => {
  let originalOS: string;

  beforeEach(() => {
    originalOS = Platform.OS;
    Platform.OS = 'web';
  });

  afterEach(() => {
    Platform.OS = originalOS;
  });

  it('draws nothing at all off the web, where no rendered selection exists', () => {
    Platform.OS = 'ios';
    const { toJSON } = render(<RenderedSelectionPill passage={PASSAGE} onPromote={jest.fn()} />);
    expect(toJSON()).toBeNull();
  });

  it('rides the selection field pill’s own dock, and promotes the passage on press', () => {
    const onPromote = jest.fn();
    const { getByTestId } = render(
      <RenderedSelectionPill passage={PASSAGE} onPromote={onPromote} />,
    );
    const dock = getByTestId(DOCK);
    expect(dock.props.style).toEqual(floatingDockStyle);
    expect(dock.props.pointerEvents).toBe('box-none');
    fireEvent.press(getByTestId(FAB));
    expect(onPromote).toHaveBeenCalledWith(PASSAGE);
  });

  it('keeps the pill’s lift clear under the surface, so a text’s last line can rise above it', () => {
    const { getByTestId } = render(<RenderedSelectionPill passage={null} onPromote={jest.fn()} />);
    expect(StyleSheet.flatten(getByTestId(`${FAB}-band`).props.style)).toEqual({
      height: RESONANCE_BUTTON_CLEARANCE,
    });
  });

  it('lifts each chosen passage clear of the pill riding its dock', () => {
    const { rerender } = render(<RenderedSelectionPill passage={null} onPromote={jest.fn()} />);
    expect(useLiftClearOfPill).toHaveBeenLastCalledWith(expect.anything(), null);
    rerender(<RenderedSelectionPill passage={PASSAGE} onPromote={jest.fn()} />);
    expect(useLiftClearOfPill).toHaveBeenLastCalledWith(expect.anything(), PASSAGE);
  });

  it('declines a mouse press’s default action, so pressing the pill keeps the passage selected', () => {
    const { getByTestId } = render(
      <RenderedSelectionPill passage={PASSAGE} onPromote={jest.fn()} />,
    );
    const preventDefault = jest.fn();
    fireEvent(getByTestId(DOCK), 'mouseDown', { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('lets go of the selection from its X unless the host clears it its own way', () => {
    const { getByTestId, rerender } = render(
      <RenderedSelectionPill passage={PASSAGE} onPromote={jest.fn()} />,
    );
    fireEvent.press(getByTestId(`${FAB}-cancel`));
    expect(clearRenderedSelection).toHaveBeenCalledTimes(1);

    const onCancel = jest.fn();
    rerender(<RenderedSelectionPill passage={PASSAGE} onPromote={jest.fn()} onCancel={onCancel} />);
    fireEvent.press(getByTestId(`${FAB}-cancel`));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(clearRenderedSelection).toHaveBeenCalledTimes(1);
  });

  it('carries the host’s label, secondary action and busy state to the pill', () => {
    const onNote = jest.fn();
    const { getByTestId, getByText } = render(
      <RenderedSelectionPill
        passage={PASSAGE}
        onPromote={jest.fn()}
        label="Promote"
        accessibilityLabel="Promote this passage"
        secondaryAction={{ label: 'Write a note', onPress: onNote }}
        busy
      />,
    );
    expect(getByText('Promote')).toBeTruthy();
    expect(getByTestId(FAB).props.accessibilityLabel).toBe('Promote this passage');
    expect(getByTestId(`${FAB}-busy`)).toBeTruthy();
    fireEvent.press(getByTestId(`${FAB}-secondary`));
    expect(onNote).toHaveBeenCalledTimes(1);
  });

  it('is empty while there is no passage', () => {
    const { queryByTestId, getByTestId } = render(
      <RenderedSelectionPill passage={null} onPromote={jest.fn()} />,
    );
    expect(getByTestId(DOCK)).toBeTruthy();
    expect(queryByTestId(FAB, { includeHiddenElements: true })).toBeNull();
  });
});
