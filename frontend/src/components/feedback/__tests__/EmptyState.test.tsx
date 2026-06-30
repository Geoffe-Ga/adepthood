/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/feedback/EmptyState';

describe('EmptyState', () => {
  it('renders the glyph, a header-role title, and the body', () => {
    const { getByText, getByRole } = render(
      <EmptyState glyph="🧘" title="Nothing yet" body="Add your first one." />,
    );
    // The glyph is decorative and hidden from accessibility.
    expect(getByText('🧘', { includeHiddenElements: true })).toBeTruthy();
    expect(getByText('Add your first one.')).toBeTruthy();
    expect(getByRole('header').props.children).toBe('Nothing yet');
  });

  it('renders an optional CTA slot and fires it', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <EmptyState
        glyph="📓"
        title="Empty"
        body="None."
        cta={<Button label="Add" onPress={onPress} testID="empty-cta" />}
      />,
    );
    fireEvent.press(getByTestId('empty-cta'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('merges a style override (e.g. safe-area insets) onto the container', () => {
    const { getByTestId } = render(
      <EmptyState glyph="x" title="t" body="b" style={{ paddingTop: 47 }} testID="es" />,
    );
    expect(getByTestId('es')).toHaveStyle({ paddingTop: 47 });
  });
});
