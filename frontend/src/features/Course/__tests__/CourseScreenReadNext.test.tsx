/**
 * The Course header's "Read next" button (#3147): it asks GET /course/next-unread
 * where the reader left off, opens that chapter through the route-param path
 * ``useReaderRestore`` already serves, and asks again after a chapter is marked
 * read.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

import type { ContentBody, ContentCompletion, ContentItem, NextUnread, Stage } from '../../../api';
import { useProgramStore } from '../../../store/useProgramStore';

import { settle } from '@/testing/asyncSettle';

const makeStage = (stageNumber: number): Stage => ({
  id: stageNumber,
  title: `Stage ${stageNumber}`,
  subtitle: `Subtitle ${stageNumber}`,
  stage_number: stageNumber,
  overview_url: 'https://example.com',
  category: 'foundation',
  aspect: 'body',
  spiral_dynamics_color: stageNumber === 1 ? 'Beige' : 'Purple',
  growing_up_stage: 'Archaic',
  divine_gender_polarity: 'neutral',
  relationship_to_free_will: 'reactive',
  free_will_description: 'Instinctual survival',
  is_unlocked: true,
  progress: 0,
});

const chapter = (id: number, title: string, isRead = false): ContentItem => ({
  id,
  title,
  content_type: 'essay',
  release_day: id,
  url: `content://${id}`,
  is_locked: false,
  is_read: isRead,
});

const STAGE_ONE = [chapter(11, 'Beige One', true), chapter(12, 'Beige Two')];
const STAGE_TWO = [chapter(21, 'Purple One'), chapter(22, 'Purple Two')];
const PURPLE_TARGET: NextUnread = { content_id: 21, stage_number: 2, title: 'Purple One' };

type CourseParams = { stageNumber?: number; contentId?: number; scrollOffset?: number };

const mockNextUnread = jest.fn<() => Promise<NextUnread | null>>();
const mockStageContent = jest.fn<(_stageNumber: number) => Promise<ContentItem[]>>();
const mockMarkRead = jest.fn<(_contentId: number) => Promise<ContentCompletion>>();
const mockContentBody = jest.fn<(_contentId: number) => Promise<ContentBody>>();
const mockSetParams = jest.fn<(_params: CourseParams) => void>();
let mockRouteParams: CourseParams | undefined;

jest.mock('../../../api', () => ({
  uiFlags: { get: () => Promise.resolve({ course_last_stage: 1 }) },
  stages: {
    listAll: () => Promise.resolve([makeStage(1), makeStage(2)]),
    programCalendar: () => Promise.resolve({ current_stage: 1 }),
  },
  course: {
    nextUnread: () => mockNextUnread(),
    stageContentAll: (stageNumber: number) => mockStageContent(stageNumber),
    stageProgress: () =>
      Promise.resolve({
        total_items: 2,
        read_items: 1,
        progress_percent: 50,
        next_unlock_day: null,
      }),
    markRead: (contentId: number) => mockMarkRead(contentId),
    contentBody: (contentId: number) => mockContentBody(contentId),
    siteResources: () => Promise.resolve([]),
    stageIntro: () => Promise.reject(new Error('content_not_found')),
  },
}));

jest.mock('../../../navigation/hooks', () => ({
  useAppRoute: () => ({ key: 'Course-test', name: 'Course', params: mockRouteParams }),
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
}));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), setParams: mockSetParams }),
}));

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  return {
    SafeAreaView: ({ children }: { children: unknown }) =>
      React.createElement(React.Fragment, null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

// eslint-disable-next-line import/order
const { render, fireEvent, act } = require('@testing-library/react-native');
const CourseScreen = require('../CourseScreen').default;

const { readToTheEnd } = require('./readerGeometry');

/** Render, and make ``setParams`` behave like the navigator: merge, re-render. */
const renderCourse = () => {
  const utils = render(<CourseScreen />);
  mockSetParams.mockImplementation((params) => {
    mockRouteParams = { ...mockRouteParams, ...params };
    utils.rerender(<CourseScreen />);
  });
  return utils;
};

const pressReadNext = async (getByTestId: (_id: string) => unknown): Promise<void> => {
  await act(async () => {
    fireEvent.press(getByTestId('read-next'));
  });
  await settle();
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRouteParams = undefined;
  useProgramStore.setState({ programStartDate: null, programStartDay: null });
  mockNextUnread.mockResolvedValue(PURPLE_TARGET);
  mockStageContent.mockImplementation((stage) =>
    Promise.resolve(stage === 2 ? STAGE_TWO : STAGE_ONE),
  );
  mockMarkRead.mockResolvedValue({ id: 1, content_id: 21, completed_at: '2026-10-14T00:00:00Z' });
  mockContentBody.mockResolvedValue({
    title: 'Purple One',
    content_type: 'essay',
    body_markdown: 'Purple body.\n',
  });
});

describe('Read next button states', () => {
  it('is busy and disabled while the target is loading', async () => {
    mockNextUnread.mockReturnValue(new Promise(() => undefined));
    const { getByTestId } = renderCourse();
    await settle();

    const button = getByTestId('read-next');
    expect(button.props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(button.props.accessibilityLabel).toBe('Read next');
    expect(getByTestId('read-next-busy')).toBeTruthy();
  });

  it('names the target chapter and is enabled once it is known', async () => {
    const { getByTestId, getByText } = renderCourse();
    await settle();

    const button = getByTestId('read-next');
    expect(getByText('Read next')).toBeTruthy();
    expect(button.props.accessibilityLabel).toBe('Read next: Purple One');
    expect(button.props.accessibilityState).toEqual({ disabled: false, busy: false });
  });

  it('reads "All caught up" and is disabled when nothing is unread', async () => {
    mockNextUnread.mockResolvedValue(null);
    const { getByTestId, getByText } = renderCourse();
    await settle();

    const button = getByTestId('read-next');
    expect(getByText('All caught up')).toBeTruthy();
    expect(button.props.accessibilityState).toEqual({ disabled: true, busy: false });
    fireEvent.press(button);
    expect(mockSetParams).not.toHaveBeenCalled();
  });

  it('steps aside when the lookup fails rather than claiming the reader is caught up', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockNextUnread.mockRejectedValue(new Error('offline'));
    const { queryByTestId, getByTestId } = renderCourse();
    await settle();

    expect(queryByTestId('read-next')).toBeNull();
    expect(getByTestId('content-list')).toBeTruthy();
    consoleError.mockRestore();
  });

  it('sits in the header above the Chapters band', async () => {
    const { getByTestId, getByText, UNSAFE_root } = renderCourse();
    await settle();

    // Host nodes in render (document) order: the button precedes the band label.
    const hostNodes = UNSAFE_root.findAll(
      (node: { type: unknown }) => typeof node.type === 'string',
    );
    const buttonIndex = hostNodes.indexOf(getByTestId('read-next'));
    const bandIndex = hostNodes.indexOf(getByText('Chapters'));
    expect(buttonIndex).toBeGreaterThan(-1);
    expect(buttonIndex).toBeLessThan(bandIndex);
  });
});

describe('Read next navigation', () => {
  it('sets the route params and opens the target chapter in its stage', async () => {
    const { getByTestId } = renderCourse();
    await settle();
    expect(mockStageContent).toHaveBeenLastCalledWith(1);

    await pressReadNext(getByTestId);

    expect(mockSetParams).toHaveBeenCalledWith({
      stageNumber: 2,
      contentId: 21,
      scrollOffset: undefined,
    });
    expect(mockStageContent).toHaveBeenLastCalledWith(2);
    expect(getByTestId('chapter-reader')).toBeTruthy();
    expect(mockContentBody).toHaveBeenLastCalledWith(21);
  });

  it('reopens the same target after the reader backed out without finishing it', async () => {
    const { getByTestId, queryByTestId } = renderCourse();
    await settle();
    await pressReadNext(getByTestId);
    expect(getByTestId('chapter-reader')).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByTestId('reader-back-button'));
    });
    await settle();
    expect(queryByTestId('chapter-reader')).toBeNull();

    await pressReadNext(getByTestId);
    expect(getByTestId('chapter-reader')).toBeTruthy();
  });

  it('asks for a new target after a chapter is marked read', async () => {
    const { getByTestId, findByTestId } = renderCourse();
    await settle();
    await pressReadNext(getByTestId);
    expect(mockNextUnread).toHaveBeenCalledTimes(1);

    await readToTheEnd(findByTestId);
    await act(async () => {
      fireEvent.press(getByTestId('mark-read-button'));
    });
    await settle();

    expect(mockMarkRead).toHaveBeenCalledWith(21);
    expect(mockNextUnread).toHaveBeenCalledTimes(2);
  });
});
