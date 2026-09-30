import { describe, expect, it } from '@jest/globals';
import { render, within } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { type as typeRamp } from '../../../design/tokens';
import { ScreenHeader } from '../ScreenHeader';

/** The window width jest-expo reports, so the default face can be pinned. */
const JEST_WINDOW_WIDTH = 750;

/**
 * ``titleHidden`` (#2962): navigation paints the title, so the header paints
 * only its eyebrow and lead and keeps one header node named by the title.
 */
describe('ScreenHeader titleHidden', () => {
  const props = { eyebrow: 'Your account', title: 'Settings', lead: 'Manage it.' } as const;

  it('does not paint the title, and keeps exactly one header named by it', () => {
    const { queryByText, getAllByRole } = render(<ScreenHeader {...props} titleHidden />);
    expect(queryByText('Settings')).toBeNull();
    expect(getAllByRole('header')).toHaveLength(1);
    expect(getAllByRole('header', { name: 'Settings' })).toHaveLength(1);
  });

  it('keeps the eyebrow and lead as ordinary text outside the header node', () => {
    const { getByText, getByRole } = render(<ScreenHeader {...props} titleHidden />);
    const host = getByRole('header', { name: 'Settings' });
    expect(getByText('YOUR ACCOUNT')).toBeTruthy();
    expect(getByText('Manage it.')).toBeTruthy();
    expect(within(host).queryByText('YOUR ACCOUNT')).toBeNull();
    expect(within(host).queryByText('Manage it.')).toBeNull();
    expect(host.props.children).toBeUndefined();
    expect(host.props.accessibilityHint).toBeUndefined();
  });

  it('adds no focus target', () => {
    const { getByRole } = render(<ScreenHeader {...props} titleHidden />);
    const host = getByRole('header', { name: 'Settings' });
    expect(host.props.tabIndex).toBeUndefined();
    expect(host.props.focusable).toBeUndefined();
  });

  it('keeps the header node with neither eyebrow nor lead', () => {
    const { getAllByRole, queryByText } = render(<ScreenHeader title="Settings" titleHidden />);
    expect(getAllByRole('header', { name: 'Settings' })).toHaveLength(1);
    expect(queryByText('Settings')).toBeNull();
  });

  it('names the host testID after the header testID', () => {
    const { getByTestId } = render(<ScreenHeader {...props} titleHidden testID="hub-header" />);
    expect(getByTestId('hub-header-title').props.accessibilityRole).toBe('header');
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
