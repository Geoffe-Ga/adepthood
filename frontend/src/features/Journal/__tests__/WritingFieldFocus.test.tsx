/* eslint-env jest */
import { describe, it, expect, jest } from '@jest/globals';
import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

import SearchBar from '../SearchBar';
import TranscriptionPreview from '../TranscriptionPreview';

import { writingField, writingFieldFocus } from '@/design/tokens';
import type { CapturePage } from '@/features/Journal/captureSession';
import type { TranscriptionBlock } from '@/features/Journal/transcriptionRun';

/**
 * Every journal field a writer types into wears the shared focus treatment:
 * ``writingFieldFocus`` (which drops the browser's blue ring on web) plus the
 * accent caret that takes over as the focus signal.
 *
 * These specs assert the fragment by *identity* rather than by resolved value:
 * the fragment is empty on native, and Jest renders as ``ios``, so its contents
 * are only observable on web — that half is covered by
 * ``design/__tests__/writingFieldFocus.test.ts``. What is worth pinning here is
 * that each field opts in at all.
 */
function expectWritingFieldTreatment(input: {
  props: { style?: unknown; selectionColor?: string; cursorColor?: string };
}): void {
  const style = Array.isArray(input.props.style) ? input.props.style : [input.props.style];
  expect(style).toContain(writingFieldFocus);
  expect(input.props.selectionColor).toBe(writingField.caret);
  expect(input.props.cursorColor).toBe(writingField.caret);
}

describe('journal search box', () => {
  it('drops the browser focus ring and carries the accent caret', () => {
    const { getByTestId } = render(<SearchBar onSearch={jest.fn()} />);
    fireEvent.press(getByTestId('search-toggle'));
    expectWritingFieldTreatment(getByTestId('search-input'));
  });
});

describe('transcribed page editor', () => {
  const page: CapturePage = {
    id: 'p1',
    sourceUri: 'file:///src.jpg',
    uri: 'file:///small.jpg',
    imageBase64: 'zzz',
    byteLength: 3,
    mediaType: 'image/jpeg',
    status: 'ready',
  };
  const block: TranscriptionBlock = {
    id: 'p1',
    status: 'done',
    text: 'A page read from a photograph.',
    edited: false,
    attempt: 1,
    error: null,
  };

  it('drops the browser focus ring and carries the accent caret', () => {
    const { getByTestId } = render(
      <TranscriptionPreview
        pages={[page]}
        blocks={{ p1: block }}
        onEdit={jest.fn()}
        onRetry={jest.fn()}
        onConfirmRedo={jest.fn()}
        onRetake={jest.fn()}
        onRemove={jest.fn()}
        isConfirmingRedo={() => false}
      />,
    );
    expectWritingFieldTreatment(getByTestId('photograph-block-1-input'));
  });
});
