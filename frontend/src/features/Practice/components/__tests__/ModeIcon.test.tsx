/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';
import { Hourglass } from 'lucide-react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';

import ModeIcon, { MODE_ICON_SIZE, MODE_ICON_SLOT } from '../ModeIcon';

import { NAV_ICON_SIZE } from '@/components/drawer';
import { SPACING } from '@/design/tokens';

/**
 * ``ModeIcon`` owns the decorative-icon contract every mode row shares (#2963):
 * one drawn lucide glyph, sized from the nav icon token, hidden from assistive
 * tech so the row's own accessibilityLabel stays its only accessible name.
 */
describe('ModeIcon', () => {
  it('sizes the glyph from the nav icon token and its slot from the spacing scale', () => {
    expect(MODE_ICON_SIZE).toBe(NAV_ICON_SIZE);
    expect(MODE_ICON_SLOT).toBe(NAV_ICON_SIZE + SPACING.sm);
  });

  it('draws the given lucide icon at the shared size, inside a fixed-width slot', () => {
    const view = render(<ModeIcon icon={Hourglass} testID="slot" />);
    expect(view.UNSAFE_getByType(Hourglass).props.size).toBe(MODE_ICON_SIZE);
    const slot = StyleSheet.flatten(
      view.getByTestId('slot', { includeHiddenElements: true }).props.style,
    ) as { width?: number };
    expect(slot.width).toBe(MODE_ICON_SLOT);
  });

  it('is hidden from assistive tech on both platforms, the web included (#3009)', () => {
    const view = render(<ModeIcon icon={Hourglass} testID="slot" />);
    const slot = view.getByTestId('slot', { includeHiddenElements: true });
    // react-native-web reads only aria-hidden; the two native props never reach the DOM.
    expect(slot.props['aria-hidden']).toBe(true);
    expect(slot.props.accessibilityElementsHidden).toBe(true);
    expect(slot.props.importantForAccessibility).toBe('no-hide-descendants');
  });

  it('renders no text, so no glyph can leak into the census or a screen reader', () => {
    const view = render(<ModeIcon icon={Hourglass} testID="slot" />);
    expect(view.UNSAFE_queryAllByType(Text)).toHaveLength(0);
  });
});
