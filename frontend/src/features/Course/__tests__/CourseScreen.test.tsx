/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { StyleSheet } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import type { ContentItem, CourseProgress, Stage } from '../../../api';
import { colors, STAGE_COLORS } from '../../../design/tokens';

function backgroundColorOf(style: StyleProp<ViewStyle>): string {
  const flat = StyleSheet.flatten(style) ?? {};
  return (flat.backgroundColor as string | undefined) ?? '';
}

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
  progress: 0.5,
  ...overrides,
});

// Stage 1 is completed → backend-truth mirror derives currentStage = 2.
// Keeping stage 2 unlocked+in-progress makes the "default selection" test
// match what a user who just finished stage 1 would see.
const sampleStages: Stage[] = [
  makeStage({ id: 1, stage_number: 1, is_unlocked: true, progress: 1 }),
  makeStage({
    id: 2,
    stage_number: 2,
    title: 'Stage 2',
    subtitle: 'Second stage',
    spiral_dynamics_color: 'Purple',
    is_unlocked: true,
    progress: 0,
  }),
  makeStage({
    id: 3,
    stage_number: 3,
    title: 'Stage 3',
    subtitle: 'Third stage',
    spiral_dynamics_color: 'Red',
    is_unlocked: false,
    progress: 0,
  }),
];

const sampleContent: ContentItem[] = [
  {
    id: 1,
    title: 'Welcome Essay',
    content_type: 'essay',
    release_day: 0,
    url: 'https://example.com/essay',
    is_locked: false,
    is_read: true,
  },
  {
    id: 2,
    title: 'Reflection Prompt',
    content_type: 'prompt',
    release_day: 3,
    url: null,
    is_locked: true,
    is_read: false,
  },
];

const sampleProgress: CourseProgress = {
  total_items: 2,
  read_items: 1,
  progress_percent: 50,
  next_unlock_day: 3,
};

const mockStagesList = (jest.fn() as any).mockResolvedValue(sampleStages);
const mockStageContent = (jest.fn() as any).mockResolvedValue(sampleContent);
const mockStageProgress = (jest.fn() as any).mockResolvedValue(sampleProgress);
const mockMarkRead = (jest.fn() as any).mockResolvedValue({
  id: 1,
  user_id: 1,
  content_id: 1,
  completed_at: '2026-01-15T10:00:00Z',
});
const mockSiteResources = (jest.fn() as any).mockResolvedValue([
  {
    slug: 'philosophy',
    title: 'Philosophy',
    description: '',
    url: 'content://philosophy',
  },
  {
    slug: 'about',
    title: 'About',
    description: '',
    url: 'content://about',
  },
]);
const mockContentBody = (jest.fn() as any).mockResolvedValue({
  title: 'Chapter One',
  content_type: 'chapter',
  body_markdown: 'x\n',
});
const mockSiteResourceBody = (jest.fn() as any).mockResolvedValue({
  title: 'Philosophy',
  content_type: 'resource',
  body_markdown: 'philosophy\n',
});
// Default: the selected stage has no intro (404) — the card stays hidden, so
// existing tests are unaffected. Intro-specific tests override this.
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
jest.mock('../../../navigation/hooks', () => ({
  useAppRoute: () => ({ key: 'Course-test', name: 'Course', params: undefined }),
  useAppNavigation: () => ({ navigate: mockNavigate }),
}));
// The reflect action now pushes the root-stack JournalEntry via useNavigation.
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
const { render, waitFor, fireEvent, act, within } = require('@testing-library/react-native');
const CourseScreen = require('../CourseScreen').default;

describe('CourseScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStagesList.mockResolvedValue(sampleStages);
    mockStageContent.mockResolvedValue(sampleContent);
    mockStageProgress.mockResolvedValue(sampleProgress);
    // Default: no intro for the stage — card hidden unless a test opts in.
    mockStageIntro.mockRejectedValue({ detail: 'content_not_found' });
  });

  it('shows loading spinner initially', () => {
    mockStagesList.mockReturnValue(new Promise(() => {}));

    const { getByTestId } = render(<CourseScreen />);
    expect(getByTestId('course-loading')).toBeTruthy();
  });

  it('renders stage selector after loading', async () => {
    const { getByTestId } = render(<CourseScreen />);

    await waitFor(() => {
      expect(getByTestId('stage-selector')).toBeTruthy();
    });
  });

  it('renders the stage selector and content list inside the shared content-capped container', async () => {
    const { getByTestId } = render(<CourseScreen />);

    await waitFor(() => expect(getByTestId('stage-selector')).toBeTruthy());

    const container = getByTestId('content-container');
    expect(within(container).getByTestId('stage-selector')).toBeTruthy();
    expect(within(container).getByTestId('content-list')).toBeTruthy();
  });

  it('selects completed_count + 1 as the default stage (backend-truth mirror)', async () => {
    // BUG-FE-COURSE-001: stage 1 is complete, stage 2 is in progress →
    // default selection is the first unfinished stage, not the highest
    // unlocked one.  This mirrors backend `next_stage_for` so a client
    // cannot skip ahead by exploiting drift between `is_unlocked` and
    // `progress`.
    const { getByTestId } = render(<CourseScreen />);

    await waitFor(() => {
      expect(mockStageContent).toHaveBeenCalledWith(2);
      expect(mockStageProgress).toHaveBeenCalledWith(2);
      expect(getByTestId('stage-selector')).toBeTruthy();
    });
  });

  it('displays stage metadata for selected stage', async () => {
    const { getByTestId, getByText } = render(<CourseScreen />);

    await waitFor(() => {
      expect(getByTestId('stage-metadata')).toBeTruthy();
      expect(getByText('Stage 2')).toBeTruthy();
      expect(getByText('Second stage')).toBeTruthy();
    });
  });

  it('displays progress bar with correct completion count', async () => {
    const { getByTestId, getByText } = render(<CourseScreen />);

    await waitFor(() => {
      expect(getByTestId('progress-bar')).toBeTruthy();
      expect(getByText('1/2 completed')).toBeTruthy();
    });
  });

  it('renders the stage cover with the serif stage name and reading progress', async () => {
    const { getByTestId, getByText } = render(<CourseScreen />);

    await waitFor(() => {
      expect(getByTestId('stage-cover')).toBeTruthy();
      expect(getByTestId('stage-cover-progress')).toBeTruthy();
      // The cover shows the serif stage title and its own reading-progress line.
      expect(getByText('Stage 2')).toBeTruthy();
      expect(getByText('1 of 2 read')).toBeTruthy();
    });
  });

  it('celebrates on the cover when the stage is fully read', async () => {
    mockStageProgress.mockResolvedValue({ total_items: 2, read_items: 2, progress_percent: 100 });
    const { getByText, getByTestId } = render(<CourseScreen />);

    await waitFor(() => {
      expect(getByTestId('stage-cover-celebration')).toBeTruthy();
      expect(getByText('✓ Stage complete')).toBeTruthy();
    });
  });

  it('renders content items in the list', async () => {
    const { getByText } = render(<CourseScreen />);

    await waitFor(() => {
      expect(getByText('Welcome Essay')).toBeTruthy();
      expect(getByText('Reflection Prompt')).toBeTruthy();
    });
  });

  it('loads new content when a different stage is selected', async () => {
    const { getByTestId } = render(<CourseScreen />);

    await waitFor(() => {
      expect(getByTestId('stage-selector')).toBeTruthy();
    });

    // Tap stage 1
    await act(async () => {
      fireEvent.press(getByTestId('stage-pill-1'));
    });

    await waitFor(() => {
      expect(mockStageContent).toHaveBeenCalledWith(1);
      expect(mockStageProgress).toHaveBeenCalledWith(1);
    });
  });

  it('keeps the current stage content when a stale fetch for a previously-selected stage resolves late', async () => {
    // Stage 1 is incomplete so it stays the default selection, matching the repro scenario.
    const incompleteStages: Stage[] = [
      makeStage({ id: 1, stage_number: 1, is_unlocked: true, progress: 0 }),
      makeStage({
        id: 2,
        stage_number: 2,
        title: 'Stage 2',
        subtitle: 'Second stage',
        is_unlocked: true,
        progress: 0,
      }),
    ];
    mockStagesList.mockResolvedValue(incompleteStages);

    const stageOneContent: ContentItem[] = [
      {
        id: 11,
        title: 'Stage One Essay',
        content_type: 'essay',
        release_day: 0,
        url: 'https://example.com/one',
        is_locked: false,
        is_read: false,
      },
    ];
    const stageTwoContent: ContentItem[] = [
      {
        id: 21,
        title: 'Stage Two Essay',
        content_type: 'essay',
        release_day: 0,
        url: 'https://example.com/two',
        is_locked: false,
        is_read: false,
      },
    ];

    const deferredCalls: Array<{ stage: number; resolve: (_value: ContentItem[]) => void }> = [];
    mockStageContent.mockImplementation((stage: number) => {
      let resolveCall: (_value: ContentItem[]) => void = () => undefined;
      const promise = new Promise<ContentItem[]>((res) => {
        resolveCall = res;
      });
      deferredCalls.push({ stage, resolve: resolveCall });
      return promise;
    });

    // Narrow the indexed access so a missing deferred call fails loudly instead of silently.
    const resolveDeferred = (index: number, content: ContentItem[]): void => {
      const call = deferredCalls[index];
      if (!call) throw new Error(`No deferred stageContentAll call at index ${index}`);
      call.resolve(content);
    };

    // Several ticks so a resolved Promise.all fully propagates through state, regardless of chain depth.
    const flushMicrotasks = async (): Promise<void> => {
      for (let i = 0; i < 4; i += 1) {
        await act(async () => {
          await Promise.resolve();
        });
      }
    };

    const { getByTestId, getByText, queryByText } = render(<CourseScreen />);

    await waitFor(() => expect(deferredCalls.length).toBe(1));
    resolveDeferred(0, stageOneContent);
    await flushMicrotasks();
    await waitFor(() => expect(getByText('Stage One Essay')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('stage-pill-2'));
    });
    await waitFor(() => expect(deferredCalls.length).toBe(2));

    await act(async () => {
      fireEvent.press(getByTestId('stage-pill-1'));
    });
    await waitFor(() => expect(deferredCalls.length).toBe(3));

    // Resolve the current stage-1 fetch first.
    resolveDeferred(2, stageOneContent);
    await flushMicrotasks();

    // Then resolve the stale stage-2 fetch that was left hanging from the earlier tap.
    resolveDeferred(1, stageTwoContent);
    await flushMicrotasks();

    expect(within(getByTestId('content-list')).getByText('Stage One Essay')).toBeTruthy();
    expect(queryByText('Stage Two Essay')).toBeNull();
  });

  it('opens content viewer when tapping an unlocked item', async () => {
    const { getByText, getByTestId } = render(<CourseScreen />);

    await waitFor(() => {
      expect(getByText('Welcome Essay')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(getByTestId('content-card-1'));
    });

    await waitFor(() => {
      expect(getByTestId('chapter-reader')).toBeTruthy();
    });
  });

  it('does not open viewer when tapping a locked item', async () => {
    const { getByText, getByTestId, queryByTestId } = render(<CourseScreen />);

    await waitFor(() => {
      expect(getByText('Reflection Prompt')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(getByTestId('content-card-2'));
    });

    expect(queryByTestId('chapter-reader')).toBeNull();
  });

  it('opens a site resource in the reader and returns to the course on back', async () => {
    const { getByTestId, findByText, queryByTestId } = render(<CourseScreen />);

    await waitFor(() => expect(getByTestId('site-resources-panel')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('site-resource-chip-philosophy'));
    });

    await waitFor(() => expect(getByTestId('chapter-reader')).toBeTruthy());
    expect(mockSiteResourceBody).toHaveBeenCalledWith('philosophy');
    await findByText('philosophy');

    await act(async () => {
      fireEvent.press(getByTestId('reader-back-button'));
    });

    expect(queryByTestId('chapter-reader')).toBeNull();
    expect(getByTestId('stage-selector')).toBeTruthy();
  });

  it('returns from content viewer when back is pressed', async () => {
    const { getByText, getByTestId, queryByTestId } = render(<CourseScreen />);

    await waitFor(() => {
      expect(getByText('Welcome Essay')).toBeTruthy();
    });

    // Open viewer
    await act(async () => {
      fireEvent.press(getByTestId('content-card-1'));
    });

    await waitFor(() => {
      expect(getByTestId('chapter-reader')).toBeTruthy();
    });

    // Go back
    await act(async () => {
      fireEvent.press(getByTestId('reader-back-button'));
    });

    await waitFor(() => {
      expect(queryByTestId('chapter-reader')).toBeNull();
      expect(getByTestId('content-list')).toBeTruthy();
    });
  });

  it('shows empty state when no content exists', async () => {
    mockStageContent.mockResolvedValue([]);

    const { getByText } = render(<CourseScreen />);

    await waitFor(() => {
      expect(getByText('No Content Yet')).toBeTruthy();
    });
  });

  it('navigates to Journal with reflection params when Reflect is pressed', async () => {
    // Use content that is already read so the reflect button appears
    mockStageContent.mockResolvedValue([
      {
        id: 1,
        title: 'Welcome Essay',
        content_type: 'essay',
        release_day: 0,
        url: 'https://example.com/essay',
        is_locked: false,
        is_read: true,
      },
    ]);

    const { getByText, getByTestId } = render(<CourseScreen />);

    await waitFor(() => {
      expect(getByText('Welcome Essay')).toBeTruthy();
    });

    // Open the content viewer
    await act(async () => {
      fireEvent.press(getByTestId('content-card-1'));
    });

    await waitFor(() => {
      expect(getByTestId('chapter-reader')).toBeTruthy();
    });

    // Press reflect button
    await act(async () => {
      fireEvent.press(getByTestId('reflect-button'));
    });

    expect(mockNavigate).toHaveBeenCalledWith(
      'JournalEntry',
      expect.objectContaining({ prefillTitle: 'Stage 2 reflection — Welcome Essay' }),
    );
  });

  it('renders the stage intro card and opens it in the reader when an intro exists', async () => {
    mockStageIntro.mockResolvedValue({
      stage: 1,
      id: 'beige-intro',
      slug: 'beige-introduction',
      title: 'Welcome to Beige',
      summary: 'What Beige is about.',
    });

    const { getByTestId, getByText } = render(<CourseScreen />);

    await waitFor(() => {
      expect(getByTestId('stage-intro-card')).toBeTruthy();
    });
    expect(getByText('Welcome to Beige')).toBeTruthy();
    expect(getByText('What Beige is about.')).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByTestId('stage-intro-card'));
    });

    await waitFor(() => {
      expect(getByTestId('chapter-reader')).toBeTruthy();
    });
  });

  it('shows no intro card and no error banner when the stage has no intro', async () => {
    // Default mockStageIntro rejects with a 404 — a normal, non-error state.
    const { getByText, queryByTestId } = render(<CourseScreen />);

    await waitFor(() => {
      expect(getByText('Welcome Essay')).toBeTruthy();
    });
    expect(queryByTestId('stage-intro-card')).toBeNull();
    expect(queryByTestId('course-error')).toBeNull();
  });

  it('refetches the intro when the stage changes', async () => {
    mockStageIntro.mockResolvedValue({
      stage: 1,
      id: 'beige-intro',
      slug: 'beige-introduction',
      title: 'Welcome to Beige',
      summary: null,
    });

    const { getByTestId } = render(<CourseScreen />);
    await waitFor(() => {
      expect(getByTestId('stage-selector')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(getByTestId('stage-pill-2'));
    });

    await waitFor(() => {
      expect(mockStageIntro).toHaveBeenCalledWith(2);
    });
  });
});

describe('single scroll surface', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStagesList.mockResolvedValue(sampleStages);
    mockStageContent.mockResolvedValue(sampleContent);
    mockStageProgress.mockResolvedValue(sampleProgress);
    mockStageIntro.mockRejectedValue({ detail: 'content_not_found' });
  });

  it('hosts the stage header inside the chapter list', async () => {
    const { getByTestId } = render(<CourseScreen />);

    await waitFor(() => {
      expect(getByTestId('content-list')).toBeTruthy();
    });

    const list = within(getByTestId('content-list'));
    expect(list.getByTestId('stage-cover')).toBeTruthy();
    expect(list.getByTestId('stage-metadata')).toBeTruthy();
    expect(list.getByTestId('progress-bar')).toBeTruthy();
    expect(list.getByText('Chapters')).toBeTruthy();
  });

  it('keeps a single scrollable surface with the cover when the stage is empty', async () => {
    mockStageContent.mockResolvedValue([]);

    const { getByTestId } = render(<CourseScreen />);

    await waitFor(() => {
      expect(getByTestId('content-list')).toBeTruthy();
    });

    const list = within(getByTestId('content-list'));
    expect(list.getByTestId('stage-cover')).toBeTruthy();
    expect(list.getByText('No Content Yet')).toBeTruthy();
  });

  it('keeps the header on the same surface when content fails, and recovers on retry', async () => {
    mockStageContent.mockRejectedValueOnce(new Error('boom'));

    const { getByTestId } = render(<CourseScreen />);

    await waitFor(() => {
      expect(getByTestId('content-list')).toBeTruthy();
    });

    const listOnError = within(getByTestId('content-list'));
    expect(listOnError.getByTestId('course-error')).toBeTruthy();
    expect(getByTestId('stage-cover')).toBeTruthy();

    await act(async () => {
      fireEvent.press(listOnError.getByTestId('course-retry'));
    });

    await waitFor(() => {
      expect(within(getByTestId('content-list')).getByText('Welcome Essay')).toBeTruthy();
    });
    expect(within(getByTestId('content-list')).queryByTestId('course-error')).toBeNull();
  });

  it('renders both the header and chapter items in the same list', async () => {
    const { getByTestId } = render(<CourseScreen />);

    await waitFor(() => {
      expect(getByTestId('content-list')).toBeTruthy();
    });

    const list = within(getByTestId('content-list'));
    expect(list.getByText('Welcome Essay')).toBeTruthy();
    expect(list.getByTestId('stage-cover')).toBeTruthy();
  });
});

// Pins the rendered Spiral-Dynamics accent so the shared color resolver can
// never silently change what the cover and progress bar are tinted with.
describe('CourseScreen Spiral-Dynamics accent colors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStagesList.mockResolvedValue(sampleStages);
    mockStageContent.mockResolvedValue(sampleContent);
    mockStageProgress.mockResolvedValue(sampleProgress);
    mockStageIntro.mockRejectedValue({ detail: 'content_not_found' });
  });

  it('tints the stage cover progress with the selected stage color', async () => {
    // Default selection is stage 2 (Purple).
    const { getByTestId } = render(<CourseScreen />);

    await waitFor(() => {
      expect(backgroundColorOf(getByTestId('stage-cover-progress').props.style)).toBe(
        STAGE_COLORS['Purple'],
      );
    });
  });

  it('tints the course progress bar fill with the same selected stage color', async () => {
    const { getByTestId } = render(<CourseScreen />);

    await waitFor(() => {
      expect(backgroundColorOf(getByTestId('progress-bar-fill').props.style)).toBe(
        STAGE_COLORS['Purple'],
      );
    });
  });

  it('falls back to the neutral color when the stage color is unrecognized', async () => {
    const mauveStages: Stage[] = [
      makeStage({ id: 1, stage_number: 1, is_unlocked: true, progress: 1 }),
      makeStage({
        id: 2,
        stage_number: 2,
        spiral_dynamics_color: 'Mauve',
        is_unlocked: true,
        progress: 0,
      }),
    ];
    mockStagesList.mockResolvedValue(mauveStages);

    const { getByTestId } = render(<CourseScreen />);

    await waitFor(() => {
      expect(backgroundColorOf(getByTestId('stage-cover-progress').props.style)).toBe(
        colors.neutral,
      );
      expect(backgroundColorOf(getByTestId('progress-bar-fill').props.style)).toBe(colors.neutral);
    });
  });
});
