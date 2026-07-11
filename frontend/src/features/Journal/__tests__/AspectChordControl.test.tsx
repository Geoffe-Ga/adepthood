/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import AspectChordControl from '../AspectChordControl';

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
  it('marks every primary chip disabled for assistive tech', () => {
    const { getByTestId } = render(
      <AspectChordControl value={{ primary: 1, secondary: null }} onChange={jest.fn()} disabled />,
    );
    for (let n = 1; n <= 10; n += 1) {
      expect(getByTestId(`aspect-primary-${n}`).props.accessibilityState.disabled).toBe(true);
    }
  });

  it('marks every secondary chip disabled for assistive tech', () => {
    const { getByTestId } = render(
      <AspectChordControl value={{ primary: 1, secondary: null }} onChange={jest.fn()} disabled />,
    );
    // Secondary chips omit the chosen primary (stage 1), so stage 2 is present.
    expect(getByTestId('aspect-secondary-2').props.accessibilityState.disabled).toBe(true);
  });

  it('marks the Clear control disabled for assistive tech', () => {
    const { getByTestId } = render(
      <AspectChordControl value={{ primary: 1, secondary: null }} onChange={jest.fn()} disabled />,
    );
    expect(getByTestId('aspect-chord-clear').props.accessibilityState.disabled).toBe(true);
  });

  it('leaves the chips enabled for assistive tech when not disabled', () => {
    const { getByTestId } = render(
      <AspectChordControl value={{ primary: 1, secondary: null }} onChange={jest.fn()} />,
    );
    expect(getByTestId('aspect-primary-1').props.accessibilityState.disabled).toBe(false);
    expect(getByTestId('aspect-chord-clear').props.accessibilityState.disabled).toBe(false);
  });
});
