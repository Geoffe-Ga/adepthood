/* eslint-env jest */
// #3134: the moment a passage is chosen, the floating "Promote selection" pill
// comes to it -- from either span producer -- promotes once per press, and its
// X clears the selection without leaving selection mode.
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, TextInput } from 'react-native';

import { FLOATING_PROMOTE_TEST_ID } from '../FloatingPromoteButton';
import { RESONANCE_BUTTON_CLEARANCE } from '../JournalEntry.styles';
import QuoteSelectionSurface from '../QuoteSelectionSurface';
import { floatingDockStyle } from '../readingSurfaceStyles';
import { useWebSelectionListener } from '../webSelectionListener';

import { SPACING, touchTarget } from '@/design/tokens';

jest.mock('../webSelectionListener', () => ({
  useWebSelectionListener: jest.fn(),
  useInitialFieldSelection: jest.fn(),
}));

const mockedListener = useWebSelectionListener as jest.MockedFunction<
  typeof useWebSelectionListener
>;

const Platform = require('react-native').Platform as { OS: string };

const FAB = FLOATING_PROMOTE_TEST_ID;
const BODY = 'A steady daily walk to the river.';
const WALK_START = BODY.indexOf('walk');
const WALK_END = WALK_START + 'walk'.length;

/** The selection-moving methods each platform's host field exposes, patched onto the mock. */
interface CollapsibleMock {
  setSelection?: jest.Mock;
  setSelectionRange?: jest.Mock;
  focus: jest.Mock;
}

const fieldPrototype = TextInput.prototype as unknown as CollapsibleMock;

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

/** The span producer the surface handed the web listener on its latest render. */
function webEmitSpan(): (startUtf16: number, endUtf16: number) => void {
  const call = mockedListener.mock.calls.at(-1);
  if (call == null) throw new Error('the surface never subscribed the web listener');
  return call[1];
}

function chooseWalk(getByTestId: ReturnType<typeof render>['getByTestId']): void {
  fireEvent(getByTestId('quote-select-input'), 'selectionChange', {
    nativeEvent: { selection: { start: WALK_START, end: WALK_END } },
  });
}

let originalOS: string;

beforeEach(() => {
  originalOS = Platform.OS;
});

afterEach(() => {
  Platform.OS = originalOS;
  delete fieldPrototype.setSelection;
  delete fieldPrototype.setSelectionRange;
});

describe('QuoteSelectionSurface floating confirm -- span producers', () => {
  it('rises from a native onSelectionChange, inside the dock at the surface root', () => {
    const { getByTestId } = renderSurface();
    chooseWalk(getByTestId);
    const dock = getByTestId('quote-select-dock');
    expect(StyleSheet.flatten(dock.props.style)).toEqual(floatingDockStyle);
    expect(dock.props.pointerEvents).toBe('box-none');
    within(dock).getByTestId(FAB);
    within(getByTestId(FAB)).getByText('Promote selection');
  });

  it('rises from a web selectionchange and withdraws when that selection collapses', () => {
    const { getByTestId, queryByTestId } = renderSurface();
    expect(queryByTestId(FAB)).toBeNull();
    act(() => webEmitSpan()(WALK_START, WALK_END));
    expect(getByTestId(FAB)).toBeTruthy();
    expect(getByTestId('quote-select-preview').props.children).toBe('walk');
    act(() => webEmitSpan()(WALK_END, WALK_END));
    expect(queryByTestId(FAB)).toBeNull();
  });
});

describe('QuoteSelectionSurface floating confirm -- promoting', () => {
  it('confirms once however quickly it is pressed again, and shows busy until settled', async () => {
    let settle: () => void = () => undefined;
    const onConfirm = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const { getByTestId } = renderSurface({ onConfirm });
    chooseWalk(getByTestId);

    act(() => {
      fireEvent.press(getByTestId(FAB));
      fireEvent.press(getByTestId(FAB));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(getByTestId(FAB).props.accessibilityState).toEqual(
      expect.objectContaining({ busy: true, disabled: true }),
    );

    await act(async () => settle());
    expect(getByTestId(FAB).props.accessibilityState).toEqual(
      expect.objectContaining({ busy: false, disabled: false }),
    );
    fireEvent.press(getByTestId(FAB));
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });
});

describe('QuoteSelectionSurface floating confirm -- the X clears the selection', () => {
  it('collapses the native selection, withdraws the pill and stays in selection mode', () => {
    fieldPrototype.setSelection = jest.fn();
    const { getByTestId, queryByTestId, onSelectionChange, onConfirm, onCancel } = renderSurface();
    chooseWalk(getByTestId);

    fireEvent.press(getByTestId(`${FAB}-cancel`));

    expect(fieldPrototype.setSelection).toHaveBeenCalledWith(WALK_END, WALK_END);
    expect(onSelectionChange).toHaveBeenLastCalledWith({ start: WALK_END, end: WALK_END });
    expect(queryByTestId('quote-select-preview')).toBeNull();
    expect(queryByTestId(FAB)).toBeNull();
    expect(getByTestId('quote-select-input')).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    // The X is about to leave, so focus goes back to the text, not to the page.
    expect(fieldPrototype.focus).toHaveBeenCalled();
  });

  it('on web collapses the textarea selection the browser holds', () => {
    Platform.OS = 'web';
    fieldPrototype.setSelectionRange = jest.fn();
    const { getByTestId } = renderSurface();
    act(() => webEmitSpan()(WALK_START, WALK_END));

    fireEvent.press(getByTestId(`${FAB}-cancel`));

    expect(fieldPrototype.setSelectionRange).toHaveBeenCalledWith(WALK_END, WALK_END);
  });

  it('names the X for what it does, apart from the footer Cancel that leaves', () => {
    const { getByTestId } = renderSurface();
    chooseWalk(getByTestId);
    expect(getByTestId(`${FAB}-cancel`).props.accessibilityLabel).toBe('Clear selection');
    expect(getByTestId('quote-select-cancel').props.accessibilityLabel).toBe('Cancel promoting');
  });
});

describe('QuoteSelectionSurface floating confirm -- footer', () => {
  it('sets the preview and Cancel on one row, the echo held to a single line', () => {
    const { getByTestId } = renderSurface();
    chooseWalk(getByTestId);
    const row = getByTestId('quote-select-footer-row');
    expect(StyleSheet.flatten(row.props.style).flexDirection).toBe('row');
    within(row).getByTestId('quote-select-preview');
    within(row).getByTestId('quote-select-cancel');
    expect(getByTestId('quote-select-preview').props.numberOfLines).toBe(1);
  });

  it('keeps Cancel on the same trailing edge before any passage is chosen', () => {
    const { getByTestId } = renderSurface();
    within(getByTestId('quote-select-footer-row')).getByTestId('quote-select-cancel');
  });
});

describe('QuoteSelectionSurface floating confirm -- the band the pill floats in', () => {
  it('reserves room between the field and the footer, so the pill never lies over text that cannot scroll clear of it', () => {
    const { getByTestId, toJSON } = renderSurface();
    const reserve = StyleSheet.flatten(getByTestId('quote-select-pill-reserve').props.style);
    const footer = StyleSheet.flatten(getByTestId('quote-select-footer').props.style);
    const row = StyleSheet.flatten(getByTestId('quote-select-footer-row').props.style);
    const footerHeight =
      Number(row.paddingTop) + touchTarget.minimum + Number(footer.paddingBottom);
    // Reserve and footer together reach past the pill's top (its lift plus its
    // height) by a breath, and no further: no text under it, no dead band.
    const pillTop = RESONANCE_BUTTON_CLEARANCE + touchTarget.minimum;
    const reach = Number(reserve.height) + footerHeight;
    expect(reach).toBeGreaterThan(pillTop);
    expect(reach).toBeLessThanOrEqual(pillTop + SPACING.md);
    const tree = JSON.stringify(toJSON());
    const at = (id: string) => tree.indexOf(`"${id}"`);
    expect(at('quote-select-input')).toBeLessThan(at('quote-select-pill-reserve'));
    expect(at('quote-select-pill-reserve')).toBeLessThan(at('quote-select-footer'));
    expect(at('quote-select-footer')).toBeLessThan(at('quote-select-dock'));
  });
});
