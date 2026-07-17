/* eslint-env jest */
// RED coverage for the shared DrawerNavSection wired into the Course header
// drawer. Mirrors CourseDrawer.test.tsx's headerLeftStore harness, adding a
// stable navigate spy so the shared nav rows have somewhere to route.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { render, waitFor, fireEvent, act } from '@testing-library/react-native';
import { useSyncExternalStore, type ReactElement } from 'react';

import type { ContentItem, CourseProgress, Stage } from '../../../api';
import CourseScreen from '../CourseScreen';

import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';

const makeStage = (overrides: Partial<Stage> = {}): Stage => ({
  id: 1,
  title: 'Stage',
  subtitle: 'Subtitle',
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

const TEN_STAGES: Stage[] = Array.from({ length: 10 }, (_, index) => {
  const stageNumber = index + 1;
  return makeStage({
    id: stageNumber,
    stage_number: stageNumber,
    title: `Stage ${stageNumber}`,
    subtitle: `Subtitle ${stageNumber}`,
    is_unlocked: stageNumber <= 3,
    progress: 0,
  });
});

const sampleProgress: CourseProgress = {
  total_items: 1,
  read_items: 0,
  progress_percent: 0,
  next_unlock_day: null,
};

const mockStagesList = jest.fn<(...a: unknown[]) => Promise<Stage[]>>();
const mockStageContent = jest.fn<(stageNumber: number) => Promise<ContentItem[]>>();
const mockStageProgress = jest.fn<(...a: unknown[]) => Promise<CourseProgress>>();

jest.mock('../../../api', () => ({
  stages: { listAll: (...a: unknown[]) => mockStagesList(...a) },
  course: {
    stageContentAll: (stageNumber: number) => mockStageContent(stageNumber),
    stageProgress: (...a: unknown[]) => mockStageProgress(...a),
    markRead: jest.fn(),
    contentBody: () =>
      Promise.resolve({ title: 'Chapter', content_type: 'chapter', body_markdown: 'x\n' }),
    siteResources: () => Promise.resolve([]),
    siteResourceBody: jest.fn(),
    stageIntro: () => Promise.reject(new Error('content_not_found')),
    stageIntroBody: jest.fn(),
  },
}));

const mockNavigate = jest.fn();
const mockRootNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockRootNavigate }),
}));

// CourseScreen installs its header-left drawer toggle through useAppNavigation
// (useScreenDrawer), which calls navigation.setOptions in a layout effect on
// every mount. The store relays the installed headerLeft into the same render
// tree as the screen so the Modal-based drawer opens in-tree.
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
  useAppNavigation: () => ({ navigate: mockNavigate, setOptions: mockSetOptions }),
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

// Renders the screen's headerLeft toggle in the same tree as the screen, so
// the drawer opens in-tree and its rows are pressable.
const CourseScreenWithHeader = (): ReactElement => {
  const headerLeft = useSyncExternalStore(subscribeHeaderLeft, () => headerLeftStore.current);
  return (
    <>
      {headerLeft === undefined ? null : headerLeft()}
      <CourseScreen />
    </>
  );
};

describe('Course header drawer nav section', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    headerLeftStore.current = undefined;
    headerLeftStore.listeners.clear();
    mockStagesList.mockResolvedValue(TEN_STAGES);
    mockStageContent.mockResolvedValue([]);
    mockStageProgress.mockResolvedValue(sampleProgress);
    useDepthPreferencesStore.setState({
      enable_habits: true,
      enable_practices: true,
      enable_course: true,
    });
  });

  it("renders the nav section before the drawer's own rows, with a trailing divider", async () => {
    const { getByTestId, getByLabelText, toJSON } = render(<CourseScreenWithHeader />);
    await waitFor(() => expect(getByTestId('stage-selector')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Course menu'));
    await waitFor(() => expect(getByTestId('course-drawer-stage-1')).toBeTruthy());

    expect(getByTestId('drawer-nav-Course')).toBeTruthy();
    expect(getByTestId('drawer-nav-divider')).toBeTruthy();

    // toJSON() embeds React elements with circular _owner refs; strip those.
    const seen = new WeakSet();
    const json = JSON.stringify(toJSON(), (key, value) => {
      if (key === '_owner' || key === '_store') return undefined;
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return undefined;
        seen.add(value);
      }
      return value;
    });
    const navIndex = json.indexOf('"testID":"drawer-nav-Course"');
    const stageOneIndex = json.indexOf('"testID":"course-drawer-stage-1"');
    expect(navIndex).toBeGreaterThan(-1);
    expect(stageOneIndex).toBeGreaterThan(-1);
    expect(navIndex).toBeLessThan(stageOneIndex);
  });

  it('marks the Course nav row selected', async () => {
    const { getByTestId, getByLabelText } = render(<CourseScreenWithHeader />);
    await waitFor(() => expect(getByTestId('stage-selector')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Course menu'));

    expect(getByTestId('drawer-nav-Course').props.accessibilityState.selected).toBe(true);
  });

  it('navigating to a different screen from the nav section closes the drawer', async () => {
    const { getByTestId, getByLabelText, queryByTestId } = render(<CourseScreenWithHeader />);
    await waitFor(() => expect(getByTestId('stage-selector')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Course menu'));
    fireEvent.press(getByTestId('drawer-nav-Journal'));

    expect(mockNavigate).toHaveBeenCalledWith('Journal');
    expect(queryByTestId('screen-drawer-panel')).toBeNull();
  });
});

// Unlocked chapters for the reading-view drawer tests below. Only stage 1
// (the default selection with no route param) gets chapters; every other
// stage resolves empty so the drawer's per-stage fetch loop doesn't collide
// testIDs across sections.
const readingChapters: ContentItem[] = [
  {
    id: 1,
    title: 'Chapter One',
    content_type: 'chapter',
    release_day: 0,
    url: null,
    is_locked: false,
    is_read: false,
  },
  {
    id: 2,
    title: 'Chapter Two',
    content_type: 'chapter',
    release_day: 0,
    url: null,
    is_locked: false,
    is_read: false,
  },
];

describe('Course drawer while reading a chapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    headerLeftStore.current = undefined;
    headerLeftStore.listeners.clear();
    mockStagesList.mockResolvedValue(TEN_STAGES);
    mockStageContent.mockImplementation((stageNumber: number) =>
      Promise.resolve(stageNumber === 1 ? readingChapters : []),
    );
    mockStageProgress.mockResolvedValue(sampleProgress);
    useDepthPreferencesStore.setState({
      enable_habits: true,
      enable_practices: true,
      enable_course: true,
    });
  });

  it('opens the drawer over the reader when the hamburger is tapped while reading', async () => {
    const { getByTestId, getByLabelText } = render(<CourseScreenWithHeader />);
    await waitFor(() => expect(getByTestId('stage-selector')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('content-card-1'));
    });
    await waitFor(() => expect(getByTestId('chapter-reader')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Course menu'));

    await waitFor(() => expect(getByTestId('screen-drawer-panel')).toBeTruthy());
  });

  it('switches the reader in place when a chapter is tapped in the drawer while reading', async () => {
    const { getByTestId, getByLabelText, queryByTestId } = render(<CourseScreenWithHeader />);
    await waitFor(() => expect(getByTestId('stage-selector')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('content-card-1'));
    });
    await waitFor(() => expect(getByTestId('chapter-reader')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Course menu'));
    await waitFor(() => expect(getByTestId('course-drawer-chapter-2')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('course-drawer-chapter-2'));
    });

    await waitFor(() => expect(queryByTestId('screen-drawer-panel')).toBeNull());
    expect(getByTestId('chapter-reader')).toBeTruthy();
  });

  it('does not leak the landing stage-selector into the reading view when the drawer is open', async () => {
    const { getByTestId, getByLabelText, queryByTestId } = render(<CourseScreenWithHeader />);
    await waitFor(() => expect(getByTestId('stage-selector')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('content-card-1'));
    });
    await waitFor(() => expect(getByTestId('chapter-reader')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Course menu'));

    expect(queryByTestId('stage-selector')).toBeNull();
  });
});
