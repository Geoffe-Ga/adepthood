/* eslint-env jest */
import { describe, it, expect, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import type { CapturePage } from '../captureSession';
import TranscriptionPreview from '../TranscriptionPreview';
import type { TranscriptionBlock } from '../transcriptionRun';
import type { BlockOverlapNotice } from '../useTranscriptionRun';

import { colors, editorialType } from '@/design/tokens';

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
      overlaps={{}}
      onKeepSeam={jest.fn()}
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

// --- Overlapping screenshots (#2929) ------------------------------------------

/** Transcript words the tree must never carry in a testID or label — made-up
 *  words, so none can collide with the screen's own copy. */
const PAGE_TEXT = {
  p1: 'Zephyrine: quokkabread marmalune',
  p2: 'Zephyrine: quokkabread marmalune, brindlewick',
  p3: 'Ottoline: fennowisp caldergloam',
};

function renderWithOverlaps(
  overlaps: Record<string, BlockOverlapNotice>,
  onKeepSeam: (_earlierId: string, _laterId: string) => void = jest.fn(),
) {
  const pages = [page('p1'), page('p2'), page('p3')];
  return render(
    <TranscriptionPreview
      pages={pages}
      blocks={{
        p1: doneBlock('p1', PAGE_TEXT.p1),
        p2: doneBlock('p2', PAGE_TEXT.p2),
        p3: doneBlock('p3', PAGE_TEXT.p3),
      }}
      onEdit={jest.fn()}
      onRetry={jest.fn()}
      onConfirmRedo={jest.fn()}
      onRetake={jest.fn()}
      onRemove={jest.fn()}
      isConfirmingRedo={() => false}
      overlaps={overlaps}
      onKeepSeam={onKeepSeam}
    />,
  );
}

const P2_REPEATS_THREE = { p2: { earlierId: 'p1', earlierPosition: 1, lineCount: 3 } };

describe('TranscriptionPreview — the repeated-lines notice', () => {
  it('tells the writer, on the later page, how many lines repeat which page', () => {
    const { getByTestId } = renderWithOverlaps(P2_REPEATS_THREE);
    expect(getByTestId('photograph-block-2-overlap').props.children).toBe(
      "The first 3 lines repeat page 1, so they'll appear once when these pages merge.",
    );
  });

  it('uses the singular for one repeated line', () => {
    const { getByTestId } = renderWithOverlaps({
      p3: { earlierId: 'p2', earlierPosition: 2, lineCount: 1 },
    });
    expect(getByTestId('photograph-block-3-overlap').props.children).toBe(
      "The first line repeats page 2, so it'll appear once when these pages merge.",
    );
  });

  it('shows no notice and no Keep action where nothing repeats', () => {
    const { queryByTestId } = renderWithOverlaps(P2_REPEATS_THREE);
    for (const position of [1, 3]) {
      expect(queryByTestId(`photograph-block-${position}-overlap`)).toBeNull();
      expect(queryByTestId(`photograph-block-${position}-overlap-keep`)).toBeNull();
    }
    const none = renderWithOverlaps({});
    expect(none.queryByTestId('photograph-block-2-overlap')).toBeNull();
    expect(none.queryByTestId('photograph-block-2-overlap-keep')).toBeNull();
  });

  it('offers Keep them as a button named for its page, keeping that exact seam', () => {
    const onKeepSeam = jest.fn();
    const { getByRole } = renderWithOverlaps(P2_REPEATS_THREE, onKeepSeam);
    const keep = getByRole('button', { name: 'Keep the repeated lines on page 2' });
    fireEvent.press(keep);
    expect(onKeepSeam).toHaveBeenCalledTimes(1);
    expect(onKeepSeam).toHaveBeenCalledWith('p1', 'p2');
  });

  it('lets a screen reader reach the notice itself', () => {
    const { getByTestId } = renderWithOverlaps(P2_REPEATS_THREE);
    expect(getByTestId('photograph-block-2-overlap').props.accessible).toBe(true);
  });

  it('draws the notice in the quiet Candle & Ink note style', () => {
    const { getByTestId } = renderWithOverlaps(P2_REPEATS_THREE);
    const style = StyleSheet.flatten(getByTestId('photograph-block-2-overlap').props.style);
    expect(style.color).toBe(colors.paper.inkSoft);
    expect(style.fontSize).toBe(editorialType.note.fontSize);
  });

  it('never puts transcript text into a testID or an accessibility label', () => {
    const { UNSAFE_root } = renderWithOverlaps(P2_REPEATS_THREE);
    const words = Object.values(PAGE_TEXT).flatMap((text) => text.split(/[\s,:]+/));
    const risky = words.filter((word) => word.length > 3);
    for (const node of UNSAFE_root.findAll(() => true)) {
      const carried = [node.props.testID, node.props.accessibilityLabel].filter(
        (value): value is string => typeof value === 'string',
      );
      for (const value of carried) {
        for (const word of risky) expect(value).not.toContain(word);
      }
    }
  });
});
