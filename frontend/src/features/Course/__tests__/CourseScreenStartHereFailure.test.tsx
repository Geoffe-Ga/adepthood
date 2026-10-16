// #3344: on bare Course entry the stage list can load while the Start Here
// resources or progress read fails. Unknown progress stays unknown -- it can
// neither establish completion nor hide the chapter navigation that loaded.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { render, fireEvent, act, within } from '@testing-library/react-native';
import { useSyncExternalStore, type ReactElement } from 'react';

import type { ContentItem, CourseProgress, NextUnread, SiteResource, Stage } from '../../../api';
import CourseScreen from '../CourseScreen';
import { START_HERE_ERROR_COPY } from '../StartHereSection';
import { useStartHereStore } from '../startHereStore';

import { setActiveUser } from '@/storage/userScope';
import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';
import { settle } from '@/testing/asyncSettle';

const makeStage = (stageNumber: number): Stage => ({
  id: stageNumber,
  title: `Stage ${stageNumber}`,
  subtitle: `Subtitle ${stageNumber}`,
  stage_number: stageNumber,
  overview_url: 'https://example.com',
  category: 'foundation',
  aspect: 'body',
  spiral_dynamics_color: 'Beige',
  growing_up_stage: 'Archaic',
  divine_gender_polarity: 'neutral',
  relationship_to_free_will: 'reactive',
  free_will_description: 'Instinctual survival',
  is_unlocked: stageNumber <= 2,
  progress: 0,
});

const STAGES: Stage[] = [1, 2, 3].map(makeStage);
const CHAPTER: ContentItem = {
  id: 11,
  title: 'Healthy Chapter',
  content_type: 'essay',
  release_day: 0,
  url: 'https://example.com/essay',
  is_locked: false,
  is_read: false,
};
const STAGE_PROGRESS: CourseProgress = {
  total_items: 1,
  read_items: 0,
  progress_percent: 0,
  next_unlock_day: null,
};
const START_HERE_PROGRESS: CourseProgress = {
  total_items: 2,
  read_items: 1,
  progress_percent: 50,
  next_unlock_day: null,
};
const resource = (slug: string, order: number, isRead: boolean): SiteResource => ({
  slug,
  title: `Resource ${slug}`,
  description: `About ${slug}`,
  url: `https://example.com/${slug}`,
  order,
  is_read: isRead,
});
// Served out of order: the confirmed ordering comes from ``order``.
const RESOURCES: SiteResource[] = [resource('second', 2, false), resource('first', 1, true)];
const NEXT_RESOURCE: NextUnread = {
  kind: 'resource',
  slug: 'second',
  content_id: null,
  stage_number: null,
  title: 'Resource second',
};

const mockStagesList = jest.fn<(...a: unknown[]) => Promise<Stage[]>>();
const mockSiteResources = jest.fn<(...a: unknown[]) => Promise<SiteResource[]>>();
const mockStartHereProgress = jest.fn<(...a: unknown[]) => Promise<CourseProgress>>();
const mockNextUnread = jest.fn<() => Promise<NextUnread | null>>();
const mockUiFlags = jest.fn(() => Promise.resolve({ course_last_stage: 2 }));
const mockStageContent = jest.fn<(stageNumber: number) => Promise<ContentItem[]>>();

jest.mock('@/context/AuthContext', () => require('./authContextTestKit'));

jest.mock('../../../api', () => ({
  captureSessionToken: () => 'e30.eyJzdWIiOiIxIiwiZXhwIjo0MTAyNDQ0ODAwfQ.signature',
  uiFlags: { get: () => mockUiFlags() },
  stages: {
    listAll: (...a: unknown[]) => mockStagesList(...a),
    programCalendar: () => Promise.resolve({ current_stage: 1 }),
  },
  course: {
    nextUnread: () => mockNextUnread(),
    stageContentAll: (stageNumber: number) => mockStageContent(stageNumber),
    stageProgress: () => Promise.resolve(STAGE_PROGRESS),
    markRead: jest.fn(),
    contentBody: () =>
      Promise.resolve({ title: 'Healthy Chapter', content_type: 'essay', body_markdown: 'x\n' }),
    startHereProgress: (...a: unknown[]) => mockStartHereProgress(...a),
    siteResources: (...a: unknown[]) => mockSiteResources(...a),
    siteResourceBody: jest.fn(),
    stageIntro: () => Promise.reject(new Error('content_not_found')),
    stageIntroBody: jest.fn(),
  },
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), setParams: jest.fn() }),
}));

const headerLeftStore: {
  current: (() => ReactElement) | undefined;
  listeners: Set<() => void>;
} = { current: undefined, listeners: new Set() };
const mockSetOptions = jest.fn((opts: { headerLeft?: () => ReactElement }) => {
  headerLeftStore.current = opts.headerLeft;
  headerLeftStore.listeners.forEach((listener) => listener());
});
jest.mock('../../../navigation/hooks', () => ({
  useAppRoute: () => ({ key: 'Course-test', name: 'Course', params: undefined }),
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: mockSetOptions }),
}));

jest.mock('react-native-safe-area-context', () => {
  const ReactMod = require('react');
  return {
    SafeAreaView: ({ children }: { children: unknown }) =>
      ReactMod.createElement(ReactMod.Fragment, null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

const subscribeHeaderLeft = (onChange: () => void): (() => void) => {
  headerLeftStore.listeners.add(onChange);
  return () => headerLeftStore.listeners.delete(onChange);
};

const CourseScreenWithHeader = (): ReactElement => {
  const headerLeft = useSyncExternalStore(subscribeHeaderLeft, () => headerLeftStore.current);
  return (
    <>
      {headerLeft === undefined ? null : headerLeft()}
      <CourseScreen />
    </>
  );
};

type FailingRead = 'site-resources' | 'start-here/progress';
const FAILING_READS: FailingRead[] = ['site-resources', 'start-here/progress'];

function failOnce(read: FailingRead): void {
  const mock = read === 'site-resources' ? mockSiteResources : mockStartHereProgress;
  mock.mockRejectedValueOnce(new Error('503'));
}

beforeEach(() => {
  jest.clearAllMocks();
  headerLeftStore.current = undefined;
  headerLeftStore.listeners.clear();
  setActiveUser(1);
  useStartHereStore.getState().reset();
  useDepthPreferencesStore.setState({
    enable_habits: false,
    enable_practices: true,
    enable_course: true,
  });
  mockStagesList.mockResolvedValue(STAGES);
  mockSiteResources.mockResolvedValue(RESOURCES);
  mockStartHereProgress.mockResolvedValue(START_HERE_PROGRESS);
  mockNextUnread.mockResolvedValue(NEXT_RESOURCE);
  mockStageContent.mockResolvedValue([CHAPTER]);
});

describe.each(FAILING_READS)('bare Course entry when %s fails', (read) => {
  it('keeps the stage navigation and reports the failed Start Here read inline', async () => {
    failOnce(read);
    const view = render(<CourseScreenWithHeader />);
    await settle();

    expect(view.queryByTestId('course-error')).toBeNull();
    expect(view.getByTestId('stage-selector')).toBeTruthy();
    expect(view.getByTestId('stage-pill-1').props.accessibilityState.disabled).toBe(false);
    // Unknown progress lands on Start Here, never on the saved Frequency it
    // could only reach by assuming every resource is read.
    expect(view.getByTestId('start-here-pill').props.accessibilityState.selected).toBe(true);
    expect(mockUiFlags).not.toHaveBeenCalled();
    const section = within(view.getByTestId('start-here-section'));
    expect(section.getByText(START_HERE_ERROR_COPY)).toBeTruthy();
    expect(section.getByLabelText('Try again')).toBeTruthy();
    expect(section.queryByText(/of \d+ read/)).toBeNull();
    expect(view.queryByTestId('start-here-resource-first')).toBeNull();
  });

  it('still opens a healthy chapter from the stage pills and the drawer', async () => {
    failOnce(read);
    const view = render(<CourseScreenWithHeader />);
    await settle();

    fireEvent.press(view.getByTestId('stage-pill-1'));
    await settle();
    expect(mockStageContent).toHaveBeenCalledWith(1);
    fireEvent.press(view.getByTestId(`content-card-${CHAPTER.id}`));
    await settle();
    expect(view.getByTestId('chapter-reader')).toBeTruthy();

    fireEvent.press(view.getByTestId('reader-back-button'));
    await settle();
    fireEvent.press(view.getByLabelText('Open Course menu'));
    await settle();
    expect(view.getByTestId('course-drawer-stage-1')).toBeTruthy();
    expect(view.getByTestId('course-drawer-stage-2')).toBeTruthy();
    expect(
      within(view.getByTestId('course-drawer-start-here')).getByText(
        "Start Here couldn't load. Tap to retry.",
      ),
    ).toBeTruthy();
  });

  it('restores ordering, progress, read marks and Read next on an explicit retry', async () => {
    failOnce(read);
    mockNextUnread.mockRejectedValueOnce(new Error('503'));
    const view = render(<CourseScreenWithHeader />);
    await settle();
    expect(view.queryByTestId('read-next')).toBeNull();
    const nextUnreadAsks = mockNextUnread.mock.calls.length;

    await act(async () => {
      fireEvent.press(view.getByLabelText('Try again'));
    });
    await settle();

    expect(view.queryByText(START_HERE_ERROR_COPY)).toBeNull();
    expect(view.getByText('1 of 2 read')).toBeTruthy();
    const first = view.getByTestId('start-here-resource-first');
    const second = view.getByTestId('start-here-resource-second');
    expect(first.props.accessibilityLabel).toBe('Open Resource first, read');
    expect(second.props.accessibilityLabel).toBe('Open Resource second');
    const labels = view
      .getAllByLabelText(/^Open Resource /)
      .map((node: { props: { accessibilityLabel: string } }) => node.props.accessibilityLabel);
    expect(labels).toEqual(['Open Resource first, read', 'Open Resource second']);
    expect(mockNextUnread.mock.calls.length).toBe(nextUnreadAsks + 1);
    expect(view.getByTestId('read-next').props.accessibilityLabel).toBe(
      'Read next: Resource second',
    );
    // The retry answers Start Here; it does not move the reader's selection.
    expect(view.getByTestId('start-here-pill').props.accessibilityState.selected).toBe(true);
  });
});

it('keeps the inline error and the stage navigation when the retry also fails', async () => {
  mockSiteResources.mockRejectedValue(new Error('503'));
  const view = render(<CourseScreenWithHeader />);
  await settle();
  await act(async () => {
    fireEvent.press(view.getByLabelText('Try again'));
  });
  await settle();
  expect(view.getByText(START_HERE_ERROR_COPY)).toBeTruthy();
  expect(view.getByTestId('stage-pill-2')).toBeTruthy();
  expect(mockSiteResources).toHaveBeenCalledTimes(2);
});
