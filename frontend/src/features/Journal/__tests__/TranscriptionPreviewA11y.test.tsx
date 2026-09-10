/* eslint-env jest */
import { describe, it, expect, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';

import type { CapturePage } from '../captureSession';
import TranscriptionPreview from '../TranscriptionPreview';
import type { TranscriptionBlock } from '../transcriptionRun';

/**
 * A multi-page run stacks several identical-looking editors. Sighted writers tell
 * them apart by position on screen; a screen-reader user has only the label, so
 * every field naming itself "this page" leaves them with three fields called the
 * same thing and no way to know which page they are correcting.
 */
function page(id: string): CapturePage {
  return {
    id,
    sourceUri: `file:///${id}-source.jpg`,
    uri: `file:///${id}.jpg`,
    imageBase64: `base64-${id}`,
    byteLength: 8,
    mediaType: 'image/jpeg',
    status: 'ready',
  };
}

function doneBlock(id: string, text: string): TranscriptionBlock {
  return { id, status: 'done', text, edited: false, attempt: 1, error: null };
}

function renderThreeReadPages() {
  const pages = [page('p1'), page('p2'), page('p3')];
  return render(
    <TranscriptionPreview
      pages={pages}
      blocks={{
        p1: doneBlock('p1', 'first'),
        p2: doneBlock('p2', 'second'),
        p3: doneBlock('p3', 'third'),
      }}
      onEdit={jest.fn()}
      onRetry={jest.fn()}
      onConfirmRedo={jest.fn()}
      onRetake={jest.fn()}
      onRemove={jest.fn()}
      isConfirmingRedo={() => false}
    />,
  );
}

describe('TranscriptionPreview — each page editor names its own page', () => {
  it('labels every block input with its page number, in session order', () => {
    const { getByTestId } = renderThreeReadPages();
    expect(getByTestId('photograph-block-1-input').props.accessibilityLabel).toBe(
      'Edit the transcribed text of page 1',
    );
    expect(getByTestId('photograph-block-2-input').props.accessibilityLabel).toBe(
      'Edit the transcribed text of page 2',
    );
    expect(getByTestId('photograph-block-3-input').props.accessibilityLabel).toBe(
      'Edit the transcribed text of page 3',
    );
  });

  it('gives no two editors the same label', () => {
    const { getAllByLabelText, getByTestId } = renderThreeReadPages();
    const labels = ['photograph-block-1-input', 'photograph-block-2-input'].map(
      (testID) => getByTestId(testID).props.accessibilityLabel as string,
    );
    expect(new Set(labels).size).toBe(labels.length);
    // And each label finds exactly the one field it names.
    expect(getAllByLabelText('Edit the transcribed text of page 2')).toHaveLength(1);
  });
});
