/* eslint-env jest */
// RED: `QuoteSelectionSurface` does not yet render an instruction line, a live
// preview, a guarded "Promote selection" Button, or an empty-tap hint -- every
// testID below is missing until the implementation-specialist adds them.
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import QuoteSelectionSurface, { SELECTION_FIELD_MIN_HEIGHT } from '../QuoteSelectionSurface';
import { pinnedFooterStyle } from '../readingSurfaceStyles';
import { buildSelectionSurfaceCopy } from '../selectionSurfaceCopy';

import { accent, colors, editorialType, writingFieldFocus } from '@/design/tokens';

const Platform = require('react-native').Platform as { OS: string };

const BODY = 'A steady daily walk to the river.';

// The jest preset mounts on ios, so the default-platform pins below are the
// native long-press wording; ``selectionSurfaceCopy.test.ts`` pins the literals.
const { instruction: INSTRUCTION_COPY, emptyHint: EMPTY_HINT_COPY } =
  buildSelectionSurfaceCopy('ios');

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
    expect(getByTestId('quote-select-confirm-guard').props.disabled).toBeUndefined();
    expect(getByTestId('quote-select-confirm-guard').props.onPress).toBeUndefined();

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

describe('QuoteSelectionSurface -- platform-appropriate instruction', () => {
  let originalOS: string;

  beforeEach(() => {
    originalOS = Platform.OS;
  });

  afterEach(() => {
    Platform.OS = originalOS;
  });

  it('on web neither the instruction nor the empty hint says touch and hold', () => {
    Platform.OS = 'web';
    const { getByTestId } = renderSurface();
    expect(getByTestId('quote-select-instruction').props.children).not.toMatch(/touch and hold/i);
    fireEvent.press(getByTestId('quote-select-confirm-guard'));
    expect(getByTestId('quote-select-hint').props.children).not.toMatch(/touch and hold/i);
  });

  it('on ios the instruction and the empty hint keep the long-press wording', () => {
    Platform.OS = 'ios';
    const { getByTestId } = renderSurface();
    expect(getByTestId('quote-select-instruction').props.children).toBe(INSTRUCTION_COPY);
    fireEvent.press(getByTestId('quote-select-confirm-guard'));
    expect(getByTestId('quote-select-hint').props.children).toBe(EMPTY_HINT_COPY);
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

describe('QuoteSelectionSurface -- edge whitespace (#2891)', () => {
  it('emits the trimmed span a double-click "word " stores, and previews that', () => {
    const { getByTestId, onSelectionChange } = renderSurface();
    const input = getByTestId('quote-select-input');
    const start = BODY.indexOf('daily');
    fireEvent(input, 'selectionChange', {
      nativeEvent: { selection: { start: start - 1, end: start + 'daily '.length } },
    });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ start, end: start + 'daily'.length });
    expect(getByTestId('quote-select-preview').props.children).toBe('daily');
  });

  it('treats a whitespace-only selection as nothing chosen', () => {
    const { getByTestId, queryByTestId } = renderSurface({ body: 'one   two' });
    fireEvent(getByTestId('quote-select-input'), 'selectionChange', {
      nativeEvent: { selection: { start: 3, end: 6 } },
    });
    expect(queryByTestId('quote-select-preview')).toBeNull();
    expect(getByTestId('quote-select-confirm').props.accessibilityState.disabled).toBe(true);
  });
});

describe('QuoteSelectionSurface -- phone layout (#2952)', () => {
  it('attaches the writing-field focus fragment so no browser ring frames the field', () => {
    const { getByTestId } = renderSurface();
    expect(getByTestId('quote-select-input').props.style).toContain(writingFieldFocus);
  });

  it('grows with its content instead of keeping the blank page floor or an inner scroll', () => {
    const { getByTestId } = renderSurface();
    const input = getByTestId('quote-select-input');
    const before = StyleSheet.flatten(input.props.style);
    expect(before.minHeight).toBe(SELECTION_FIELD_MIN_HEIGHT);
    expect(before.flexGrow).toBeUndefined();
    fireEvent(input, 'contentSizeChange', { nativeEvent: { contentSize: { height: 900 } } });
    expect(StyleSheet.flatten(getByTestId('quote-select-input').props.style).height).toBe(900);
  });

  it('takes focus when it opens, so the control that opened it vanishing drops nothing on the page', () => {
    const { getByTestId } = renderSurface();
    expect(getByTestId('quote-select-input').props.autoFocus).toBe(true);
  });

  it('marks focus with an accent rule in place of the browser ring, and clears it on blur', () => {
    const { getByTestId } = renderSurface();
    const ruleColor = () =>
      StyleSheet.flatten(getByTestId('quote-select-input').props.style).borderLeftColor;
    expect(ruleColor()).toBe('transparent');
    fireEvent(getByTestId('quote-select-input'), 'focus');
    expect(ruleColor()).toBe(accent.primary);
    fireEvent(getByTestId('quote-select-input'), 'blur');
    expect(ruleColor()).toBe('transparent');
  });

  it('keeps the preview, actions and hint together in one footer pinned to the viewport', () => {
    const { getByTestId } = renderSurface();
    const footer = getByTestId('quote-select-footer');
    expect(footer.props.style).toContain(pinnedFooterStyle);
    const flat = StyleSheet.flatten(footer.props.style);
    expect(flat.backgroundColor).toBe(colors.paper.background);
    within(footer).getByTestId('quote-select-confirm');
    within(footer).getByTestId('quote-select-cancel');
    fireEvent.press(getByTestId('quote-select-confirm-guard'));
    within(footer).getByTestId('quote-select-hint');
    fireEvent(getByTestId('quote-select-input'), 'selectionChange', {
      nativeEvent: { selection: { start: 0, end: 8 } },
    });
    within(getByTestId('quote-select-footer')).getByTestId('quote-select-preview');
  });
});

// #2883: inside the sources panel a long body on native would push the actions
// out of the sheet, so the panel can bound the field and let it scroll inside.
describe('QuoteSelectionSurface -- bounded field (#2883)', () => {
  it('grows unbounded and never scrolls inside when no bound is given (read mode)', () => {
    const { getByTestId } = renderSurface();
    const input = getByTestId('quote-select-input');
    expect(StyleSheet.flatten(input.props.style).maxHeight).toBeUndefined();
    expect(input.props.scrollEnabled).toBe(false);
  });

  it('caps the field and scrolls inside it when a bound is given, the actions after it', () => {
    const { getByTestId, toJSON } = renderSurface({ maxFieldHeight: 200 });
    const input = getByTestId('quote-select-input');
    expect(StyleSheet.flatten(input.props.style).maxHeight).toBe(200);
    expect(input.props.scrollEnabled).toBe(true);
    const tree = JSON.stringify(toJSON());
    expect(tree.indexOf('quote-select-input')).toBeLessThan(tree.indexOf('quote-select-confirm'));
    expect(tree.indexOf('quote-select-input')).toBeLessThan(tree.indexOf('quote-select-cancel'));
  });
});

describe('QuoteSelectionSurface -- initial selection (#2883)', () => {
  it('starts with nothing chosen when no initial selection is given', () => {
    const { queryByTestId, getByTestId } = renderSurface();
    expect(queryByTestId('quote-select-preview')).toBeNull();
    expect(getByTestId('quote-select-confirm').props.accessibilityState.disabled).toBe(true);
  });

  it('carries a code-point selection over a remount, converted back to UTF-16 over a non-BMP body', async () => {
    // Two astral characters: code points 2..6 are UTF-16 4..8, so an
    // unconverted seed would echo the second emoji instead of the word.
    const body = '\u{1F600}\u{1F600}went for a daily walk.';
    const { getByTestId, onConfirm } = renderSurface({
      body,
      initialSelection: { start: 2, end: 6 },
    });
    expect(getByTestId('quote-select-preview').props.children).toBe('went');
    const confirm = getByTestId('quote-select-confirm');
    expect(confirm.props.accessibilityState.disabled).toBe(false);
    await act(async () => {
      fireEvent.press(confirm);
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
