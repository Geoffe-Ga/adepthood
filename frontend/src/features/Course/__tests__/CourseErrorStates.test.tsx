/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-env jest */
// audit-ux-04: a failed stage-list / content fetch must show error+retry, not
// masquerade as an empty course or a permanent "Loading..." progress bar.
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
    id: 1,
    title: 'Welcome Essay',
    content_type: 'essay',
    release_day: 0,
    url: 'https://example.com/essay',
    is_locked: false,
    is_read: false,
  },
];
const sampleProgress: CourseProgress = {
  total_items: 1,
  read_items: 0,
  progress_percent: 0,
  next_unlock_day: null,
};

const mockStagesList = jest.fn() as any;
const mockStageContent = jest.fn() as any;
const mockStageProgress = jest.fn() as any;

jest.mock('../../../api', () => ({
  stages: { listAll: (...a: unknown[]) => mockStagesList(...a) },
  course: {
    stageContentAll: (...a: unknown[]) => mockStageContent(...a),
    stageProgress: (...a: unknown[]) => mockStageProgress(...a),
    markRead: jest.fn(),
    contentBody: jest.fn(),
    siteResources: (jest.fn() as any).mockResolvedValue([]),
    siteResourceBody: jest.fn(),
  },
}));

jest.mock('../../../navigation/hooks', () => ({
  useAppRoute: () => ({ key: 'Course-test', name: 'Course', params: undefined }),
  useAppNavigation: () => ({ navigate: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => {
  const ReactMod = require('react');
  return {
    SafeAreaView: ({ children }: { children: unknown }) =>
      ReactMod.createElement(ReactMod.Fragment, null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

// eslint-disable-next-line import/order
const { render, waitFor, fireEvent, act } = require('@testing-library/react-native');
const CourseScreen = require('../CourseScreen').default;

describe('CourseScreen error + retry states', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStagesList.mockResolvedValue(sampleStages);
    mockStageContent.mockResolvedValue(sampleContent);
    mockStageProgress.mockResolvedValue(sampleProgress);
  });

  it('shows error+retry (not empty) when the stage list fails, and retry recovers', async () => {
    mockStagesList.mockRejectedValueOnce(new Error('network'));
    const view = render(<CourseScreen />);

    await waitFor(() => expect(view.getByTestId('course-error')).toBeTruthy());
    expect(view.queryByText('No Content Yet')).toBeNull();

    // Retry succeeds → the error clears and the stage selector renders.
    await act(async () => {
      fireEvent.press(view.getByTestId('course-retry'));
    });
    await waitFor(() => expect(view.getByTestId('stage-selector')).toBeTruthy());
    expect(view.queryByTestId('course-error')).toBeNull();
    expect(mockStagesList).toHaveBeenCalledTimes(2);
  });

  it('shows content error+retry (not "No Content Yet") and an unavailable progress label', async () => {
    mockStageContent.mockRejectedValueOnce(new Error('boom'));
    const view = render(<CourseScreen />);

    await waitFor(() => expect(view.getByTestId('course-error')).toBeTruthy());
    expect(view.queryByText('No Content Yet')).toBeNull();
    expect(view.getByText('Progress unavailable')).toBeTruthy();
    expect(view.queryByText('Loading...')).toBeNull();

    // Retry re-runs the content fetch; this time it resolves with items.
    await act(async () => {
      fireEvent.press(view.getByTestId('course-retry'));
    });
    await waitFor(() => expect(view.getByTestId('content-list')).toBeTruthy());
    expect(view.queryByTestId('course-error')).toBeNull();
    expect(mockStageContent).toHaveBeenCalledTimes(2);
  });

  it('still shows "No Content Yet" for a genuinely empty stage', async () => {
    mockStageContent.mockResolvedValue([]);
    mockStageProgress.mockResolvedValue({
      total_items: 0,
      read_items: 0,
      progress_percent: 0,
      next_unlock_day: null,
    });
    const view = render(<CourseScreen />);

    await waitFor(() => expect(view.getByText('No Content Yet')).toBeTruthy());
    expect(view.queryByTestId('course-error')).toBeNull();
  });
});
