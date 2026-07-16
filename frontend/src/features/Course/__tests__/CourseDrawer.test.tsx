/* eslint-env jest */
// The Course header drawer: a scrollable, stage-grouped table of contents.
// Chapter content for unlocked stages is fetched lazily (per-stage) the first
// time the drawer opens, cached across reopens, and shows an inline retry row
// on a per-section failure (audit-ux-04 pattern).
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { useSyncExternalStore, type ReactElement } from 'react';
import { StyleSheet } from 'react-native';

import type { ContentItem, CourseProgress, Stage } from '../../../api';
import { ink, resolveStageColor, STAGE_ORDER, surface } from '../../../design/tokens';

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
// models the titles-only contract a locked stage's own listing returns: every
// item is locked with no url.
const contentByStage: Record<number, ContentItem[]> = {
  1: [chapterItem(101, 'Stage 1 Chapter A')],
  2: [
    chapterItem(201, 'Stage 2 Chapter A'),
    chapterItem(202, 'Stage 2 Chapter B', { is_locked: true }),
  ],
  3: [chapterItem(301, 'Stage 3 Chapter A')],
  4: [chapterItem(401, 'Stage 4 Secret Chapter', { is_locked: true })],
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

// These modules are required after the jest.mock calls above so the mocks are
// in place before the module-under-test loads; import/order is off for the block.
/* eslint-disable import/order */
const {
  render,
  waitFor,
  fireEvent,
  act,
  within,
  renderHook,
} = require('@testing-library/react-native');
const CourseScreen = require('../CourseScreen').default;
const { useCourseDrawerContent } = require('../CourseDrawer');
/* eslint-enable import/order */

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

    // Map-legend idiom: the stage color lives on a small swatch, not the header
    // row itself. The swatch's color equals the shared resolver applied to the
    // stage's own API color.
    const swatch1Style =
      StyleSheet.flatten(getByTestId('course-drawer-swatch-1').props.style) ?? {};
    expect((swatch1Style as { backgroundColor?: string }).backgroundColor).toBe(
      resolveStageColor('Beige'),
    );
    const swatch3Style =
      StyleSheet.flatten(getByTestId('course-drawer-swatch-3').props.style) ?? {};
    expect((swatch3Style as { backgroundColor?: string }).backgroundColor).toBe(
      resolveStageColor('Red'),
    );

    // The header row no longer carries the stage color as its background.
    const header1Style = StyleSheet.flatten(getByTestId('course-drawer-stage-1').props.style) ?? {};
    expect((header1Style as { backgroundColor?: string }).backgroundColor).not.toBe(
      resolveStageColor('Beige'),
    );

    // Title text uses the ink scale, not a light-on-color treatment.
    const title1 = within(getByTestId('course-drawer-stage-1')).getByText('Stage 1');
    const title1Style = StyleSheet.flatten(title1.props.style) ?? {};
    expect((title1Style as { color?: string }).color).toBe(ink.primary);

    // The selected stage (stage 2) marks its header row with a sunken fill.
    const header2Style = StyleSheet.flatten(getByTestId('course-drawer-stage-2').props.style) ?? {};
    expect((header2Style as { backgroundColor?: string }).backgroundColor).toBe(surface.sunken);
  });

  it('renders a locked stage header as disabled, with its titles-only chapter rows below it, and pressing the header selects nothing', async () => {
    const { getByTestId, getByLabelText, queryByTestId } = render(<CourseScreenWithHeader />);
    await waitFor(() => expect(getByTestId('stage-selector')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Course menu'));

    // Locked stages fetch too, now that a locked stage's own listing returns a
    // titles-only contract instead of being skipped.
    await waitFor(() =>
      expect(mockStageContent.mock.calls.some((call) => call[0] === 4)).toBe(true),
    );

    const header4 = getByTestId('course-drawer-stage-4');
    expect(header4.props.accessibilityState.disabled).toBe(true);

    await waitFor(() => expect(getByTestId('course-drawer-chapter-401')).toBeTruthy());
    const row401 = getByTestId('course-drawer-chapter-401');
    expect(row401.props.accessibilityState.disabled).toBe(true);
    expect(within(row401).getByText('🔒')).toBeTruthy();

    const stageProgressCallCount = mockStageProgress.mock.calls.length;

    fireEvent.press(header4);

    expect(mockStageProgress.mock.calls.length).toBe(stageProgressCallCount);
    expect(queryByTestId('chapter-reader')).toBeNull();
    expect(getByTestId('course-drawer-stage-2').props.accessibilityState.selected).toBe(true);
    expect(header4.props.accessibilityState.selected).toBe(false);
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

  it('fetches content for every stage when the drawer first opens, and caches across reopens', async () => {
    const { getByTestId, getByLabelText } = render(<CourseScreenWithHeader />);
    await waitFor(() => expect(getByTestId('stage-selector')).toBeTruthy());
    await waitFor(() => expect(mockStageContent).toHaveBeenCalledWith(2));

    // Before opening: only the initially-selected stage was fetched.
    const stagesFetchedBeforeOpen = new Set(mockStageContent.mock.calls.map((call) => call[0]));
    expect(stagesFetchedBeforeOpen).toEqual(new Set([2]));

    fireEvent.press(getByLabelText('Open Course menu'));

    await waitFor(() => {
      const fetched = new Set(mockStageContent.mock.calls.map((call) => call[0]));
      for (let n = 1; n <= 10; n += 1) {
        expect(fetched.has(n)).toBe(true);
      }
    });

    const callCountAfterOpen = mockStageContent.mock.calls.length;

    await act(async () => {
      fireEvent.press(getByTestId('screen-drawer-scrim'));
    });
    fireEvent.press(getByLabelText('Open Course menu'));

    expect(mockStageContent.mock.calls.length).toBe(callCountAfterOpen);
  });

  it('a stage with no section entry at drawer-open time gets fetched; a stage that already has one is never refetched', async () => {
    const nineStages = TEN_STAGES.slice(0, 9);
    const { result, rerender } = renderHook(
      ({ stages, isOpen }: { stages: Stage[]; isOpen: boolean }) =>
        useCourseDrawerContent(stages, isOpen),
      { initialProps: { stages: nineStages, isOpen: false } },
    );

    expect(mockStageContent).not.toHaveBeenCalled();

    rerender({ stages: nineStages, isOpen: true });
    await waitFor(() => {
      for (let n = 1; n <= 9; n += 1) {
        expect(result.current.sections[n]?.status).toBe('loaded');
      }
    });
    expect(mockStageContent.mock.calls.length).toBe(9);
    expect(result.current.sections[10]).toBeUndefined();

    // Stage 10 becomes known while the drawer stays open: it has no section
    // entry yet, so it must fetch even though the drawer already opened once.
    rerender({ stages: TEN_STAGES, isOpen: true });
    await waitFor(() => expect(result.current.sections[10]?.status).toBe('loaded'));
    expect(mockStageContent.mock.calls.some((call) => call[0] === 10)).toBe(true);

    const callCountAfterTenLoaded = mockStageContent.mock.calls.length;

    // Every stage now has an entry: closing and reopening triggers no new fetches.
    rerender({ stages: TEN_STAGES, isOpen: false });
    rerender({ stages: TEN_STAGES, isOpen: true });
    expect(mockStageContent.mock.calls.length).toBe(callCountAfterTenLoaded);
  });

  it('a locked-stage fetch failure renders only the header, with no retry row and no spinner', async () => {
    mockStageContent.mockImplementation((stageNumber: number) => {
      if (stageNumber === 4) {
        return Promise.reject(new Error('stage 4 fetch failed'));
      }
      return Promise.resolve(contentByStage[stageNumber] ?? []);
    });

    const { getByTestId, getByLabelText, queryByTestId } = render(<CourseScreenWithHeader />);
    await waitFor(() => expect(getByTestId('stage-selector')).toBeTruthy());

    fireEvent.press(getByLabelText('Open Course menu'));

    await waitFor(() =>
      expect(mockStageContent.mock.calls.some((call) => call[0] === 4)).toBe(true),
    );
    await waitFor(() => expect(getByTestId('course-drawer-stage-4')).toBeTruthy());

    // Let the rejection settle before asserting on its absence.
    await act(async () => {
      await Promise.resolve();
    });

    expect(queryByTestId('course-drawer-retry-4')).toBeNull();
    expect(queryByTestId('course-drawer-loading-4')).toBeNull();
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
