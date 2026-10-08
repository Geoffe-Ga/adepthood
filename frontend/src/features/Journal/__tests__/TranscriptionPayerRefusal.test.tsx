/* eslint-env jest */
import { describe, it, expect, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';

import type { CapturePage } from '../captureSession';
import TranscriptionPreview from '../TranscriptionPreview';
import { TERMINAL_ERROR_KINDS, type TranscriptionBlock } from '../transcriptionRun';

import type { TranscriptionErrorKind } from '@/api';

/**
 * A page read with no personal key and nothing to pay with is refused before
 * anything is charged (#3096). The refusal is a dead end unless the copy names
 * the way out, so both payer refusals must say what to do -- add credits or add a
 * key -- and that nothing was spent.
 */
function page(): CapturePage {
  return {
    id: 'p1',
    sourceUri: 'file:///p1-source.jpg',
    uri: 'file:///p1.jpg',
    imageBase64: 'base64-p1',
    byteLength: 8,
    mediaType: 'image/jpeg',
    status: 'ready',
  };
}

function failedBlock(error: TranscriptionErrorKind): TranscriptionBlock {
  return { id: 'p1', status: 'failed', text: '', edited: false, attempt: 1, error };
}

function renderFailed(error: TranscriptionErrorKind) {
  return render(
    <TranscriptionPreview
      pages={[page()]}
      blocks={{ p1: failedBlock(error) }}
      onEdit={jest.fn()}
      onRetry={jest.fn()}
      onConfirmRedo={jest.fn()}
      onRetake={jest.fn()}
      onRemove={jest.fn()}
      isConfirmingRedo={() => false}
      overlaps={{}}
      onKeepSeam={jest.fn()}
    />,
  );
}

describe('TranscriptionPreview — a page nobody can pay for says how to proceed', () => {
  it('a keyless refusal points at Settings for a key and offers no retry', () => {
    const { getByTestId, queryByTestId } = renderFailed('key_required');

    const copy = String(getByTestId('photograph-block-1-error').props.children);
    expect(copy).toMatch(/API key/u);
    expect(copy).toMatch(/Settings/u);
    expect(copy).toMatch(/nothing was charged/iu);
    // A re-read cannot succeed until a key exists, so Retry would be a false move.
    expect(queryByTestId('photograph-block-1-retry')).toBeNull();
    expect(getByTestId('photograph-block-1-remove')).toBeTruthy();
  });

  it('an empty wallet names both remedies: credits, or a key of your own', () => {
    const { getByTestId } = renderFailed('wallet_exhausted');

    const copy = String(getByTestId('photograph-block-1-error').props.children);
    expect(copy).toMatch(/credits/iu);
    expect(copy).toMatch(/API key/u);
    expect(copy).toMatch(/nothing was charged/iu);
  });

  it('treats a missing key as terminal for the whole run', () => {
    expect(TERMINAL_ERROR_KINDS.has('key_required')).toBe(true);
  });
});
