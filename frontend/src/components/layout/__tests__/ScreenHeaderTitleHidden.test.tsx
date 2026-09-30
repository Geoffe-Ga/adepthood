import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { type as typeRamp } from '../../../design/tokens';
import { ScreenHeader } from '../ScreenHeader';

/** The window width jest-expo reports, so the default face can be pinned. */
const JEST_WINDOW_WIDTH = 750;

/**
 * ``titleHidden`` (#2962): the stack header paints the title and is the
 * screen's one heading for it, so the body paints no title and adds no header.
 */
describe('ScreenHeader titleHidden', () => {
  const props = { eyebrow: 'Your account', title: 'Settings', lead: 'Manage it.' } as const;

  it('neither paints the title nor adds a header named by it', () => {
    const { queryByText, queryAllByRole } = render(<ScreenHeader {...props} titleHidden />);
    expect(queryByText('Settings')).toBeNull();
    expect(queryAllByRole('header')).toHaveLength(0);
    expect(queryAllByRole('header', { name: 'Settings' })).toHaveLength(0);
  });

  it('keeps the eyebrow and lead as ordinary text', () => {
    const { getByText } = render(<ScreenHeader {...props} titleHidden />);
    expect(getByText('YOUR ACCOUNT').props.accessibilityRole).toBeUndefined();
    expect(getByText('Manage it.').props.accessibilityRole).toBeUndefined();
  });

  it('adds no header with neither eyebrow nor lead', () => {
    const { queryAllByRole, queryByText } = render(<ScreenHeader title="Settings" titleHidden />);
    expect(queryAllByRole('header')).toHaveLength(0);
    expect(queryByText('Settings')).toBeNull();
  });

  it('still paints the title in the display face as the header when the prop is omitted', () => {
    const { getByText, getAllByRole } = render(<ScreenHeader {...props} />);
    const title = getByText('Settings');
    expect(title.props.accessibilityRole).toBe('header');
    expect(getAllByRole('header')).toHaveLength(1);
    expect(StyleSheet.flatten(title.props.style).fontSize).toBe(
      typeRamp(JEST_WINDOW_WIDTH).display.fontSize,
    );
  });
});
