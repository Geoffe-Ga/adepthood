/* eslint-env jest */
// #3660: a Course chapter promotes a passage the way a journal page does. One
// gesture -- Select a passage -- opens the selection surface, and the floating
// pill offers Promote (primary) beside Write a note. Its offsets index
// ``body_markdown`` as served, not the title-stripped text on screen.
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';

import type * as Api from '../../../api';
import { ApiError } from '../../../api';
import { FLOATING_PROMOTE_TEST_ID } from '../../Journal/FloatingPromoteButton';
import {
  PROMOTE_EXPLAINER_READING_BODY,
  PROMOTED_NOTICE_COPY,
} from '../../Journal/promoteExplainerCopy';
import ChapterReader from '../ChapterReader';

type SpanCreate = (
  _contentId: number,
  _span: { anchor_start: number; anchor_end: number },
) => Promise<Api.PromotedQuote>;
const mockCreateForCourse = jest.fn() as jest.MockedFunction<SpanCreate>;
let mockDismissed = true;
const mockSaveDismissed = jest.fn((_value: boolean) => Promise.resolve());

jest.mock('../../../api', () => {
  const actual = jest.requireActual('../../../api') as Record<string, unknown>;
  return {
    ApiError: actual.ApiError,
    course: {
      contentBody: jest.fn(),
      siteResourceBody: jest.fn(),
      stageIntroBody: jest.fn(),
    },
    promotions: {
      createForCourse: (...a: unknown[]) =>
        (mockCreateForCourse as unknown as (...x: unknown[]) => unknown)(...a),
    },
  };
});

jest.mock('@/storage/promoteExplainerStorage', () => ({
  loadPromoteExplainerDismissed: () => Promise.resolve(mockDismissed),
  savePromoteExplainerDismissed: (value: boolean) => mockSaveDismissed(value),
}));

const { course: courseApi } = jest.requireMock('../../../api') as {
  course: {
    contentBody: jest.MockedFunction<typeof Api.course.contentBody>;
    stageIntroBody: jest.MockedFunction<typeof Api.course.stageIntroBody>;
  };
};

// ``# Chapter One\n\n`` is 15 code points, so the riff the surface sees at
// {7, 11} -- past the astral emoji, UTF-16 {8, 12} -- is {22, 26} as served.
const CHAPTER = {
  title: 'Chapter One',
  content_type: 'chapter',
  body_markdown: '# Chapter One\n\n\u{1F3B8} solo riff selected here.\n',
};
const RIFF_SELECTION = { start: 8, end: 12 };
const SERVED_RIFF = { anchor_start: 22, anchor_end: 26 };

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

type RenderResult = ReturnType<typeof render>;

async function renderChapter(
  overrides: Partial<React.ComponentProps<typeof ChapterReader>> = {},
): Promise<RenderResult & { onWriteNote: jest.Mock }> {
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
  return { ...utils, onWriteNote };
}

function selectRiff(getByTestId: RenderResult['getByTestId']): void {
  fireEvent(getByTestId('passage-select-input'), 'selectionChange', {
    nativeEvent: { selection: RIFF_SELECTION },
  });
}

async function chooseRiff(utils: RenderResult): Promise<void> {
  fireEvent.press(utils.getByTestId('reader-write-note-affordance'));
  selectRiff(utils.getByTestId);
  // Let the explainer's stored flag settle before the pill is pressed.
  await act(async () => {
    await Promise.resolve();
  });
}

async function pressPromote(utils: RenderResult): Promise<void> {
  await act(async () => {
    fireEvent.press(utils.getByTestId(FLOATING_PROMOTE_TEST_ID));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDismissed = true;
  courseApi.contentBody.mockResolvedValue(CHAPTER);
  mockCreateForCourse.mockResolvedValue(courseQuote());
});

describe('ChapterReader -- one gesture: Select a passage', () => {
  it('invites the reader to select a passage, not only to write a note', async () => {
    const { getByTestId } = await renderChapter();
    const affordance = getByTestId('reader-write-note-affordance');

    within(affordance).getByText('Select a passage');
    expect(affordance.props.accessibilityLabel).toBe('Select a passage');
    expect(affordance.props.accessibilityRole).toBe('button');
  });

  it('floats Promote beside Write a note once a passage is chosen', async () => {
    const utils = await renderChapter();
    fireEvent.press(utils.getByTestId('reader-write-note-affordance'));
    expect(utils.queryByTestId(FLOATING_PROMOTE_TEST_ID)).toBeNull();

    selectRiff(utils.getByTestId);

    const promote = utils.getByTestId(FLOATING_PROMOTE_TEST_ID);
    within(promote).getByText('Promote');
    expect(promote.props.accessibilityLabel).toBe('Promote this passage');
    expect(promote.props.accessibilityRole).toBe('button');
    const writeNote = utils.getByTestId('passage-select-confirm');
    within(writeNote).getByText('Write a note');
    expect(writeNote.props.accessibilityLabel).toBe('Write a note on this passage');
    expect(writeNote.props.accessibilityRole).toBe('button');
  });

  it('names the way out of selection for what it is: back to the chapter', async () => {
    const utils = await renderChapter();
    fireEvent.press(utils.getByTestId('reader-write-note-affordance'));

    const done = utils.getByTestId('passage-select-cancel');
    within(done).getByText('Done');
    expect(done.props.accessibilityLabel).toBe('Back to the chapter');
  });

  it('lets the bottom fade go while selecting, so nothing washes over the footer or pill', async () => {
    const utils = await renderChapter();
    expect(utils.getByTestId('reader-bottom-fade')).toBeTruthy();

    fireEvent.press(utils.getByTestId('reader-write-note-affordance'));

    expect(utils.queryByTestId('reader-bottom-fade')).toBeNull();
  });
});

describe('ChapterReader -- Promote', () => {
  it('posts the span as served: the stripped title heading is added back', async () => {
    const utils = await renderChapter();
    await chooseRiff(utils);

    await pressPromote(utils);

    expect(mockCreateForCourse).toHaveBeenCalledTimes(1);
    expect(mockCreateForCourse).toHaveBeenCalledWith(4, SERVED_RIFF);
  });

  it('says where the quote went, and clears the passage so the reader keeps their place', async () => {
    const utils = await renderChapter();
    await chooseRiff(utils);

    await pressPromote(utils);

    await waitFor(() =>
      expect(utils.getByTestId('quote-promotion-success')).toHaveTextContent(PROMOTED_NOTICE_COPY),
    );
    expect(utils.getByTestId('passage-select-input')).toBeTruthy();
    expect(utils.queryByTestId('passage-select-preview')).toBeNull();
    expect(utils.getByTestId('chapter-promotion-notice')).toBeTruthy();
  });

  it('shows the pill working while the promote is in flight', async () => {
    let settle: (_quote: Api.PromotedQuote) => void = () => undefined;
    mockCreateForCourse.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const utils = await renderChapter();
    await chooseRiff(utils);

    await pressPromote(utils);

    expect(utils.getByTestId(FLOATING_PROMOTE_TEST_ID).props.accessibilityState).toMatchObject({
      busy: true,
    });
    await act(async () => {
      settle(courseQuote());
    });
  });

  it('keeps the passage and offers a calm retry when the chapter is not open yet', async () => {
    mockCreateForCourse.mockRejectedValueOnce(new ApiError(404, 'content_not_found'));
    const utils = await renderChapter();
    await chooseRiff(utils);

    await pressPromote(utils);

    await waitFor(() =>
      expect(utils.getByTestId('quote-promotion-error')).toHaveTextContent(
        /^This chapter isn't open to you yet/,
      ),
    );
    expect(utils.getByTestId('passage-select-preview').props.children).toBe('riff');
    await act(async () => {
      fireEvent.press(utils.getByTestId('quote-promotion-retry'));
    });
    expect(mockCreateForCourse).toHaveBeenLastCalledWith(4, SERVED_RIFF);
  });
});

describe('ChapterReader -- the first promote explains itself', () => {
  it('opens the reading note before promoting, and promotes the chosen passage on go-ahead', async () => {
    mockDismissed = false;
    const utils = await renderChapter();
    await chooseRiff(utils);

    await pressPromote(utils);

    expect(mockCreateForCourse).not.toHaveBeenCalled();
    expect(utils.getByTestId('promote-explainer-body')).toHaveTextContent(
      PROMOTE_EXPLAINER_READING_BODY,
    );
    const proceed = utils.getByTestId('promote-explainer-continue');
    expect(proceed).toHaveTextContent('Promote the passage');

    await act(async () => {
      fireEvent.press(proceed);
    });

    expect(mockCreateForCourse).toHaveBeenCalledWith(4, SERVED_RIFF);
  });

  it('promotes nothing when the reader says Not now', async () => {
    mockDismissed = false;
    const utils = await renderChapter();
    await chooseRiff(utils);
    await pressPromote(utils);

    fireEvent.press(utils.getByTestId('promote-explainer-cancel'));

    expect(mockCreateForCourse).not.toHaveBeenCalled();
    expect(utils.getByTestId('passage-select-preview').props.children).toBe('riff');
  });
});

describe('ChapterReader -- a reading with no chapter id', () => {
  it('offers Write a note alone on an introduction', async () => {
    courseApi.stageIntroBody.mockResolvedValue({ ...CHAPTER, content_type: 'introduction' });
    const utils = await renderChapter({ source: { kind: 'intro', stageNumber: 1 } });
    fireEvent.press(utils.getByTestId('reader-write-note-affordance'));
    selectRiff(utils.getByTestId);

    within(utils.getByTestId(FLOATING_PROMOTE_TEST_ID)).getByText('Write a note');
    expect(utils.queryByTestId('passage-select-confirm')).toBeNull();
    await act(async () => {
      fireEvent.press(utils.getByTestId(FLOATING_PROMOTE_TEST_ID));
    });
    expect(utils.getByTestId('write-note-dialog')).toBeTruthy();
    expect(mockCreateForCourse).not.toHaveBeenCalled();
  });
});
