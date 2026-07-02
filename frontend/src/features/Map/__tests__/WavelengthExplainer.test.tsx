/* eslint-env jest */
/* global describe, it, expect, jest */
// Contract this test pins for the implementer (frontend/src/features/Map/):
//   WavelengthExplainer.tsx:
//     export default function WavelengthExplainer(props: { visible: boolean; onClose: () => void }): JSX.Element
//     Renders a react-native Modal (transparent, animationType="slide", onRequestClose=onClose).
//     Body content only mounts when visible is true, under testID="wavelength-explainer".
//     Serves the copy from the vendored content pipeline via the shared
//     ChapterReader with source { kind: 'resource', slug: 'wavelength-explainer' }
//     and wires ChapterReader's onBack to onClose (its back control closes the sheet).
import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

import WavelengthExplainer from '../WavelengthExplainer';

// Mock ChapterReader so this unit test asserts the wiring (source + onBack)
// without exercising the live content fetch — that path is covered by
// ChapterReader's own tests and the backend copy-contract test.
jest.mock('../../Course/ChapterReader', () => {
  const { Pressable: MockPressable, Text: MockText } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({
      source,
      fallbackTitle,
      onBack,
    }: {
      source: { kind: string; slug?: string };
      fallbackTitle: string;
      onBack: () => void;
    }) => (
      <MockPressable testID="reader-back-button" onPress={onBack}>
        <MockText testID="reader-source-kind">{source.kind}</MockText>
        <MockText testID="reader-source-slug">{source.slug ?? ''}</MockText>
        <MockText testID="reader-fallback-title">{fallbackTitle}</MockText>
      </MockPressable>
    ),
  };
});

describe('WavelengthExplainer', () => {
  it('renders nothing user-visible when not visible', () => {
    const { queryByTestId } = render(<WavelengthExplainer visible={false} onClose={() => {}} />);
    expect(queryByTestId('wavelength-explainer')).toBeNull();
  });

  it('renders the content container when visible', () => {
    const { getByTestId } = render(<WavelengthExplainer visible onClose={() => {}} />);
    expect(getByTestId('wavelength-explainer')).toBeTruthy();
  });

  it('reads the vendored wavelength-explainer site resource through ChapterReader', () => {
    const { getByTestId } = render(<WavelengthExplainer visible onClose={() => {}} />);
    expect(getByTestId('reader-source-kind').props.children).toBe('resource');
    expect(getByTestId('reader-source-slug').props.children).toBe('wavelength-explainer');
  });

  it('passes a human-readable fallback title to the reader', () => {
    const { getByTestId } = render(<WavelengthExplainer visible onClose={() => {}} />);
    expect(getByTestId('reader-fallback-title').props.children).toMatch(/wavelength/i);
  });

  it('calls onClose when the reader back control is pressed', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(<WavelengthExplainer visible onClose={onClose} />);
    fireEvent.press(getByTestId('reader-back-button'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
