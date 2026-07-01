/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/feedback/EmptyState';
import { surface } from '@/design/tokens';

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

  // Default-vs-inline guard: the default half locks the full-screen contract the
  // four full-screen consumers depend on; the inline half pins the compact variant.
  it('default mode keeps full-screen centered opaque container (characterization)', () => {
    const { getByTestId } = render(
      <EmptyState glyph="🧘" title="Full" body="Screen." testID="es-default" />,
    );
    const flat = StyleSheet.flatten(
      getByTestId('es-default').props.style as Parameters<typeof StyleSheet.flatten>[0],
    ) as { flex?: number; justifyContent?: string; backgroundColor?: string };
    // These must never regress — Today/Course/Journal/Practice screens depend on them.
    expect(flat.flex).toBe(1);
    expect(flat.justifyContent).toBe('center');
    expect(flat.backgroundColor).toBe(surface.canvas);
  });

  it('inline mode uses flex:0, flex-start alignment, and transparent background', () => {
    const { getByTestId } = render(
      <EmptyState glyph="🪶" title="Inline" body="Footer." inline testID="es-inline" />,
    );
    const flat = StyleSheet.flatten(
      getByTestId('es-inline').props.style as Parameters<typeof StyleSheet.flatten>[0],
    ) as { flex?: number; justifyContent?: string; backgroundColor?: string };
    // Must not be a full-screen block.
    expect(flat.flex).not.toBe(1);
    expect(flat.flex).toBe(0);
    expect(flat.justifyContent).not.toBe('center');
    expect(flat.backgroundColor).toBe('transparent');
  });
});
