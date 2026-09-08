/* eslint-env jest */
// The Course cold start's last dead end: `loading` only flips back when the
// stage-list request settles, so a dropped connection, a backgrounded app or a
// proxy holding the socket open left the spinner up for good with nothing to
// press. These tests drive a request that never answers and pin the bounded
// wait — the spinner for as long as the wait runs, then a message and the same
// explicit "Try again", and retrying re-arming the wait rather than leaving a
// stale message on screen. Modelled on
// frontend/src/features/Map/__tests__/MapScreenColdStart.test.tsx.
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import type { ContentItem, CourseProgress, Stage } from '../../../api';

const TRY_AGAIN = 'Try again';

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
const mockProgramCalendar = jest.fn(() =>
  Promise.resolve({
    program_started_at: null as string | null,
    calendar_stage: 1,
    calendar_week: 1,
    current_stage: 1,
    cycle_number: 1,
  }),
);

jest.mock('../../../api', () => ({
  stages: {
    listAll: (...a: unknown[]) => mockStagesList(...a),
    programCalendar: () => mockProgramCalendar(),
  },
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

jest.mock('../../../navigation/hooks', () => ({
  useAppRoute: () => ({ key: 'Course-test', name: 'Course', params: undefined }),
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
const { render, fireEvent, act } = require('@testing-library/react-native');
// The suite requires the screen after the mock consts above are initialised —
// a static import would pull it in first and hit them in their temporal dead
// zone. Every other CourseScreen suite loads it the same way.
const CourseScreenModule = require('../CourseScreen');
const CourseScreen = CourseScreenModule.default;
const TIMEOUT_MS: number = CourseScreenModule.COURSE_LOADING_TIMEOUT_MS;

describe('CourseScreen — the cold-start spinner has a bounded wait', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockStageContent.mockResolvedValue(sampleContent);
    mockStageProgress.mockResolvedValue(sampleProgress);
    // A stage list that never answers is the whole scenario: `loading` never
    // flips back on its own, so only the bounded wait can end the spinner.
    mockStagesList.mockImplementation(() => new Promise<Stage[]>(() => {}));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('agrees with the Map about how long a person is asked to wait', () => {
    // Named and valued consistently with MAP_LOADING_TIMEOUT_MS so the two
    // cold starts cannot drift apart.
    const { MAP_LOADING_TIMEOUT_MS } = require('../../Map/MapScreen');

    expect(TIMEOUT_MS).toBe(MAP_LOADING_TIMEOUT_MS);
  });

  it('holds the bare spinner for as long as the bounded wait runs', () => {
    // A normal fast load must never flicker the timeout copy on its way past.
    const view = render(<CourseScreen />);

    act(() => {
      jest.advanceTimersByTime(TIMEOUT_MS - 1);
    });

    expect(view.getByTestId('course-loading')).toBeTruthy();
    expect(view.queryByTestId('course-loading-timeout')).toBeNull();
    expect(view.queryByTestId('course-loading-retry')).toBeNull();
    act(() => view.unmount());
  });

  it('offers a way forward once the spinner outlasts the bounded wait', () => {
    const view = render(<CourseScreen />);

    act(() => {
      jest.advanceTimersByTime(TIMEOUT_MS);
    });

    const container = view.getByTestId('course-loading-timeout');
    expect(container.props.accessibilityRole).toBe('alert');
    expect(container.props.accessibilityLiveRegion).toBe('polite');
    expect(view.queryByTestId('course-loading')).toBeNull();

    const retry = view.getByTestId('course-loading-retry');
    expect(retry.props.accessibilityRole).toBe('button');
    expect(retry.props.accessibilityLabel).toBe(TRY_AGAIN);
    act(() => view.unmount());
  });

  it('re-arms the wait when the reader tries again', () => {
    const view = render(<CourseScreen />);

    act(() => {
      jest.advanceTimersByTime(TIMEOUT_MS);
    });
    expect(mockStagesList).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.press(view.getByTestId('course-loading-retry'));
    });

    // The second attempt gets the spinner back, not the stale dead end, and it
    // is a real second attempt: `retry` is the existing loader's own `init`.
    expect(mockStagesList).toHaveBeenCalledTimes(2);
    expect(view.getByTestId('course-loading')).toBeTruthy();
    expect(view.queryByTestId('course-loading-timeout')).toBeNull();

    // ...and the re-armed wait still ends, rather than running out once only.
    act(() => {
      jest.advanceTimersByTime(TIMEOUT_MS);
    });
    expect(view.getByTestId('course-loading-timeout')).toBeTruthy();
    act(() => view.unmount());
  });

  it('drops the timer on unmount, so it never fires into a dead tree', () => {
    // Counted before the clock is advanced, not after: advancing runs the
    // pending timer and empties the queue either way, which would let a
    // missing cleanup pass. A settled request ends the same way — `loading`
    // flips, this component unmounts, and the cleanup below is what runs.
    const view = render(<CourseScreen />);
    expect(jest.getTimerCount()).toBe(1);

    act(() => view.unmount());

    expect(jest.getTimerCount()).toBe(0);
  });
});
