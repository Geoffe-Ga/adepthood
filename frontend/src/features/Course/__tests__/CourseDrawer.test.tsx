/* eslint-env jest */
// The Course header drawer: a scrollable, stage-grouped table of contents.
// Chapter content for unlocked stages is fetched lazily (per-stage) the first
// time the drawer opens, cached across reopens, and shows an inline retry row
// on a per-section failure (audit-ux-04 pattern).
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { useSyncExternalStore, type ReactElement } from 'react';
import { StyleSheet } from 'react-native';

import type { ContentItem, CourseProgress, Stage } from '../../../api';
import { resolveStageColor, STAGE_ORDER } from '../../../design/tokens';

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

const chapterItem = (
  id: number,
  title: string,
  overrides: Partial<ContentItem> = {},
): ContentItem => ({
  id,
  title,
  content_type: 'chapter',
  release_day: 0,
  url: null,
  is_locked: false,
  is_read: false,
  ...overrides,
});

// Ten stages: 1-3 unlocked (stage 2 completed at progress 1.0), 4-10 locked.
// STAGE_ORDER supplies ten distinct, recognized Spiral-Dynamics color names so
// each header's resolved color is independently checkable.
const TEN_STAGES: Stage[] = STAGE_ORDER.map((colorName, index) => {
  const stageNumber = index + 1;
  const unlocked = stageNumber <= 3;
  const progress = stageNumber === 2 ? 1 : stageNumber === 1 ? 0.4 : stageNumber === 3 ? 0.5 : 0;
  return makeStage({
    id: stageNumber,
    stage_number: stageNumber,
    title: `Stage ${stageNumber}`,
    subtitle: `Subtitle ${stageNumber}`,
    spiral_dynamics_color: colorName,
    is_unlocked: unlocked,
    progress,
  });
});

// Distinct chapter titles per stage, so grouping is independently checkable.
// Stage 2 (the initially-selected stage) carries a locked chapter to pin the
// "locked chapter row inside an unlocked stage" behavior. Stage 4 (locked)
// carries a fixture too, so a wrongly-fetched locked section would be
// detectable -- correct behavior never fetches it, so its title never shows.
const contentByStage: Record<number, ContentItem[]> = {
  1: [chapterItem(101, 'Stage 1 Chapter A')],
  2: [
    chapterItem(201, 'Stage 2 Chapter A'),
    chapterItem(202, 'Stage 2 Chapter B', { is_locked: true }),
  ],
  3: [chapterItem(301, 'Stage 3 Chapter A')],
  4: [chapterItem(401, 'Stage 4 Secret Chapter')],
};

const sampleProgress: CourseProgress = {
  total_items: 1,
  read_items: 0,
  progress_percent: 0,
  next_unlock_day: null,
};

const mockStagesList = jest.fn<(...a: unknown[]) => Promise<Stage[]>>();
const mockStageContent = jest.fn<(stageNumber: number, token?: string) => Promise<ContentItem[]>>();
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
    // No intro in these drawer scenarios -- keep the intro card hidden.
    stageIntro: () => Promise.reject(new Error('content_not_found')),
    stageIntroBody: jest.fn(),
  },
}));

const mockRootNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockRootNavigate }),
}));

// CourseScreen installs its header-left drawer toggle through useAppNavigation
// (useScreenDrawer), which calls navigation.setOptions in a layout effect on
// every mount. The store relays the installed headerLeft into the same render
// tree as the screen so the Modal-based drawer opens in-tree and its rows are
// pressable.
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

// eslint-disable-next-line import/order
const { render, waitFor, fireEvent, act, within } = require('@testing-library/react-native');
const CourseScreen = require('../CourseScreen').default;

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

describe('Course header drawer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    headerLeftStore.current = undefined;
    headerLeftStore.listeners.clear();
    mockStagesList.mockResolvedValue(TEN_STAGES);
    mockStageContent.mockImplementation((stageNumber: number) =>
      Promise.resolve(contentByStage[stageNumber] ?? []),
    );
    mockStageProgress.mockResolvedValue(sampleProgress);
  });

  it('installs a header-left drawer toggle and opens the drawer on press', async () => {
    const { getByTestId, getByLabelText } = render(<CourseScreenWithHeader />);
    await waitFor(() => expect(getByTestId('stage-selector')).toBeTruthy());

    expect(mockSetOptions).toHaveBeenCalled();
    const setOptionsCalls = mockSetOptions.mock.calls;
    const lastCall = setOptionsCalls[setOptionsCalls.length - 1];
    if (lastCall === undefined) throw new Error('setOptions was never called');
    expect(lastCall[0].headerLeft).toBeDefined();

    fireEvent.press(getByLabelText('Open Course menu'));

    expect(getByTestId('screen-drawer')).toBeTruthy();
    expect(getByTestId('screen-drawer-panel')).toBeTruthy();
  });

  it('groups chapters under ten colored stage headers, marking completed and locked stages', async () => {
    const { getByTestId, getByLabelText, getByText } = render(<CourseScreenWithHeader />);
    await waitFor(() => expect(getByTestId('stage-selector')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Course menu'));

    await waitFor(() => {
      for (let n = 1; n <= 10; n += 1) {
        expect(getByTestId(`course-drawer-stage-${n}`)).toBeTruthy();
      }
    });

    // Unlocked stages show their own chapter titles. Stage 2 is the selected
    // stage, so its chapter also renders in the body panel -- scope the check to
    // the drawer row so the assertion is unambiguous.
    expect(getByText('Stage 1 Chapter A')).toBeTruthy();
    expect(
      within(getByTestId('course-drawer-chapter-201')).getByText('Stage 2 Chapter A'),
    ).toBeTruthy();
    expect(getByText('Stage 3 Chapter A')).toBeTruthy();

    // Stage 2 is completed; stage 4 is locked.
    expect(within(getByTestId('course-drawer-stage-2')).getByText('✓')).toBeTruthy();
    expect(within(getByTestId('course-drawer-stage-4')).getByText('🔒')).toBeTruthy();

    // The header's color equals the shared resolver applied to the stage's own API color.
    const stage1Style = StyleSheet.flatten(getByTestId('course-drawer-stage-1').props.style) ?? {};
    expect((stage1Style as { backgroundColor?: string }).backgroundColor).toBe(
      resolveStageColor('Beige'),
    );
    const stage3Style = StyleSheet.flatten(getByTestId('course-drawer-stage-3').props.style) ?? {};
    expect((stage3Style as { backgroundColor?: string }).backgroundColor).toBe(
      resolveStageColor('Red'),
    );
  });

  it('renders a locked stage header as disabled and never fetches or selects it on press', async () => {
    const { getByTestId, getByLabelText, queryByText } = render(<CourseScreenWithHeader />);
    await waitFor(() => expect(getByTestId('stage-selector')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Course menu'));
    await waitFor(() => expect(getByTestId('course-drawer-stage-4')).toBeTruthy());

    const header4 = getByTestId('course-drawer-stage-4');
    expect(header4.props.accessibilityState.disabled).toBe(true);

    const stageContentCallCount = mockStageContent.mock.calls.length;
    const stageProgressCallCount = mockStageProgress.mock.calls.length;

    fireEvent.press(header4);

    expect(mockStageContent.mock.calls.length).toBe(stageContentCallCount);
    expect(mockStageProgress.mock.calls.length).toBe(stageProgressCallCount);
    expect(mockStageContent.mock.calls.some((call) => call[0] === 4)).toBe(false);
    // Its content is never rendered -- correct behavior never fetches a locked section.
    expect(queryByText('Stage 4 Secret Chapter')).toBeNull();
  });

  it('tapping a chapter in a different stage selects it, opens the viewer, closes the drawer, and refetches', async () => {
    const { getByTestId, getByLabelText, getByText, queryByTestId } = render(
      <CourseScreenWithHeader />,
    );
    await waitFor(() => expect(getByTestId('stage-selector')).toBeTruthy());
    await waitFor(() => expect(mockStageContent).toHaveBeenCalledWith(2));

    fireEvent.press(getByLabelText('Open Course menu'));
    await waitFor(() => expect(getByText('Stage 1 Chapter A')).toBeTruthy());

    mockStageContent.mockClear();
    mockStageProgress.mockClear();

    await act(async () => {
      fireEvent.press(getByTestId('course-drawer-chapter-101'));
    });

    await waitFor(() => expect(getByTestId('chapter-reader')).toBeTruthy());
    expect(queryByTestId('screen-drawer')).toBeNull();

    await waitFor(() => {
      expect(mockStageContent).toHaveBeenCalledWith(1);
      expect(mockStageProgress).toHaveBeenCalledWith(1);
    });
  });

  it('a locked chapter row is disabled and pressing it opens nothing, keeping the drawer open', async () => {
    const { getByTestId, getByLabelText, getByText, queryByTestId } = render(
      <CourseScreenWithHeader />,
    );
    await waitFor(() => expect(getByTestId('stage-selector')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Course menu'));
    await waitFor(() => expect(getByText('Stage 2 Chapter B')).toBeTruthy());

    const lockedRow = getByTestId('course-drawer-chapter-202');
    expect(lockedRow.props.accessibilityState.disabled).toBe(true);

    fireEvent.press(lockedRow);

    expect(queryByTestId('chapter-reader')).toBeNull();
    expect(getByTestId('screen-drawer-panel')).toBeTruthy();
  });

  it('fetches content lazily per unlocked stage only when the drawer first opens, and caches across reopens', async () => {
    const { getByTestId, getByLabelText } = render(<CourseScreenWithHeader />);
    await waitFor(() => expect(getByTestId('stage-selector')).toBeTruthy());
    await waitFor(() => expect(mockStageContent).toHaveBeenCalledWith(2));

    // Before opening: only the initially-selected stage was fetched.
    const stagesFetchedBeforeOpen = new Set(mockStageContent.mock.calls.map((call) => call[0]));
    expect(stagesFetchedBeforeOpen).toEqual(new Set([2]));

    fireEvent.press(getByLabelText('Open Course menu'));

    await waitFor(() => {
      const fetched = new Set(mockStageContent.mock.calls.map((call) => call[0]));
      expect(fetched.has(1)).toBe(true);
      expect(fetched.has(2)).toBe(true);
      expect(fetched.has(3)).toBe(true);
    });

    const fetchedAfterOpen = new Set(mockStageContent.mock.calls.map((call) => call[0]));
    for (let n = 4; n <= 10; n += 1) {
      expect(fetchedAfterOpen.has(n)).toBe(false);
    }

    const callCountAfterOpen = mockStageContent.mock.calls.length;

    await act(async () => {
      fireEvent.press(getByTestId('screen-drawer-scrim'));
    });
    fireEvent.press(getByLabelText('Open Course menu'));

    expect(mockStageContent.mock.calls.length).toBe(callCountAfterOpen);
  });

  it('shows a per-section retry when exactly one unlocked stage fails, and retry reloads only that stage', async () => {
    let stage3ShouldFail = true;
    mockStageContent.mockImplementation((stageNumber: number) => {
      if (stageNumber === 3 && stage3ShouldFail) {
        stage3ShouldFail = false;
        return Promise.reject(new Error('stage 3 fetch failed'));
      }
      return Promise.resolve(contentByStage[stageNumber] ?? []);
    });

    const { getByTestId, getByLabelText, getByText, queryByText, queryByTestId } = render(
      <CourseScreenWithHeader />,
    );
    await waitFor(() => expect(getByTestId('stage-selector')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Course menu'));

    await waitFor(() => expect(getByTestId('course-drawer-retry-3')).toBeTruthy());
    // Sibling sections still render their chapters. Stage 2 is the selected
    // stage, so scope its check to the drawer row to stay unambiguous.
    expect(getByText('Stage 1 Chapter A')).toBeTruthy();
    expect(
      within(getByTestId('course-drawer-chapter-201')).getByText('Stage 2 Chapter A'),
    ).toBeTruthy();
    expect(queryByText('Stage 3 Chapter A')).toBeNull();

    const stage1CallsBefore = mockStageContent.mock.calls.filter((c) => c[0] === 1).length;
    const stage2CallsBefore = mockStageContent.mock.calls.filter((c) => c[0] === 2).length;
    const stage3CallsBefore = mockStageContent.mock.calls.filter((c) => c[0] === 3).length;
    expect(stage3CallsBefore).toBe(1);

    await act(async () => {
      fireEvent.press(getByTestId('course-drawer-retry-3'));
    });

    await waitFor(() => expect(getByText('Stage 3 Chapter A')).toBeTruthy());
    expect(queryByTestId('course-drawer-retry-3')).toBeNull();

    expect(mockStageContent.mock.calls.filter((c) => c[0] === 1).length).toBe(stage1CallsBefore);
    expect(mockStageContent.mock.calls.filter((c) => c[0] === 2).length).toBe(stage2CallsBefore);
    expect(mockStageContent.mock.calls.filter((c) => c[0] === 3).length).toBe(
      stage3CallsBefore + 1,
    );
  });
});
