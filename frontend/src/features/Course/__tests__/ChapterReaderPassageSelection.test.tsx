/* eslint-env jest */
// RED: ChapterReader does not yet accept onWriteNote / initialScrollOffset,
// so every testID below (reader-write-note-affordance, passage-select-*,
// write-note-dialog-*) is missing until the implementation-specialist wires
// the selection mode + confirm dialog through.
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';

import type * as Api from '../../../api';
import ChapterReader from '../ChapterReader';

jest.mock('../../../api', () => ({
  course: {
    contentBody: jest.fn(),
    siteResourceBody: jest.fn(),
    stageIntroBody: jest.fn(),
  },
}));

const { course: courseApi } = jest.requireMock('../../../api') as {
  course: {
    contentBody: jest.MockedFunction<typeof Api.course.contentBody>;
    siteResourceBody: jest.MockedFunction<typeof Api.course.siteResourceBody>;
    stageIntroBody: jest.MockedFunction<typeof Api.course.stageIntroBody>;
  };
};

const { contentBody: mockContentBody } = courseApi;

// A leading astral emoji shifts every later UTF-16 offset by +1 relative to
// its code-point index -- the fixture pins that "riff" is sliced by code
// points, not raw UTF-16 units.
const NOTE_CHAPTER = {
  title: 'Chapter One',
  content_type: 'chapter',
  body_markdown: '# Chapter One\n\n\u{1F3B8} solo riff selected here.\n',
};

const DIALOG_TITLE = 'Write a note on this passage?';

// UTF-16 selection over "riff" in the stripped body; the surface converts
// this to the code-point span {7, 11}, and a correct Array.from slice reads
// "riff" while a naive raw-index slice of those numbers reads " rif".
const RIFF_SELECTION = { start: 8, end: 12 };

type RenderResult = ReturnType<typeof render>;

async function renderReader(
  overrides: Partial<React.ComponentProps<typeof ChapterReader>> = {},
): Promise<RenderResult & { onBack: jest.Mock; onWriteNote: jest.Mock }> {
  const onBack = jest.fn();
  const onWriteNote = jest.fn();
  const utils = render(
    <ChapterReader
      source={{ kind: 'content', id: 1 }}
      fallbackTitle="x"
      onBack={onBack}
      onWriteNote={onWriteNote}
      {...overrides}
    />,
  );
  await utils.findByTestId('reader-markdown');
  return { ...utils, onBack, onWriteNote };
}

function selectRiff(getByTestId: RenderResult['getByTestId']): void {
  const input = getByTestId('passage-select-input');
  fireEvent(input, 'selectionChange', { nativeEvent: { selection: RIFF_SELECTION } });
}

describe('ChapterReader -- write-note affordance visibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContentBody.mockResolvedValue(NOTE_CHAPTER);
  });

  it('renders the affordance when onWriteNote is provided and the body is non-empty', async () => {
    const { findByTestId } = await renderReader();
    await findByTestId('reader-write-note-affordance');
  });

  it('omits the affordance when onWriteNote is not provided', async () => {
    const { queryByTestId } = await renderReader({ onWriteNote: undefined });
    expect(queryByTestId('reader-write-note-affordance')).toBeNull();
  });

  it('omits the affordance for an empty body even when onWriteNote is provided', async () => {
    mockContentBody.mockResolvedValueOnce({
      title: 'Empty Chapter',
      content_type: 'chapter',
      body_markdown: '   \n',
    });
    const { findByTestId, queryByTestId } = render(
      <ChapterReader
        source={{ kind: 'content', id: 1 }}
        fallbackTitle="x"
        onBack={jest.fn()}
        onWriteNote={jest.fn()}
      />,
    );
    await findByTestId('reader-empty');
    expect(queryByTestId('reader-write-note-affordance')).toBeNull();
  });
});

describe('ChapterReader -- entering and leaving selection mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContentBody.mockResolvedValue(NOTE_CHAPTER);
  });

  it('replaces the markdown view with the passage-select surface on affordance press', async () => {
    const { getByTestId, queryByTestId } = await renderReader();
    fireEvent.press(getByTestId('reader-write-note-affordance'));

    expect(queryByTestId('reader-markdown')).toBeNull();
    expect(getByTestId('passage-select-input')).toBeTruthy();
    within(getByTestId('passage-select-confirm')).getByText('Write a note');
  });

  it('returns to reading on surface cancel without calling onWriteNote', async () => {
    const { getByTestId, queryByTestId, findByTestId, onWriteNote } = await renderReader();
    fireEvent.press(getByTestId('reader-write-note-affordance'));
    fireEvent.press(getByTestId('passage-select-cancel'));

    await findByTestId('reader-markdown');
    expect(queryByTestId('passage-select-input')).toBeNull();
    expect(onWriteNote).not.toHaveBeenCalled();
  });
});

describe('ChapterReader -- the write-note confirm dialog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContentBody.mockResolvedValue(NOTE_CHAPTER);
  });

  async function enterDialog(): Promise<RenderResult & { onWriteNote: jest.Mock }> {
    const utils = await renderReader();
    fireEvent.press(utils.getByTestId('reader-write-note-affordance'));
    selectRiff(utils.getByTestId);
    await act(async () => {
      fireEvent.press(utils.getByTestId('passage-select-confirm'));
    });
    return utils;
  }

  it('opens on a non-empty confirm, titled exactly "Write a note on this passage?"', async () => {
    const { getByTestId, getByText } = await enterDialog();
    expect(getByTestId('write-note-dialog')).toBeTruthy();
    expect(getByText(DIALOG_TITLE)).toBeTruthy();
    within(getByTestId('write-note-dialog-cancel')).getByText('Keep reading');
    within(getByTestId('write-note-dialog-confirm')).getByText('Write a note');
  });

  it('cancel returns to the selection surface without calling onWriteNote', async () => {
    const { getByTestId, queryByTestId, onWriteNote } = await enterDialog();
    fireEvent.press(getByTestId('write-note-dialog-cancel'));

    expect(queryByTestId('write-note-dialog')).toBeNull();
    expect(getByTestId('passage-select-input')).toBeTruthy();
    expect(onWriteNote).not.toHaveBeenCalled();
  });

  it('confirm calls onWriteNote once with the code-point-correct passage and exits to reading', async () => {
    const { getByTestId, queryByTestId, findByTestId, onWriteNote } = await enterDialog();

    await act(async () => {
      fireEvent.press(getByTestId('write-note-dialog-confirm'));
    });

    expect(onWriteNote).toHaveBeenCalledTimes(1);
    expect(onWriteNote).toHaveBeenCalledWith({
      text: 'riff',
      sourceTitle: 'Chapter One',
      scrollOffset: 0,
    });

    await findByTestId('reader-markdown');
    expect(queryByTestId('passage-select-input')).toBeNull();
    expect(queryByTestId('write-note-dialog')).toBeNull();
  });
});

describe('ChapterReader -- scrollOffset snapshot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContentBody.mockResolvedValue(NOTE_CHAPTER);
  });

  async function writeNoteAfterScroll(
    scrollTo: number | null,
  ): Promise<RenderResult & { onWriteNote: jest.Mock }> {
    const utils = await renderReader();
    const { getByTestId } = utils;
    if (scrollTo !== null) {
      fireEvent.scroll(getByTestId('reader-markdown'), {
        nativeEvent: { contentOffset: { y: scrollTo } },
      });
    }
    fireEvent.press(getByTestId('reader-write-note-affordance'));
    selectRiff(getByTestId);
    await act(async () => {
      fireEvent.press(getByTestId('passage-select-confirm'));
    });
    await act(async () => {
      fireEvent.press(getByTestId('write-note-dialog-confirm'));
    });
    return utils;
  }

  it('captures the scroll position at the moment the affordance is pressed', async () => {
    const { onWriteNote } = await writeNoteAfterScroll(240);
    expect(onWriteNote).toHaveBeenCalledWith(expect.objectContaining({ scrollOffset: 240 }));
  });

  it('defaults scrollOffset to 0 when the reader was never scrolled', async () => {
    const { onWriteNote } = await writeNoteAfterScroll(null);
    expect(onWriteNote).toHaveBeenCalledWith(expect.objectContaining({ scrollOffset: 0 }));
  });

  it('does not let a scroll delivered after entering selection mode change the already-captured offset', async () => {
    const utils = await renderReader();
    const { getByTestId } = utils;
    const scrollView = getByTestId('reader-markdown');
    fireEvent.scroll(scrollView, { nativeEvent: { contentOffset: { y: 240 } } });
    fireEvent.press(getByTestId('reader-write-note-affordance'));

    // A late-delivered scroll event on the (now-replaced) reading ScrollView
    // must not overwrite the offset already snapshotted at press time.
    fireEvent.scroll(scrollView, { nativeEvent: { contentOffset: { y: 999 } } });

    selectRiff(getByTestId);
    await act(async () => {
      fireEvent.press(getByTestId('passage-select-confirm'));
    });
    await act(async () => {
      fireEvent.press(getByTestId('write-note-dialog-confirm'));
    });

    expect(utils.onWriteNote).toHaveBeenCalledWith(expect.objectContaining({ scrollOffset: 240 }));
  });
});

describe('ChapterReader -- initialScrollOffset', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContentBody.mockResolvedValue(NOTE_CHAPTER);
  });

  it('applies initialScrollOffset as the reading ScrollView contentOffset', async () => {
    const { findByTestId } = await renderReader({ initialScrollOffset: 125 });
    const scrollView = await findByTestId('reader-markdown');
    expect(scrollView.props.contentOffset).toEqual({ x: 0, y: 125 });
  });
});
