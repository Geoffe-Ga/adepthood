/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-env jest */
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

jest.mock('../../../api', () => ({
  stages: {
    list: (...args: unknown[]) => mockStagesList(...args),
  },
  course: {
    stageContent: (...args: unknown[]) => mockStageContent(...args),
    stageProgress: (...args: unknown[]) => mockStageProgress(...args),
    markRead: (...args: unknown[]) => mockMarkRead(...args),
  },
}));

const mockNavigate = jest.fn() as any;
jest.mock('../../../navigation/hooks', () => ({
  useAppRoute: () => ({ key: 'Course-test', name: 'Course', params: undefined }),
  useAppNavigation: () => ({ navigate: mockNavigate }),
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

describe('CourseScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStagesList.mockResolvedValue(sampleStages);
    mockStageContent.mockResolvedValue(sampleContent);
    mockStageProgress.mockResolvedValue(sampleProgress);
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

  it('opens content viewer when tapping an unlocked item', async () => {
    const { getByText, getByTestId } = render(<CourseScreen />);

    await waitFor(() => {
      expect(getByText('Welcome Essay')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(getByTestId('content-card-1'));
    });

    await waitFor(() => {
      expect(getByTestId('content-viewer')).toBeTruthy();
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

    expect(queryByTestId('content-viewer')).toBeNull();
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
      expect(getByTestId('content-viewer')).toBeTruthy();
    });

    // Go back
    await act(async () => {
      fireEvent.press(getByTestId('viewer-back-button'));
    });

    await waitFor(() => {
      expect(queryByTestId('content-viewer')).toBeNull();
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
      expect(getByTestId('content-viewer')).toBeTruthy();
    });

    // Press reflect button
    await act(async () => {
      fireEvent.press(getByTestId('reflect-button'));
    });

    expect(mockNavigate).toHaveBeenCalledWith('Journal', {
      tag: 'stage_reflection',
      stageNumber: 2,
      contentTitle: 'Welcome Essay',
    });
  });
});
