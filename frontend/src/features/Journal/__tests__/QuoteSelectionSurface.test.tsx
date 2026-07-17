/* eslint-env jest */
// RED: `QuoteSelectionSurface` does not yet render an instruction line, a live
// preview, a guarded "Promote selection" Button, or an empty-tap hint -- every
// testID below is missing until the implementation-specialist adds them.
import { jest, describe, it, expect } from '@jest/globals';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import QuoteSelectionSurface from '../QuoteSelectionSurface';

import { editorialType } from '@/design/tokens';

const BODY = 'A steady daily walk to the river.';

const INSTRUCTION_COPY = 'Touch and hold a passage, then drag to choose it.';
const EMPTY_HINT_COPY = 'Choose a passage first — touch and hold the text.';

type SurfaceProps = React.ComponentProps<typeof QuoteSelectionSurface>;

function renderSurface(overrides: Partial<SurfaceProps> = {}) {
  const onSelectionChange = jest.fn();
  const onConfirm = jest.fn(() => Promise.resolve());
  const onCancel = jest.fn();
  const utils = render(
    <QuoteSelectionSurface
      body={BODY}
      onSelectionChange={onSelectionChange}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { ...utils, onSelectionChange, onConfirm, onCancel };
}

describe('QuoteSelectionSurface -- instruction', () => {
  it('renders the warm instruction line at note size, not caption size', () => {
    const { getByTestId, getByText } = renderSurface();
    expect(getByText(INSTRUCTION_COPY)).toBeTruthy();
    const style = StyleSheet.flatten(getByTestId('quote-select-instruction').props.style);
    expect(style.fontSize).toBe(editorialType.note.fontSize);
  });
});

describe('QuoteSelectionSurface -- empty selection', () => {
  it('has no preview and a disabled confirm that ignores a press', () => {
    const { queryByTestId, getByTestId, onConfirm } = renderSurface();
    expect(queryByTestId('quote-select-preview')).toBeNull();
    const confirm = getByTestId('quote-select-confirm');
    expect(confirm.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('pressing the confirm guard shows a hint and never confirms', () => {
    const { getByTestId, onConfirm } = renderSurface();
    fireEvent.press(getByTestId('quote-select-confirm-guard'));
    expect(getByTestId('quote-select-hint').props.children).toBe(EMPTY_HINT_COPY);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('QuoteSelectionSurface -- nonempty ASCII selection', () => {
  it('previews the raw slice, enables confirm, and reports the code-point span', async () => {
    const { getByTestId, onSelectionChange, onConfirm } = renderSurface();
    const input = getByTestId('quote-select-input');

    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 2, end: 8 } } });

    expect(getByTestId('quote-select-preview').props.children).toBe(BODY.slice(2, 8));
    expect(onSelectionChange).toHaveBeenCalledWith({ start: 2, end: 8 });
    expect(getByTestId('quote-select-confirm').props.accessibilityState.disabled).toBeFalsy();

    await act(async () => {
      fireEvent.press(getByTestId('quote-select-confirm'));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('QuoteSelectionSurface -- non-BMP selection', () => {
  const EMOJI_BODY = '\u{1F3B8} solo riff';

  it('converts a leading-astral UTF-16 selection to code points and previews the raw slice', () => {
    const { getByTestId, onSelectionChange } = renderSurface({ body: EMOJI_BODY });
    const input = getByTestId('quote-select-input');

    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 0, end: 2 } } });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ start: 0, end: 1 });
    expect(getByTestId('quote-select-preview').props.children).toBe(EMOJI_BODY.slice(0, 2));
  });

  it('converts a straddling UTF-16 span to code points and previews the raw slice', () => {
    const { getByTestId, onSelectionChange } = renderSurface({ body: EMOJI_BODY });
    const input = getByTestId('quote-select-input');

    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 0, end: 7 } } });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ start: 0, end: 6 });
    expect(getByTestId('quote-select-preview').props.children).toBe(EMOJI_BODY.slice(0, 7));
  });
});

describe('QuoteSelectionSurface -- collapsing a selection', () => {
  it('removes the preview and disables confirm again', () => {
    const { getByTestId, queryByTestId } = renderSurface();
    const input = getByTestId('quote-select-input');

    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 2, end: 8 } } });
    expect(getByTestId('quote-select-preview')).toBeTruthy();

    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 4, end: 4 } } });
    expect(queryByTestId('quote-select-preview')).toBeNull();
    expect(getByTestId('quote-select-confirm').props.accessibilityState.disabled).toBe(true);
  });
});

describe('QuoteSelectionSurface -- cancel', () => {
  it('fires onCancel and never mutates the read-only body value', () => {
    const { getByTestId, onCancel } = renderSurface();
    const input = getByTestId('quote-select-input');
    expect(input.props.value).toBe(BODY);

    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 2, end: 8 } } });
    expect(input.props.value).toBe(BODY);

    fireEvent.press(getByTestId('quote-select-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(input.props.value).toBe(BODY);
  });
});

describe('QuoteSelectionSurface -- custom testID prefix', () => {
  it('prefixes every element with the given testID', () => {
    const { getByTestId } = renderSurface({ testID: 'src-1' });
    expect(getByTestId('src-1-instruction')).toBeTruthy();
    expect(getByTestId('src-1-confirm')).toBeTruthy();
    expect(getByTestId('src-1-confirm-guard')).toBeTruthy();
    expect(getByTestId('src-1-cancel')).toBeTruthy();
    expect(getByTestId('src-1-input')).toBeTruthy();
  });
});

describe('QuoteSelectionSurface -- confirmLabel', () => {
  it('defaults the confirm button label to "Promote selection"', () => {
    const { getByTestId } = renderSurface();
    within(getByTestId('quote-select-confirm')).getByText('Promote selection');
  });

  it('renders the given confirmLabel when provided', () => {
    const { getByTestId } = renderSurface({ confirmLabel: 'Write a note' });
    within(getByTestId('quote-select-confirm')).getByText('Write a note');
  });
});
