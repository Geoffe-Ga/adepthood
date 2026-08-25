/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';

import AspectChordControl from '../AspectChordControl';

import { STAGE_ORDER, colors, readableGlyphOn, resolveStageColor } from '@/design/tokens';
import { STAGE_DISPLAY } from '@/features/Map/mapLayout';

/** The controlled value shape the control reports back via onChange. */
interface AspectChordValue {
  primary: number | null;
  secondary: number | null;
}

function renderControl(
  value?: AspectChordValue,
  onChange: (_next: AspectChordValue) => void = jest.fn(),
) {
  return render(<AspectChordControl value={value} onChange={onChange} />);
}

// ---------------------------------------------------------------------------
// Collapsed by default
// ---------------------------------------------------------------------------

describe('AspectChordControl — collapsed by default', () => {
  it('shows the trigger and no primary chips before expanding', () => {
    const { getByTestId, queryByTestId } = renderControl();
    expect(getByTestId('aspect-chord-trigger')).toBeTruthy();
    expect(queryByTestId('aspect-primary-1')).toBeNull();
  });

  it('never fires onChange on mount (nothing pre-selected)', () => {
    const onChange = jest.fn();
    renderControl(undefined, onChange);
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Loaded value (editing a pre-tagged entry)
// ---------------------------------------------------------------------------

describe('AspectChordControl — loaded value', () => {
  it('opens expanded showing the selected primary chip when value.primary is set', () => {
    const { getByTestId, queryByTestId } = renderControl({ primary: 3, secondary: null });
    expect(getByTestId('aspect-primary-3')).toBeTruthy();
    expect(queryByTestId('aspect-chord-trigger')).toBeNull();
  });

  it('never fires onChange on mount for a pre-tagged value', () => {
    const onChange = jest.fn();
    renderControl({ primary: 3, secondary: null }, onChange);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('expands to reveal the loaded chip when the value arrives after mount (edit load)', () => {
    const onChange = jest.fn();
    const { getByTestId, queryByTestId, rerender } = render(
      <AspectChordControl value={{ primary: null, secondary: null }} onChange={onChange} />,
    );
    expect(getByTestId('aspect-chord-trigger')).toBeTruthy();
    rerender(<AspectChordControl value={{ primary: 3, secondary: null }} onChange={onChange} />);
    expect(getByTestId('aspect-primary-3')).toBeTruthy();
    expect(queryByTestId('aspect-chord-trigger')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Expanding reveals primary chips
// ---------------------------------------------------------------------------

describe('AspectChordControl — expanding', () => {
  it('tapping the trigger reveals all ten primary aspect chips', () => {
    const { getByTestId } = renderControl();
    fireEvent.press(getByTestId('aspect-chord-trigger'));
    for (let n = 1; n <= 10; n += 1) {
      expect(getByTestId(`aspect-primary-${n}`)).toBeTruthy();
    }
  });

  it('uses STAGE_DISPLAY labels for the primary chips, not invented copy', () => {
    const { getByTestId, getByText } = renderControl();
    fireEvent.press(getByTestId('aspect-chord-trigger'));
    const stageOne = STAGE_DISPLAY[1];
    if (stageOne === undefined) throw new Error('STAGE_DISPLAY[1] missing');
    expect(getByText(stageOne.persona)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Selecting a primary
// ---------------------------------------------------------------------------

describe('AspectChordControl — selecting a primary', () => {
  it('fires onChange with {primary, secondary: null}', () => {
    const onChange = jest.fn();
    const { getByTestId } = renderControl(undefined, onChange);
    fireEvent.press(getByTestId('aspect-chord-trigger'));
    fireEvent.press(getByTestId('aspect-primary-4'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ primary: 4, secondary: null });
  });
});

// ---------------------------------------------------------------------------
// Secondary chips
// ---------------------------------------------------------------------------

describe('AspectChordControl — secondary chips', () => {
  it('do not appear before a primary is set', () => {
    const { getByTestId, queryByTestId } = renderControl();
    fireEvent.press(getByTestId('aspect-chord-trigger'));
    expect(queryByTestId('aspect-secondary-1')).toBeNull();
  });

  it('appear once a primary is set, excluding the chosen primary', () => {
    const onChange = jest.fn();
    const { getByTestId, queryByTestId, rerender } = render(
      <AspectChordControl value={undefined} onChange={onChange} />,
    );
    fireEvent.press(getByTestId('aspect-chord-trigger'));
    fireEvent.press(getByTestId('aspect-primary-4'));
    rerender(<AspectChordControl value={{ primary: 4, secondary: null }} onChange={onChange} />);
    expect(getByTestId('aspect-secondary-1')).toBeTruthy();
    expect(queryByTestId('aspect-secondary-4')).toBeNull();
  });

  it('fires onChange with {primary, secondary} when a secondary chip is pressed', () => {
    const onChange = jest.fn();
    const { getByTestId, rerender } = render(
      <AspectChordControl value={undefined} onChange={onChange} />,
    );
    fireEvent.press(getByTestId('aspect-chord-trigger'));
    fireEvent.press(getByTestId('aspect-primary-4'));
    rerender(<AspectChordControl value={{ primary: 4, secondary: null }} onChange={onChange} />);
    fireEvent.press(getByTestId('aspect-secondary-9'));
    expect(onChange).toHaveBeenCalledWith({ primary: 4, secondary: 9 });
  });
});

// ---------------------------------------------------------------------------
// Clear affordance
// ---------------------------------------------------------------------------

describe('AspectChordControl — clear affordance', () => {
  it('resets to {primary: null, secondary: null} when pressed', () => {
    const onChange = jest.fn();
    const { getByTestId, rerender } = render(
      <AspectChordControl value={undefined} onChange={onChange} />,
    );
    fireEvent.press(getByTestId('aspect-chord-trigger'));
    fireEvent.press(getByTestId('aspect-primary-2'));
    rerender(<AspectChordControl value={{ primary: 2, secondary: null }} onChange={onChange} />);
    fireEvent.press(getByTestId('aspect-chord-clear'));
    expect(onChange).toHaveBeenCalledWith({ primary: null, secondary: null });
  });

  it('stays expanded after clearing an edit-loaded chord (no snap back to the trigger)', () => {
    const onChange = jest.fn();
    const { getByTestId, queryByTestId, rerender } = render(
      <AspectChordControl value={{ primary: 3, secondary: null }} onChange={onChange} />,
    );
    // Opened expanded via the loaded value, without ever tapping the trigger.
    fireEvent.press(getByTestId('aspect-chord-clear'));
    // Host clears the chord and re-renders; the control must remain open so the
    // writer can immediately re-pick instead of being bounced mid-edit.
    rerender(<AspectChordControl value={{ primary: null, secondary: null }} onChange={onChange} />);
    expect(getByTestId('aspect-primary-1')).toBeTruthy();
    expect(queryByTestId('aspect-chord-trigger')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Disabled while expanded (assistive tech announces chips as disabled)
// ---------------------------------------------------------------------------

describe('AspectChordControl — disabled while expanded', () => {
  it('marks every offered secondary chip disabled for assistive tech', () => {
    // The secondary is unchosen, so its whole row is on offer and every chip of
    // it must announce itself inert. Stage 1 is the primary, so it is omitted.
    const { getByTestId } = render(
      <AspectChordControl value={{ primary: 1, secondary: null }} onChange={jest.fn()} disabled />,
    );
    for (let n = 2; n <= 10; n += 1) {
      expect(getByTestId(`aspect-secondary-${n}`).props.accessibilityState.disabled).toBe(true);
    }
  });

  it('marks the chosen primary chip and its Change disabled for assistive tech', () => {
    const { getByTestId } = render(
      <AspectChordControl value={{ primary: 1, secondary: null }} onChange={jest.fn()} disabled />,
    );
    expect(getByTestId('aspect-primary-1').props.accessibilityState.disabled).toBe(true);
    expect(getByTestId('aspect-primary-change').props.accessibilityState.disabled).toBe(true);
  });

  it('marks the Clear control disabled for assistive tech', () => {
    const { getByTestId } = render(
      <AspectChordControl value={{ primary: 1, secondary: null }} onChange={jest.fn()} disabled />,
    );
    expect(getByTestId('aspect-chord-clear').props.accessibilityState.disabled).toBe(true);
  });

  it('marks the collapse control disabled for assistive tech', () => {
    const { getByTestId } = render(
      <AspectChordControl value={{ primary: 1, secondary: null }} onChange={jest.fn()} disabled />,
    );
    expect(getByTestId('aspect-chord-collapse').props.accessibilityState.disabled).toBe(true);
  });

  it('leaves the chips enabled for assistive tech when not disabled', () => {
    const { getByTestId } = render(
      <AspectChordControl value={{ primary: 1, secondary: null }} onChange={jest.fn()} />,
    );
    expect(getByTestId('aspect-primary-1').props.accessibilityState.disabled).toBe(false);
    expect(getByTestId('aspect-chord-clear').props.accessibilityState.disabled).toBe(false);
  });

  it('keeps every new control inert: nothing fires and nothing collapses', () => {
    const onChange = jest.fn();
    const { getByTestId, queryByTestId } = render(
      <AspectChordControl value={{ primary: 1, secondary: null }} onChange={onChange} disabled />,
    );
    fireEvent.press(getByTestId('aspect-chord-collapse'));
    fireEvent.press(getByTestId('aspect-primary-change'));
    fireEvent.press(getByTestId('aspect-primary-1'));
    expect(onChange).not.toHaveBeenCalled();
    // Neither the collapse nor the reopen took effect.
    expect(queryByTestId('aspect-chord-trigger')).toBeNull();
    expect(queryByTestId('aspect-primary-2')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Collapsing back to the trigger
// ---------------------------------------------------------------------------

describe('AspectChordControl — collapse affordance', () => {
  it('returns the control to its compact trigger after Clear', () => {
    const onChange = jest.fn();
    const { getByTestId, queryByTestId, rerender } = render(
      <AspectChordControl value={{ primary: 3, secondary: null }} onChange={onChange} />,
    );
    fireEvent.press(getByTestId('aspect-chord-clear'));
    rerender(<AspectChordControl value={{ primary: null, secondary: null }} onChange={onChange} />);
    // Clear alone leaves the writer on the chips (the mid-edit latch); the
    // separate collapse is what gives the writing column its space back.
    fireEvent.press(getByTestId('aspect-chord-collapse'));
    expect(getByTestId('aspect-chord-trigger')).toBeTruthy();
    expect(queryByTestId('aspect-primary-1')).toBeNull();
  });

  it('collapses with a chord still set, and names that chord on the trigger', () => {
    const primary = STAGE_DISPLAY[5];
    const secondary = STAGE_DISPLAY[2];
    if (primary === undefined || secondary === undefined) throw new Error('STAGE_DISPLAY missing');
    const { getByTestId } = renderControl({ primary: 5, secondary: 2 });
    fireEvent.press(getByTestId('aspect-chord-collapse'));
    const trigger = getByTestId('aspect-chord-trigger');
    expect(trigger.props.accessibilityLabel).toContain(primary.persona);
    expect(trigger.props.accessibilityLabel).toContain(secondary.persona);
  });

  it('reopens on the trigger after collapsing', () => {
    const { getByTestId } = renderControl({ primary: 3, secondary: null });
    fireEvent.press(getByTestId('aspect-chord-collapse'));
    fireEvent.press(getByTestId('aspect-chord-trigger'));
    expect(getByTestId('aspect-primary-3')).toBeTruthy();
  });

  it('keeps the untagged trigger on its declinable invitation', () => {
    const { getByTestId } = renderControl();
    expect(getByTestId('aspect-chord-trigger').props.accessibilityLabel).toBe(
      'Name an Aspect (optional)',
    );
  });
});

// ---------------------------------------------------------------------------
// Density: a chosen voice folds down to its choice
// ---------------------------------------------------------------------------

describe('AspectChordControl — expanded footprint', () => {
  it('drops the other nine primary chips once a primary is chosen', () => {
    const { getByTestId, queryByTestId } = renderControl({ primary: 4, secondary: null });
    expect(getByTestId('aspect-primary-4')).toBeTruthy();
    for (const stage of [1, 2, 3, 5, 6, 7, 8, 9, 10]) {
      expect(queryByTestId(`aspect-primary-${stage}`)).toBeNull();
    }
  });

  it('leaves exactly the two chosen chips standing on a full chord', () => {
    const { queryByTestId } = renderControl({ primary: 4, secondary: 9 });
    const standing: string[] = [];
    for (let stage = 1; stage <= 10; stage += 1) {
      if (queryByTestId(`aspect-primary-${stage}`) !== null) standing.push(`primary-${stage}`);
      if (queryByTestId(`aspect-secondary-${stage}`) !== null) standing.push(`secondary-${stage}`);
    }
    expect(standing).toEqual(['primary-4', 'secondary-9']);
  });

  it('reopens the whole primary row on Change', () => {
    const { getByTestId } = renderControl({ primary: 4, secondary: null });
    fireEvent.press(getByTestId('aspect-primary-change'));
    for (let stage = 1; stage <= 10; stage += 1) {
      expect(getByTestId(`aspect-primary-${stage}`)).toBeTruthy();
    }
  });

  it('reopens the whole secondary row on Change, still omitting the primary', () => {
    const { getByTestId, queryByTestId } = renderControl({ primary: 4, secondary: 9 });
    fireEvent.press(getByTestId('aspect-secondary-change'));
    expect(getByTestId('aspect-secondary-1')).toBeTruthy();
    expect(queryByTestId('aspect-secondary-4')).toBeNull();
  });

  it('folds the row back down once the writer re-picks', () => {
    const onChange = jest.fn();
    const { getByTestId, queryByTestId, rerender } = render(
      <AspectChordControl value={{ primary: 4, secondary: null }} onChange={onChange} />,
    );
    fireEvent.press(getByTestId('aspect-primary-change'));
    fireEvent.press(getByTestId('aspect-primary-7'));
    rerender(<AspectChordControl value={{ primary: 7, secondary: null }} onChange={onChange} />);
    expect(getByTestId('aspect-primary-7')).toBeTruthy();
    expect(queryByTestId('aspect-primary-1')).toBeNull();
  });

  it('names the Change affordances for assistive tech', () => {
    const { getByTestId } = renderControl({ primary: 4, secondary: 9 });
    expect(getByTestId('aspect-primary-change').props.accessibilityLabel).toBe(
      'Change Primary Aspect',
    );
    expect(getByTestId('aspect-secondary-change').props.accessibilityLabel).toBe(
      'Change Secondary Aspect',
    );
  });
});

// ---------------------------------------------------------------------------
// Colour: the one per-stage palette, not a second one
// ---------------------------------------------------------------------------

/** WCAG relative luminance of a #rrggbb color. */
const luminance = (hex: string): number => {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`not a 6-digit hex: ${hex}`);
  const channels = [match[1], match[2], match[3]].map((pair) => {
    const c = Number.parseInt(pair!, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
};

const contrast = (a: string, b: string): number => {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

const AA_NORMAL = 4.5;

const flatViewStyle = (element: { props: { style?: StyleProp<ViewStyle> } }): ViewStyle =>
  StyleSheet.flatten(element.props.style) ?? {};

const flatTextStyle = (element: { props: { style?: StyleProp<TextStyle> } }): TextStyle =>
  StyleSheet.flatten(element.props.style) ?? {};

describe('AspectChordControl — stage colour', () => {
  it('fills each chosen chip from the app-wide per-stage palette', () => {
    for (let stage = 1; stage <= 10; stage += 1) {
      const { getByTestId, unmount } = renderControl({ primary: stage, secondary: null });
      expect(flatViewStyle(getByTestId(`aspect-primary-${stage}`)).backgroundColor).toBe(
        resolveStageColor(STAGE_ORDER[stage - 1]),
      );
      unmount();
    }
  });

  it('renders the Status Seeker orange the report asked for', () => {
    // Stage 5 is the Orange position of the ten. The hex belongs to the shared
    // palette; naming one here would be the second list this guards against.
    expect(STAGE_ORDER[4]).toBe('Orange');
    const { getByTestId } = renderControl({ primary: 5, secondary: null });
    expect(flatViewStyle(getByTestId('aspect-primary-5')).backgroundColor).toBe(
      resolveStageColor('Orange'),
    );
  });

  it('carries the stage colour on an unchosen chip without filling it', () => {
    const { getByTestId } = renderControl();
    fireEvent.press(getByTestId('aspect-chord-trigger'));
    const style = flatViewStyle(getByTestId('aspect-primary-5'));
    // No fill: the ink-soft label keeps the paper ground it was audited on.
    expect(style.backgroundColor).toBeUndefined();
    expect(style.borderColor).not.toBe(colors.paper.hairline);
  });

  it('keeps every chosen chip label legible on the fill behind it', () => {
    for (let stage = 1; stage <= 10; stage += 1) {
      const { getByTestId, unmount } = renderControl({ primary: stage, secondary: null });
      const fill = flatViewStyle(getByTestId(`aspect-primary-${stage}`)).backgroundColor as string;
      const labelColor = flatTextStyle(getByTestId(`aspect-primary-${stage}-label`))
        .color as string;
      expect(labelColor).toBe(readableGlyphOn(fill));
      expect(contrast(labelColor, fill)).toBeGreaterThanOrEqual(AA_NORMAL);
      unmount();
    }
  });

  it('keeps an unchosen chip label legible on the paper it sits on', () => {
    const { getByTestId } = renderControl();
    fireEvent.press(getByTestId('aspect-chord-trigger'));
    const labelColor = flatTextStyle(getByTestId('aspect-primary-5-label')).color as string;
    expect(contrast(labelColor, colors.paper.background)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('marks the chosen chip by more than colour', () => {
    const persona = STAGE_DISPLAY[5];
    if (persona === undefined) throw new Error('STAGE_DISPLAY[5] missing');
    const { getByTestId } = renderControl({ primary: 5, secondary: null });
    const chip = getByTestId('aspect-primary-5');
    expect(chip.props.accessibilityState.selected).toBe(true);
    // A reader who cannot tell the ten hues apart still sees the mark, and the
    // accessible name stays the persona alone.
    expect(getByTestId('aspect-primary-5-label').props.children).toBe(`✓ ${persona.persona}`);
    expect(chip.props.accessibilityLabel).toBe(persona.persona);
  });
});
