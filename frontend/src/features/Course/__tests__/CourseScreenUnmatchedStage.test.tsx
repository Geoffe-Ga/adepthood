/* eslint-env jest */
// When a route stageNumber has no matching entry in the loaded stage list,
// selectedStageData stays undefined for the life of the render. Pins the
// header's conditional branches (stage cover / metadata hidden) and the
// progress bar's spiralColor fallback for that case.
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
const sampleContent: ContentItem[] = [];
const sampleProgress: CourseProgress = {
  total_items: 0,
  read_items: 0,
  progress_percent: 0,
  next_unlock_day: null,
};

const mockStagesList = jest.fn<(...a: unknown[]) => Promise<Stage[]>>();
const mockStageContent = jest.fn<(...a: unknown[]) => Promise<ContentItem[]>>();
const mockStageProgress = jest.fn<(...a: unknown[]) => Promise<CourseProgress>>();

jest.mock('../../../api', () => ({
  stages: { listAll: (...a: unknown[]) => mockStagesList(...a) },
  course: {
    stageContentAll: (...a: unknown[]) => mockStageContent(...a),
    stageProgress: (...a: unknown[]) => mockStageProgress(...a),
    markRead: jest.fn(),
    contentBody: jest.fn(),
    siteResources: () => Promise.resolve([]),
    siteResourceBody: jest.fn(),
    stageIntro: () => Promise.reject(new Error('content_not_found')),
    stageIntroBody: jest.fn(),
  },
}));

// Route requests stage 99, which is not in the loaded stage list.
// CourseScreen installs its header-left drawer toggle through useAppNavigation
// (useScreenDrawer), which calls navigation.setOptions in a layout effect on
// every mount -- without this mock every test below would crash reading
// setOptions off an undefined navigation object.
jest.mock('../../../navigation/hooks', () => ({
  useAppRoute: () => ({ key: 'Course-test', name: 'Course', params: { stageNumber: 99 } }),
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
}));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
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
const { render, waitFor } = require('@testing-library/react-native');
const CourseScreen = require('../CourseScreen').default;

describe('CourseScreen with an unmatched route stage number', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStagesList.mockResolvedValue(sampleStages);
    mockStageContent.mockResolvedValue(sampleContent);
    mockStageProgress.mockResolvedValue(sampleProgress);
  });

  it('hides the stage cover and metadata when the route stage is not in the loaded list', async () => {
    const view = render(<CourseScreen />);

    await waitFor(() => expect(view.getByTestId('content-list')).toBeTruthy());
    expect(view.queryByTestId('stage-cover')).toBeNull();
    expect(view.queryByTestId('stage-metadata')).toBeNull();
    await waitFor(() => expect(view.getByText('0/0 completed')).toBeTruthy());
    expect(view.getByText('No Content Yet')).toBeTruthy();
  });
});
