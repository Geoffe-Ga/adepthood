/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-env jest */
// RED: CourseScreen does not yet wire the write-note flow -- no
// reader-write-note-affordance, no returnTo navigate payload, no warm-return
// auto-open of a restored contentId/scrollOffset.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

import type { ContentItem, CourseProgress, Stage } from '../../../api';

const makeStage = (overrides: Partial<Stage> = {}): Stage => ({
  id: 1,
  title: 'Stage 1',
  subtitle: 'First stage',
  stage_number: 1,
  overview_url: 'https://example.com',
  category: 'foundation',
  aspect: 'body',
  spiral_dynamics_color: 'Beige',
  growing_up_stage: 'Archaic',
  divine_gender_polarity: 'neutral',
  relationship_to_free_will: 'reactive',
  free_will_description: 'Instinctual survival',
  is_unlocked: true,
  progress: 0,
  ...overrides,
});

const sampleStages: Stage[] = [makeStage({ id: 1, stage_number: 1 })];

const sampleContent: ContentItem[] = [
  {
    id: 5,
    title: 'Welcome Essay',
    content_type: 'chapter',
    release_day: 0,
    url: 'content://beige-5',
    is_locked: false,
    is_read: false,
  },
  {
    id: 6,
    title: 'Locked Chapter',
    content_type: 'chapter',
    release_day: 3,
    url: null,
    is_locked: true,
    is_read: false,
  },
];

const sampleProgress: CourseProgress = {
  total_items: 2,
  read_items: 0,
  progress_percent: 0,
  next_unlock_day: 3,
};

// Same astral-emoji fixture as ChapterReaderPassageSelection.test.tsx: the
// leading emoji shifts UTF-16 offsets by +1 versus code-point offsets, so
// "riff" only comes out right when the passage is sliced by code points.
const NOTE_BODY = {
  title: 'Welcome Essay',
  content_type: 'chapter',
  body_markdown: '# Welcome Essay\n\n\u{1F3B8} solo riff selected here.\n',
};
const RIFF_SELECTION = { start: 8, end: 12 };

const mockStagesList = (jest.fn() as any).mockResolvedValue(sampleStages);
const mockStageContent = (jest.fn() as any).mockResolvedValue(sampleContent);
const mockStageProgress = (jest.fn() as any).mockResolvedValue(sampleProgress);
const mockMarkRead = (jest.fn() as any).mockResolvedValue({
  id: 1,
  user_id: 1,
  content_id: 5,
  completed_at: '2026-01-15T10:00:00Z',
});
const mockSiteResources = (jest.fn() as any).mockResolvedValue([]);
const mockContentBody = (jest.fn() as any).mockResolvedValue(NOTE_BODY);
const mockSiteResourceBody = (jest.fn() as any).mockResolvedValue({
  title: 'Philosophy',
  content_type: 'resource',
  body_markdown: 'philosophy\n',
});
const mockStageIntro = (jest.fn() as any).mockRejectedValue({ detail: 'content_not_found' });
const mockStageIntroBody = (jest.fn() as any).mockResolvedValue({
  title: 'Welcome to Beige',
  content_type: 'introduction',
  body_markdown: '# Welcome to Beige\n\nintro\n',
});

jest.mock('../../../api', () => ({
  stages: {
    listAll: (...args: unknown[]) => mockStagesList(...args),
  },
  course: {
    stageContentAll: (...args: unknown[]) => mockStageContent(...args),
    stageProgress: (...args: unknown[]) => mockStageProgress(...args),
    markRead: (...args: unknown[]) => mockMarkRead(...args),
    contentBody: (...args: unknown[]) => mockContentBody(...args),
    siteResources: (...args: unknown[]) => mockSiteResources(...args),
    siteResourceBody: (...args: unknown[]) => mockSiteResourceBody(...args),
    stageIntro: (...args: unknown[]) => mockStageIntro(...args),
    stageIntroBody: (...args: unknown[]) => mockStageIntroBody(...args),
  },
}));

const mockNavigate = jest.fn() as any;
let mockRouteParams:
  { stageNumber?: number; contentId?: number; scrollOffset?: number } | undefined;

jest.mock('../../../navigation/hooks', () => ({
  useAppRoute: () => ({ key: 'Course-test', name: 'Course', params: mockRouteParams }),
  useAppNavigation: () => ({ navigate: mockNavigate, setOptions: jest.fn() }),
}));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  return {
    SafeAreaView: ({ children }: { children: any }) =>
      React.createElement(React.Fragment, null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

// eslint-disable-next-line import/order
const { render, waitFor, fireEvent, act } = require('@testing-library/react-native');
const CourseScreen = require('../CourseScreen').default;

function selectRiff(getByTestId: any): void {
  const input = getByTestId('passage-select-input');
  fireEvent(input, 'selectionChange', { nativeEvent: { selection: RIFF_SELECTION } });
}

describe('CourseScreen -- write a note on a passage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRouteParams = undefined;
    mockStagesList.mockResolvedValue(sampleStages);
    mockStageContent.mockResolvedValue(sampleContent);
    mockStageProgress.mockResolvedValue(sampleProgress);
    mockContentBody.mockResolvedValue(NOTE_BODY);
    mockStageIntro.mockRejectedValue({ detail: 'content_not_found' });
  });

  it('navigates to JournalEntry with the returnTo params and keeps the reader mounted', async () => {
    mockRouteParams = { stageNumber: 1 };
    const { getByTestId, findByTestId } = render(<CourseScreen />);

    await waitFor(() => expect(getByTestId('content-card-5')).toBeTruthy());
    await act(async () => {
      fireEvent.press(getByTestId('content-card-5'));
    });

    const scrollView = await findByTestId('reader-markdown');
    fireEvent.scroll(scrollView, { nativeEvent: { contentOffset: { y: 300 } } });

    fireEvent.press(getByTestId('reader-write-note-affordance'));
    selectRiff(getByTestId);
    await act(async () => {
      fireEvent.press(getByTestId('passage-select-confirm'));
    });
    await act(async () => {
      fireEvent.press(getByTestId('write-note-dialog-confirm'));
    });

    expect(mockNavigate).toHaveBeenCalledWith('JournalEntry', {
      prefillQuote: { text: 'riff', sourceTitle: 'Welcome Essay' },
      returnTo: { screen: 'Course', params: { stageNumber: 1, contentId: 5, scrollOffset: 300 } },
    });
    expect(getByTestId('chapter-reader')).toBeTruthy();
  });

  it('auto-opens the returned content restored to its scroll offset once the stage content has loaded', async () => {
    mockRouteParams = { stageNumber: 1, contentId: 5, scrollOffset: 300 };
    const { findByTestId } = render(<CourseScreen />);

    await findByTestId('chapter-reader');
    const scrollView = await findByTestId('reader-markdown');
    expect(scrollView.props.contentOffset).toEqual({ x: 0, y: 300 });
  });

  it('lets the reader be closed after a restore without re-opening from the stale param', async () => {
    mockRouteParams = { stageNumber: 1, contentId: 5, scrollOffset: 300 };
    const { getByTestId, findByTestId, queryByTestId } = render(<CourseScreen />);

    await findByTestId('chapter-reader');
    await act(async () => {
      fireEvent.press(getByTestId('reader-back-button'));
    });

    await waitFor(() => expect(queryByTestId('chapter-reader')).toBeNull());
    // The stale contentId param must not drag the reader back open.
    expect(queryByTestId('chapter-reader')).toBeNull();
  });

  it('renders the landing normally for an unknown contentId, without crashing', async () => {
    mockRouteParams = { stageNumber: 1, contentId: 9999, scrollOffset: 10 };
    const { findByTestId, queryByTestId } = render(<CourseScreen />);

    await findByTestId('content-list');
    expect(queryByTestId('chapter-reader')).toBeNull();
  });

  it('does not open a locked item from a warm return', async () => {
    mockRouteParams = { stageNumber: 1, contentId: 6, scrollOffset: 20 };
    const { findByTestId, queryByTestId } = render(<CourseScreen />);

    await findByTestId('content-list');
    expect(queryByTestId('chapter-reader')).toBeNull();
  });

  it('does not leak the warm-return scroll offset onto the next chapter navigated forward', async () => {
    // Two adjacent unlocked chapters so Next performs a real in-place swap
    // rather than ending the run (a locked neighbour would make Next a "Done").
    const twoUnlocked: ContentItem[] = [
      {
        id: 5,
        title: 'Welcome Essay',
        content_type: 'chapter',
        release_day: 0,
        url: 'content://beige-5',
        is_locked: false,
        is_read: false,
      },
      {
        id: 7,
        title: 'Second Essay',
        content_type: 'chapter',
        release_day: 1,
        url: 'content://beige-7',
        is_locked: false,
        is_read: false,
      },
    ];
    mockStageContent.mockResolvedValue(twoUnlocked);
    // Warm return restores chapter 5 to a scroll offset (the passage-note flow).
    mockRouteParams = { stageNumber: 1, contentId: 5, scrollOffset: 300 };
    const { getByTestId, findByTestId } = render(<CourseScreen />);

    const restored = await findByTestId('reader-markdown');
    expect(restored.props.contentOffset).toEqual({ x: 0, y: 300 });
    expect(mockContentBody).toHaveBeenCalledTimes(1);

    // Next swaps in chapter 7 via handleContentPress, which clears the restore
    // offset so the incoming chapter opens at the top instead of inheriting the
    // previous chapter's restored y:300.
    await act(async () => {
      fireEvent.press(getByTestId('chapter-nav-next'));
    });

    await waitFor(() => expect(mockContentBody).toHaveBeenCalledTimes(2));
    expect(getByTestId('reader-markdown').props.contentOffset).not.toEqual({ x: 0, y: 300 });
  });

  it('does not re-open or re-apply the scroll offset when a warm return matches the already-open item', async () => {
    mockRouteParams = { stageNumber: 1 };
    const { getByTestId, findByTestId, rerender } = render(<CourseScreen />);

    await waitFor(() => expect(getByTestId('content-card-5')).toBeTruthy());
    await act(async () => {
      fireEvent.press(getByTestId('content-card-5'));
    });
    await findByTestId('reader-markdown');
    expect(mockContentBody).toHaveBeenCalledTimes(1);

    mockRouteParams = { stageNumber: 1, contentId: 5, scrollOffset: 777 };
    rerender(<CourseScreen />);

    const scrollView = getByTestId('reader-markdown');
    expect(scrollView.props.contentOffset).not.toEqual({ x: 0, y: 777 });
    expect(mockContentBody).toHaveBeenCalledTimes(1);
  });
});
