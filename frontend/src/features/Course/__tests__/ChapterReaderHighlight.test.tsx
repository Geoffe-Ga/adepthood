/* eslint-env jest */
// #3661: on the web a reader highlights a passage right on a rendered Course
// chapter and the floating pill comes to it -- Promote beside Write a note
// when the projection places the passage exactly, Choose this passage… (the
// selection field, the guess pre-chosen) when it can only guess. The hook is
// stood in for (its browser half is pinned by useRenderedSelection.test.tsx,
// the mapper by chapterProjection.test.ts), and so is the pill, which draws
// only on the web; these specs pin the reader's wiring.
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type * as Api from '../../../api';
import type { AnchorSpan } from '../../Journal/anchorSpan';
import { PROMOTED_NOTICE_COPY } from '../../Journal/promoteExplainerCopy';
import type { RenderedSelection } from '../../Journal/renderedSelection';
import type { ChapterPassage } from '../chapterProjection';
import ChapterReader from '../ChapterReader';

type SpanCreate = (
  _contentId: number,
  _span: { anchor_start: number; anchor_end: number },
) => Promise<Api.PromotedQuote>;
const mockCreateForCourse = jest.fn() as jest.MockedFunction<SpanCreate>;
const mockClearSelection = jest.fn();
let mockDismissed = true;
let mockPassage: ChapterPassage | null = null;
let mockMap: ((_selection: RenderedSelection) => ChapterPassage | null) | null = null;

jest.mock('../../../api', () => {
  const actual = jest.requireActual('../../../api') as Record<string, unknown>;
  return {
    ApiError: actual.ApiError,
    course: { contentBody: jest.fn(), siteResourceBody: jest.fn(), stageIntroBody: jest.fn() },
    promotions: {
      createForCourse: (...a: unknown[]) =>
        (mockCreateForCourse as unknown as (...x: unknown[]) => unknown)(...a),
    },
  };
});

jest.mock('@/storage/promoteExplainerStorage', () => ({
  loadPromoteExplainerDismissed: () => Promise.resolve(mockDismissed),
  savePromoteExplainerDismissed: () => Promise.resolve(),
}));

jest.mock('../../Journal/useRenderedSelection', () => ({
  useRenderedSelection: (
    _container: unknown,
    map: (_selection: RenderedSelection) => ChapterPassage | null,
  ) => {
    mockMap = map;
    return mockPassage;
  },
  clearRenderedSelection: () => mockClearSelection(),
}));

/** The pill, drawn on any platform: the real one draws only on the web. */
jest.mock('../../Journal/RenderedSelectionPill', () => {
  const { Pressable, Text, View } = require('react-native');
  const StandIn = ({
    passage,
    onPromote,
    label,
    accessibilityLabel,
    secondaryAction,
  }: {
    passage: AnchorSpan | null;
    onPromote: (_span: AnchorSpan) => void;
    label?: string;
    accessibilityLabel?: string;
    secondaryAction?: { label: string; onPress: () => void };
  }) =>
    passage ? (
      <View>
        <Pressable
          testID="rendered-pill"
          onPress={() => onPromote(passage)}
          accessibilityLabel={accessibilityLabel}
        >
          <Text>{label}</Text>
        </Pressable>
        {secondaryAction ? (
          <Pressable testID="rendered-pill-secondary" onPress={secondaryAction.onPress}>
            <Text>{secondaryAction.label}</Text>
          </Pressable>
        ) : null}
      </View>
    ) : null;
  return { __esModule: true, default: StandIn, STEP_ASIDE: { opacity: 0 } };
});

const { course: courseApi } = jest.requireMock('../../../api') as {
  course: {
    contentBody: jest.MockedFunction<typeof Api.course.contentBody>;
    stageIntroBody: jest.MockedFunction<typeof Api.course.stageIntroBody>;
  };
};

// ``# Chapter One\n\n`` is 15 code points: 'riff', at {7, 11} of the shown
// text, is {22, 26} as served.
const CHAPTER = {
  title: 'Chapter One',
  content_type: 'chapter',
  body_markdown: '# Chapter One\n\nA lone riff played slowly.\n',
};
const RIFF: ChapterPassage = { start: 7, end: 11, exact: true };

function courseQuote(): Api.PromotedQuote {
  return {
    id: 31,
    source_kind: 'course',
    source_entry_id: null,
    source_content_id: 4,
    source_marginalia_id: null,
    anchor_start: 22,
    anchor_end: 26,
    anchor_text: 'riff',
    pending: true,
    stale: false,
  };
}

async function renderChapter(
  overrides: Partial<React.ComponentProps<typeof ChapterReader>> = {},
): Promise<ReturnType<typeof render> & { onWriteNote: jest.Mock }> {
  const onWriteNote = jest.fn();
  const utils = render(
    <ChapterReader
      source={{ kind: 'content', id: 4 }}
      fallbackTitle="x"
      onBack={jest.fn()}
      onWriteNote={onWriteNote}
      {...overrides}
    />,
  );
  await utils.findByTestId('reader-markdown');
  await act(async () => {
    await Promise.resolve();
  });
  return { ...utils, onWriteNote };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDismissed = true;
  mockPassage = null;
  mockMap = null;
  courseApi.contentBody.mockResolvedValue(CHAPTER);
  mockCreateForCourse.mockResolvedValue(courseQuote());
});

describe('ChapterReader -- promote by highlighting the rendered chapter (#3661)', () => {
  it('reads the selection over the rendered chapter through its projection', async () => {
    await renderChapter();
    const shown = 'A lone riff played slowly.';
    const at = shown.indexOf('riff');
    const passage = mockMap?.({
      pieces: [{ text: shown, srcStart: null }],
      start: { piece: 0, offset: at },
      end: { piece: 0, offset: at + 4 },
    });
    expect(passage).toEqual(RIFF);
  });

  it('offers no pill while nothing is highlighted', async () => {
    const utils = await renderChapter();
    expect(utils.queryByTestId('rendered-pill')).toBeNull();
  });

  it('promotes an exactly placed passage at its served offsets, and the notice floats', async () => {
    mockPassage = RIFF;
    const utils = await renderChapter();
    const pill = utils.getByTestId('rendered-pill');
    expect(pill.props.accessibilityLabel).toBe('Promote this passage');
    expect(utils.getByText('Promote')).toBeTruthy();
    await act(async () => {
      fireEvent.press(pill);
    });

    expect(mockCreateForCourse).toHaveBeenCalledWith(4, { anchor_start: 22, anchor_end: 26 });
    expect(mockClearSelection).toHaveBeenCalled();
    expect(utils.getByTestId('chapter-promotion-notice')).toHaveTextContent(PROMOTED_NOTICE_COPY);
    expect(utils.queryByTestId('passage-select-input')).toBeNull();
  });

  it('explains the first promote for the passage already chosen, then promotes it', async () => {
    mockDismissed = false;
    mockPassage = RIFF;
    const utils = await renderChapter();
    fireEvent.press(utils.getByTestId('rendered-pill'));
    expect(utils.getByTestId('promote-explainer-continue')).toHaveTextContent(
      'Promote the passage',
    );
    expect(mockCreateForCourse).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.press(utils.getByTestId('promote-explainer-continue'));
    });
    expect(mockCreateForCourse).toHaveBeenCalledWith(4, { anchor_start: 22, anchor_end: 26 });
  });

  it('writes a note on the passage from the pill’s Write a note', async () => {
    mockPassage = RIFF;
    const utils = await renderChapter();
    fireEvent.press(utils.getByTestId('rendered-pill-secondary'));
    fireEvent.press(utils.getByTestId('write-note-dialog-confirm'));
    expect(utils.onWriteNote).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'riff', sourceTitle: 'Chapter One' }),
    );
    expect(mockCreateForCourse).not.toHaveBeenCalled();
  });

  it('is honest about a guess: Choose this passage… opens the field with it chosen', async () => {
    mockPassage = { start: 2, end: 11, exact: false };
    const utils = await renderChapter();
    const pill = utils.getByTestId('rendered-pill');
    expect(utils.getByText('Choose this passage…')).toBeTruthy();
    expect(pill.props.accessibilityLabel).toBe('Choose this passage in the selection field');
    expect(utils.queryByTestId('rendered-pill-secondary')).toBeNull();
    fireEvent.press(pill);

    expect(mockClearSelection).toHaveBeenCalled();
    expect(utils.getByTestId('passage-select-input')).toBeTruthy();
    expect(utils.getByTestId('passage-select-preview').props.children).toBe('lone riff');
    expect(mockCreateForCourse).not.toHaveBeenCalled();
  });

  it('opens the field with nothing chosen when not even a guess was found', async () => {
    mockPassage = { start: 0, end: 0, exact: false };
    const utils = await renderChapter();
    fireEvent.press(utils.getByTestId('rendered-pill'));
    expect(utils.getByTestId('passage-select-input')).toBeTruthy();
    expect(utils.queryByTestId('passage-select-preview')).toBeNull();
  });

  it('offers Write a note alone on a reading with no chapter to promote from', async () => {
    mockPassage = RIFF;
    courseApi.stageIntroBody.mockResolvedValue({ ...CHAPTER, content_type: 'introduction' });
    const utils = await renderChapter({ source: { kind: 'intro', stageNumber: 1 } });
    expect(utils.getByText('Write a note')).toBeTruthy();
    expect(utils.queryByTestId('rendered-pill-secondary')).toBeNull();
    fireEvent.press(utils.getByTestId('rendered-pill'));
    expect(utils.getByTestId('write-note-dialog-confirm')).toBeTruthy();
  });

  it('offers no pill where a passage can be neither promoted nor noted', async () => {
    mockPassage = RIFF;
    courseApi.stageIntroBody.mockResolvedValue({ ...CHAPTER, content_type: 'introduction' });
    const utils = await renderChapter({
      source: { kind: 'intro', stageNumber: 1 },
      onWriteNote: undefined,
    });
    expect(utils.queryByTestId('rendered-pill')).toBeNull();
  });

  it('keeps the chapter controls away while a passage is highlighted, and back after', async () => {
    mockPassage = RIFF;
    const renderFooter = jest.fn((_atEnd: boolean) => null);
    const utils = await renderChapter({ renderFooter });
    expect(renderFooter).toHaveBeenLastCalledWith(false);
    mockPassage = null;
    utils.rerender(
      <ChapterReader
        source={{ kind: 'content', id: 4 }}
        fallbackTitle="x"
        onBack={jest.fn()}
        renderFooter={renderFooter}
      />,
    );
    fireEvent(utils.getByTestId('reader-markdown'), 'layout', {
      nativeEvent: { layout: { height: 800 } },
    });
    fireEvent(utils.getByTestId('reader-markdown'), 'contentSizeChange', 300, 400);
    expect(renderFooter).toHaveBeenLastCalledWith(true);
  });
});
