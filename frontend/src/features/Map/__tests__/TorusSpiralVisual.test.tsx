/* eslint-env jest */
/* global describe, it, expect */
import { render } from '@testing-library/react-native';
import React from 'react';

import TorusSpiralVisual from '../TorusSpiralVisual';

describe('TorusSpiralVisual', () => {
  it('renders the illustration container', () => {
    const { getByTestId } = render(<TorusSpiralVisual />);
    expect(getByTestId('torus-spiral-visual')).toBeTruthy();
  });

  it('exposes an image role for screen readers', () => {
    const { getByTestId } = render(<TorusSpiralVisual />);
    expect(getByTestId('torus-spiral-visual').props.accessibilityRole).toBe('image');
  });

  it('carries a non-empty accessibility label', () => {
    const { getByTestId } = render(<TorusSpiralVisual />);
    expect(getByTestId('torus-spiral-visual').props.accessibilityLabel.length).toBeGreaterThan(0);
  });

  it('is non-interactive so it never blocks the sheet scroll', () => {
    const { getByTestId } = render(<TorusSpiralVisual />);
    expect(getByTestId('torus-spiral-visual').props.pointerEvents).toBe('none');
  });
});
