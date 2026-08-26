/* eslint-env jest */
import { describe, it, expect, jest } from '@jest/globals';
import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import SearchBar from '../SearchBar';
import TranscriptionPreview from '../TranscriptionPreview';

import { accent, colors, writingField, writingFieldFocus } from '@/design/tokens';
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

  function renderBlock() {
    return render(
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
  }

  it('drops the browser focus ring and carries the accent caret', () => {
    expectWritingFieldTreatment(renderBlock().getByTestId('photograph-block-1-input'));
  });

  /**
   * Unlike the entry's borderless paper fields, this one already draws a
   * hairline box that does NOT change on focus — so dropping the browser ring
   * would leave someone tabbing between blocks with the caret alone. It warms
   * its own border instead, the way ``SearchBar`` does.
   */
  it('warms its own border on focus so the ring it lost is replaced, not just removed', () => {
    const input = renderBlock().getByTestId('photograph-block-1-input');
    expect(StyleSheet.flatten(input.props.style).borderColor).toBe(colors.paper.hairline);

    fireEvent(input, 'focus');
    expect(StyleSheet.flatten(input.props.style).borderColor).toBe(accent.primary);

    fireEvent(input, 'blur');
    expect(StyleSheet.flatten(input.props.style).borderColor).toBe(colors.paper.hairline);
  });
});
