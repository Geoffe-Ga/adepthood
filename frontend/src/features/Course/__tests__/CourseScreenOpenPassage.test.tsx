/**
 * A Course quote's Open (#3659) lands on the Course tab with a one-shot
 * ``highlightSpan`` request: the chapter opens on its selection surface with the
 * quoted passage already chosen, and the request is consumed so it never fires
 * twice -- while the same request made again, later, opens it again.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

import type { ContentBody, ContentItem, Stage } from '../../../api';
import { useProgramStore } from '../../../store/useProgramStore';
import type { CoursePassageSpan } from '../coursePassage';

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

const chapter = (id: number, title: string): ContentItem => ({
  id,
  title,
  content_type: 'chapter',
  release_day: id,
  url: `content://${id}`,
  is_locked: false,
  is_read: false,
});

const STAGE_ONE = [chapter(5, 'Welcome Essay')];
const STAGE_TWO = [chapter(21, 'Purple One')];

// ``# Welcome Essay\n\n`` is 17 code points, so "riff" -- 7..11 in the body as
// shown, past the emoji -- is 24..28 in the body as served.
const NOTE_BODY: ContentBody = {
  title: 'Welcome Essay',
  content_type: 'chapter',
  body_markdown: '# Welcome Essay\n\n\u{1F3B8} solo riff selected here.\n',
};
const RIFF: CoursePassageSpan = { start: 24, end: 28, text: 'riff' };

type CourseParams = {
  stageNumber?: number;
  contentId?: number;
  scrollOffset?: number;
  highlightSpan?: CoursePassageSpan;
};

const mockStageContent = jest.fn<(_stageNumber: number) => Promise<ContentItem[]>>();
const mockContentBody = jest.fn<(_contentId: number) => Promise<ContentBody>>();
const mockSetParams = jest.fn<(_params: CourseParams) => void>();
let mockRouteParams: CourseParams | undefined;

jest.mock('@/context/AuthContext', () => require('./authContextTestKit'));

jest.mock('../../../api', () => ({
  captureSessionToken: () => 'e30.eyJzdWIiOiIxIiwiZXhwIjo0MTAyNDQ0ODAwfQ.signature',
  uiFlags: { get: () => Promise.resolve({ course_last_stage: 1 }) },
  stages: {
    listAll: () => Promise.resolve([makeStage(1), makeStage(2)]),
    programCalendar: () => Promise.resolve({ current_stage: 1 }),
  },
  course: {
    nextUnread: () => Promise.resolve(null),
    stageContentAll: (stageNumber: number) => mockStageContent(stageNumber),
    stageProgress: () =>
      Promise.resolve({
        total_items: 1,
        read_items: 0,
        progress_percent: 0,
        next_unlock_day: null,
      }),
    markRead: jest.fn(),
    contentBody: (contentId: number) => mockContentBody(contentId),
    startHereProgress: () =>
      Promise.resolve({
        total_items: 0,
        read_items: 0,
        progress_percent: 0,
        next_unlock_day: null,
      }),
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

/**
 * Render, and make ``setParams`` merge into the route the way the navigator
 * does. The screen reads the merged params on its next render, which the state
 * the passage request sets in the same effect already brings about.
 */
const renderCourse = () => {
  mockSetParams.mockImplementation((params) => {
    mockRouteParams = { ...mockRouteParams, ...params };
  });
  return render(<CourseScreen />);
};

/** A navigate() from another screen: the route's params replaced, then a render. */
const arrive = async (utils: ReturnType<typeof renderCourse>, params: CourseParams) => {
  mockRouteParams = params;
  utils.rerender(<CourseScreen />);
  await settle();
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRouteParams = undefined;
  useProgramStore.setState({ programStartDate: null, programStartDay: null });
  mockStageContent.mockImplementation((stage) =>
    Promise.resolve(stage === 2 ? STAGE_TWO : STAGE_ONE),
  );
  mockContentBody.mockResolvedValue(NOTE_BODY);
});

describe("CourseScreen -- a Course quote's Open (#3659)", () => {
  it('opens the chapter with the quoted passage preselected, and consumes the request', async () => {
    mockRouteParams = { stageNumber: 1, contentId: 5, highlightSpan: RIFF };
    const { getByTestId, queryByTestId } = renderCourse();
    await settle();

    expect(getByTestId('chapter-reader')).toBeTruthy();
    expect(queryByTestId('reader-markdown')).toBeNull();
    expect(getByTestId('passage-select-preview').props.children).toBe('riff');
    expect(mockSetParams).toHaveBeenCalledWith({ highlightSpan: undefined });
  });

  it('returns to the rendered chapter on Cancel, and does not reopen it on the passage', async () => {
    mockRouteParams = { stageNumber: 1, contentId: 5, highlightSpan: RIFF };
    const { getByTestId, queryByTestId } = renderCourse();
    await settle();

    fireEvent.press(getByTestId('passage-select-cancel'));
    await settle();

    expect(getByTestId('reader-markdown')).toBeTruthy();
    expect(queryByTestId('passage-select-input')).toBeNull();
  });

  it('opens the chapter normally when the passage no longer matches it', async () => {
    mockRouteParams = { stageNumber: 1, contentId: 5, highlightSpan: { ...RIFF, text: 'rift' } };
    const { getByTestId, queryByTestId } = renderCourse();
    await settle();

    expect(getByTestId('reader-markdown')).toBeTruthy();
    expect(queryByTestId('passage-select-input')).toBeNull();
  });

  it('opens the same passage again when the same quote is opened again later', async () => {
    mockRouteParams = { stageNumber: 1, contentId: 5, highlightSpan: RIFF };
    const utils = renderCourse();
    await settle();
    fireEvent.press(utils.getByTestId('passage-select-cancel'));
    await settle();

    await arrive(utils, { stageNumber: 1, contentId: 5, highlightSpan: RIFF });

    expect(utils.getByTestId('passage-select-preview').props.children).toBe('riff');
  });

  it('preselects the passage over a chapter the reader already has open', async () => {
    mockRouteParams = { stageNumber: 1 };
    const utils = renderCourse();
    await settle();
    await act(async () => {
      fireEvent.press(utils.getByTestId('content-card-5'));
    });
    await settle();
    expect(utils.getByTestId('reader-markdown')).toBeTruthy();

    await arrive(utils, { stageNumber: 1, contentId: 5, highlightSpan: RIFF });

    expect(utils.getByTestId('passage-select-preview').props.children).toBe('riff');
  });

  it("selects the quote's stage even when the route already names it", async () => {
    // The reader moved to stage 2 with the pills; the route still says 1, so
    // following the route's stage number alone would never load stage 1.
    mockRouteParams = { stageNumber: 1 };
    const utils = renderCourse();
    await settle();
    await act(async () => {
      fireEvent.press(utils.getByTestId('stage-pill-2'));
    });
    await settle();
    expect(utils.getByTestId('content-card-21')).toBeTruthy();

    await arrive(utils, { stageNumber: 1, contentId: 5, highlightSpan: RIFF });

    expect(utils.getByTestId('passage-select-preview').props.children).toBe('riff');
  });

  it('does not open a closed chapter on the stale contentId once the passage was shown', async () => {
    mockRouteParams = { stageNumber: 1, contentId: 5, highlightSpan: RIFF };
    const { getByTestId, queryByTestId } = renderCourse();
    await settle();

    await act(async () => {
      fireEvent.press(getByTestId('reader-back-button'));
    });
    await settle();

    expect(queryByTestId('chapter-reader')).toBeNull();
  });
});

beforeEach(() => {
  require('@/storage/userScope').setActiveUser(1);
  require('../startHereStore').useStartHereStore.getState().reset();
});
