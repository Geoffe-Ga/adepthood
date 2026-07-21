/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import PrivacyTierControl, { type PrivacyTier } from '../PrivacyTierControl';

import { touchTarget } from '@/design/tokens';

/**
 * Verifies ``PrivacyTierControl`` behavior:
 * - 3-option segmented control: public / personal / intimate.
 * - Default selection when no ``value`` is supplied is ``personal``.
 * - Each option exposes ``accessibilityState.selected`` truthily.
 * - Choosing ``intimate`` shows a one-line explainer; public/personal do not.
 * - Pressing an option fires ``onChange`` with the new tier string.
 * - All touch targets meet the 44dp ``touchTarget.minimum``.
 * - testIDs: ``privacy-tier-public``, ``privacy-tier-personal``,
 *   ``privacy-tier-intimate``, ``privacy-tier-explainer``.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Smallest of the flattened minHeight/minWidth on an interactive node. */
function StyleSheetMin(node: { props: { style: unknown } }): number {
  const { StyleSheet } = require('react-native') as {
    StyleSheet: { flatten: (_s: unknown) => { minHeight?: number; minWidth?: number } };
  };
  const flat = StyleSheet.flatten(node.props.style);
  return Math.min(flat.minHeight ?? 0, flat.minWidth ?? 0);
}

function renderControl(value?: PrivacyTier, onChange: (_tier: PrivacyTier) => void = jest.fn()) {
  return render(<PrivacyTierControl value={value} onChange={onChange} />);
}

// ---------------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------------

describe('PrivacyTierControl — default state (no value prop)', () => {
  it('renders all three tier options', () => {
    const { getByTestId } = renderControl();
    expect(getByTestId('privacy-tier-public')).toBeTruthy();
    expect(getByTestId('privacy-tier-personal')).toBeTruthy();
    expect(getByTestId('privacy-tier-intimate')).toBeTruthy();
  });

  it('selects personal by default when no value is provided', () => {
    const { getByTestId } = renderControl();
    expect(getByTestId('privacy-tier-personal').props.accessibilityState.selected).toBe(true);
    expect(getByTestId('privacy-tier-public').props.accessibilityState.selected).toBe(false);
    expect(getByTestId('privacy-tier-intimate').props.accessibilityState.selected).toBe(false);
  });

  it('does NOT show the intimate explainer when personal is selected by default', () => {
    const { queryByTestId } = renderControl();
    expect(queryByTestId('privacy-tier-explainer')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Controlled (value prop)
// ---------------------------------------------------------------------------

describe('PrivacyTierControl — controlled via value prop', () => {
  it('selects public when value="public"', () => {
    const { getByTestId } = renderControl('public');
    expect(getByTestId('privacy-tier-public').props.accessibilityState.selected).toBe(true);
    expect(getByTestId('privacy-tier-personal').props.accessibilityState.selected).toBe(false);
    expect(getByTestId('privacy-tier-intimate').props.accessibilityState.selected).toBe(false);
  });

  it('selects intimate when value="intimate"', () => {
    const { getByTestId } = renderControl('intimate');
    expect(getByTestId('privacy-tier-intimate').props.accessibilityState.selected).toBe(true);
    expect(getByTestId('privacy-tier-personal').props.accessibilityState.selected).toBe(false);
    expect(getByTestId('privacy-tier-public').props.accessibilityState.selected).toBe(false);
  });

  it('selects personal when value="personal"', () => {
    const { getByTestId } = renderControl('personal');
    expect(getByTestId('privacy-tier-personal').props.accessibilityState.selected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// onChange wiring
// ---------------------------------------------------------------------------

describe('PrivacyTierControl — onChange', () => {
  it('fires onChange("public") when the public option is pressed', () => {
    const onChange = jest.fn();
    const { getByTestId } = renderControl('personal', onChange);
    fireEvent.press(getByTestId('privacy-tier-public'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('public');
  });

  it('fires onChange("intimate") when the intimate option is pressed', () => {
    const onChange = jest.fn();
    const { getByTestId } = renderControl('personal', onChange);
    fireEvent.press(getByTestId('privacy-tier-intimate'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('intimate');
  });

  it('fires onChange("personal") when the personal option is pressed from public', () => {
    const onChange = jest.fn();
    const { getByTestId } = renderControl('public', onChange);
    fireEvent.press(getByTestId('privacy-tier-personal'));
    expect(onChange).toHaveBeenCalledWith('personal');
  });
});

// ---------------------------------------------------------------------------
// Intimate explainer
// ---------------------------------------------------------------------------

describe('PrivacyTierControl — intimate explainer', () => {
  it('shows the explainer when value="intimate"', () => {
    const { getByTestId } = renderControl('intimate');
    expect(getByTestId('privacy-tier-explainer')).toBeTruthy();
  });

  it('the explainer text mentions AI not receiving it', () => {
    const { getByTestId } = renderControl('intimate');
    const text: string = getByTestId('privacy-tier-explainer').props.children as string;
    // The implementation-specialist must put copy about AI not accessing intimate entries.
    expect(text.toLowerCase()).toMatch(/never sent to ai|not shared with ai|ai won.t|ai cannot/);
  });

  it('does NOT show the explainer when value="personal"', () => {
    const { queryByTestId } = renderControl('personal');
    expect(queryByTestId('privacy-tier-explainer')).toBeNull();
  });

  it('does NOT show the explainer when value="public"', () => {
    const { queryByTestId } = renderControl('public');
    expect(queryByTestId('privacy-tier-explainer')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// showExplainer prop
// ---------------------------------------------------------------------------

describe('PrivacyTierControl — showExplainer prop', () => {
  it('defaults showExplainer to true: intimate shows the explainer when the prop is omitted', () => {
    const { getByTestId } = render(<PrivacyTierControl value="intimate" onChange={jest.fn()} />);
    expect(getByTestId('privacy-tier-explainer')).toBeTruthy();
  });

  it('suppresses the explainer for intimate when showExplainer is false', () => {
    const { queryByTestId } = render(
      <PrivacyTierControl value="intimate" onChange={jest.fn()} showExplainer={false} />,
    );
    expect(queryByTestId('privacy-tier-explainer')).toBeNull();
  });

  it('keeps selection and onChange behavior intact with showExplainer false', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(
      <PrivacyTierControl value="intimate" onChange={onChange} showExplainer={false} />,
    );
    expect(getByTestId('privacy-tier-intimate').props.accessibilityState.selected).toBe(true);
    fireEvent.press(getByTestId('privacy-tier-personal'));
    expect(onChange).toHaveBeenCalledWith('personal');
  });
});

// ---------------------------------------------------------------------------
// Accessibility — labels + selected state
// ---------------------------------------------------------------------------

describe('PrivacyTierControl — accessibility', () => {
  it('each option carries a non-empty accessibilityLabel', () => {
    const { getByTestId } = renderControl('personal');
    const publicLabel: string = getByTestId('privacy-tier-public').props.accessibilityLabel;
    const personalLabel: string = getByTestId('privacy-tier-personal').props.accessibilityLabel;
    const intimateLabel: string = getByTestId('privacy-tier-intimate').props.accessibilityLabel;
    expect(publicLabel.length).toBeGreaterThan(0);
    expect(personalLabel.length).toBeGreaterThan(0);
    expect(intimateLabel.length).toBeGreaterThan(0);
  });

  it('every option carries the exact accessibilityRole "radio"', () => {
    const { getByTestId } = renderControl('personal');
    for (const tier of ['public', 'personal', 'intimate'] as const) {
      expect(getByTestId(`privacy-tier-${tier}`).props.accessibilityRole).toBe('radio');
    }
  });

  it('all touch targets meet the 44dp minimum', () => {
    const { getByTestId } = renderControl('personal');
    expect(StyleSheetMin(getByTestId('privacy-tier-public'))).toBeGreaterThanOrEqual(
      touchTarget.minimum,
    );
    expect(StyleSheetMin(getByTestId('privacy-tier-personal'))).toBeGreaterThanOrEqual(
      touchTarget.minimum,
    );
    expect(StyleSheetMin(getByTestId('privacy-tier-intimate'))).toBeGreaterThanOrEqual(
      touchTarget.minimum,
    );
  });
});
