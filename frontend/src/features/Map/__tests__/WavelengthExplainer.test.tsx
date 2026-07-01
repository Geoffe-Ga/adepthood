/* eslint-env jest */
/* global describe, it, expect, jest */
// Contract this test pins for the implementer (frontend/src/features/Map/):
//   wavelengthExplainer.ts:
//     export const WAVELENGTH_EXPLAINER = { title: string; markdown: string } as const;
//   WavelengthExplainer.tsx:
//     export default function WavelengthExplainer(props: { visible: boolean; onClose: () => void }): JSX.Element
//     Renders a react-native Modal (transparent, animationType="slide", onRequestClose=onClose).
//     Body content only mounts when visible is true.
//     Scrollable content container: testID="wavelength-explainer".
//     Close affordance: testID="wavelength-explainer-close", accessibilityRole="button".
//     Renders WAVELENGTH_EXPLAINER.markdown via react-native-markdown-display,
//     styled with markdownStyles from '../Course/Course.styles'.
import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

import WavelengthExplainer from '../WavelengthExplainer';
import { WAVELENGTH_EXPLAINER } from '../wavelengthExplainerContent';

const SHAMING_LANGUAGE =
  /\b(better than|worse than|higher\s+self\s+than|superior|inferior|failing|failure|you should|not enough|behind|fall short)\b/i;

describe('WavelengthExplainer', () => {
  it('renders nothing user-visible when not visible', () => {
    const { queryByTestId } = render(<WavelengthExplainer visible={false} onClose={() => {}} />);
    expect(queryByTestId('wavelength-explainer')).toBeNull();
  });

  it('renders the content container when visible', () => {
    const { getByTestId } = render(<WavelengthExplainer visible onClose={() => {}} />);
    expect(getByTestId('wavelength-explainer')).toBeTruthy();
  });

  it('renders the torus/auric-field concept', () => {
    const { getAllByText } = render(<WavelengthExplainer visible onClose={() => {}} />);
    expect(getAllByText(/torus/i).length).toBeGreaterThan(0);
  });

  it('renders the compression-wave concept', () => {
    const { getAllByText } = render(<WavelengthExplainer visible onClose={() => {}} />);
    expect(getAllByText(/compression/i).length).toBeGreaterThan(0);
  });

  it('renders the six-octaves concept', () => {
    const { getAllByText } = render(<WavelengthExplainer visible onClose={() => {}} />);
    expect(getAllByText(/octave/i).length).toBeGreaterThan(0);
  });

  it('renders the chord concept', () => {
    const { getAllByText } = render(<WavelengthExplainer visible onClose={() => {}} />);
    expect(getAllByText(/chord/i).length).toBeGreaterThan(0);
  });

  it('renders the spiral-growing-the-torus concept', () => {
    const { getAllByText } = render(<WavelengthExplainer visible onClose={() => {}} />);
    expect(getAllByText(/spiral/i).length).toBeGreaterThan(0);
  });

  it('calls onClose when the close affordance is pressed', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(<WavelengthExplainer visible onClose={onClose} />);
    fireEvent.press(getByTestId('wavelength-explainer-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('exposes accessibilityRole="button" on the close affordance', () => {
    const { getByTestId } = render(<WavelengthExplainer visible onClose={() => {}} />);
    expect(getByTestId('wavelength-explainer-close').props.accessibilityRole).toBe('button');
  });
});

describe('WAVELENGTH_EXPLAINER copy', () => {
  it('has a non-empty title', () => {
    expect(WAVELENGTH_EXPLAINER.title.length).toBeGreaterThan(0);
  });

  it('contains all five concept keywords in the markdown', () => {
    const markdown = WAVELENGTH_EXPLAINER.markdown.toLowerCase();
    expect(markdown).toMatch(/torus/);
    expect(markdown).toMatch(/spiral/);
    expect(markdown).toMatch(/compression/);
    expect(markdown).toMatch(/octave/);
    expect(markdown).toMatch(/chord/);
  });

  it('never contains shaming or ranking language', () => {
    expect(SHAMING_LANGUAGE.test(WAVELENGTH_EXPLAINER.markdown)).toBe(false);
  });
});
