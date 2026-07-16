/* eslint-env jest */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Alert, StyleSheet } from 'react-native';

import type { PracticeItem, UserPractice } from '@/api';
import { surface } from '@/design/tokens';

// Async practice load settling is marginal against Jest's 5s default under CI parallel-worker contention; give this suite headroom.
jest.setTimeout(15000);

// The catalog reads useSafeAreaInsets; stub it with non-zero insets (no
// SafeAreaProvider in tests) so the safe-area padding is observable.
jest.mock('react-native-safe-area-context', () => {
  const ReactMod = require('react');
  const passthrough = ({ children }: { children: unknown }) =>
    ReactMod.createElement(ReactMod.Fragment, null, children);
  return {
    SafeAreaProvider: passthrough,
    SafeAreaView: passthrough,
    useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
  };
});

const presetA: PracticeItem = {
  id: 1,
  stage_number: 1,
  name: 'Concentration on the breath',
  description: 'Anchor in the breath cycle.',
  instructions: '',
  default_duration_minutes: 10,
  submitted_by_user_id: null,
  approved: true,
  mode: 'meditation_timer',
  mode_config: { mode: 'meditation_timer', duration_minutes: 10 },
};

const presetB: PracticeItem = {
  id: 2,
  stage_number: 1,
  name: 'Awareness bells preset',
  description: 'A random-bell session.',
  instructions: '',
  default_duration_minutes: 20,
  submitted_by_user_id: null,
  approved: true,
  mode: 'random_interval_bell',
  mode_config: {
    mode: 'random_interval_bell',
    duration_minutes: 20,
    min_interval_seconds: 30,
    max_interval_seconds: 180,
    bell_tone: 'bowl',
  },
};

const myDraft: PracticeItem = {
  id: 9,
  stage_number: 1,
  name: 'My private bells',
  description: 'Customized random bell.',
  instructions: '',
  default_duration_minutes: 15,
  submitted_by_user_id: 42,
  approved: false,
  mode: 'random_interval_bell',
  mode_config: {
    mode: 'random_interval_bell',
    duration_minutes: 15,
    min_interval_seconds: 20,
    max_interval_seconds: 60,
    bell_tone: 'chime',
  },
};

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => mockRoute,
}));

const mockNavigation = {
  navigate: jest.fn() as jest.Mock<(...args: unknown[]) => void>,
  goBack: jest.fn() as jest.Mock<() => void>,
};
const mockRoute: { params?: { stageNumber?: number } } = { params: undefined };

const mockPracticesList = jest.fn() as jest.MockedFunction<
  (opts: { stageNumber: number; includeMine?: boolean }) => Promise<PracticeItem[]>
>;
const mockPracticesCreate = jest.fn() as jest.MockedFunction<
  (payload: Record<string, unknown>) => Promise<PracticeItem>
>;
const mockUserPracticesCreate = jest.fn() as jest.MockedFunction<
  (payload: { practice_id: number; stage_number: number }) => Promise<UserPractice>
>;

jest.mock('@/api', () => ({
  practices: {
    listAll: (...args: unknown[]) =>
      (mockPracticesList as unknown as (...a: unknown[]) => Promise<PracticeItem[]>)(...args),
    create: (...args: unknown[]) =>
      (mockPracticesCreate as unknown as (...a: unknown[]) => Promise<PracticeItem>)(...args),
  },
  userPractices: {
    create: (...args: unknown[]) =>
      (mockUserPracticesCreate as unknown as (...a: unknown[]) => Promise<UserPractice>)(...args),
  },
}));

const { PracticeCatalogScreen } = require('../PracticeCatalogScreen');

function renderScreen(overrides: Partial<React.ComponentProps<typeof PracticeCatalogScreen>> = {}) {
  const loadPractices = jest.fn(async () => [presetA, presetB, myDraft]) as jest.MockedFunction<
    (_stage: number) => Promise<PracticeItem[]>
  >;
  const navigateToDetail = jest.fn();
  const navigateToCreate = jest.fn();
  const view = render(
    <PracticeCatalogScreen
      initialStage={1}
      loadPractices={loadPractices}
      navigateToDetail={navigateToDetail}
      navigateToCreate={navigateToCreate}
      {...overrides}
    />,
  );
  return { view, loadPractices, navigateToDetail, navigateToCreate };
}

const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve));

async function waitForLoad() {
  await act(async () => {
    await flushPromises();
  });
}

describe('PracticeCatalogScreen — sections', () => {
  it('buckets approved practices under Presets and unapproved under My drafts', async () => {
    const { view } = renderScreen();
    await waitForLoad();
    const presets = view.getByTestId('practice-catalog-section-presets');
    const drafts = view.getByTestId('practice-catalog-section-drafts');
    expect(presets).toBeTruthy();
    expect(drafts).toBeTruthy();
    expect(view.getByTestId('practice-catalog-row-1')).toBeTruthy();
    expect(view.getByTestId('practice-catalog-row-9')).toBeTruthy();
  });

  it('applies safe-area insets to the catalog container', async () => {
    const { view } = renderScreen();
    await waitForLoad();
    expect(view.getByTestId('practice-catalog-safe-area')).toHaveStyle({
      paddingTop: 47,
      paddingBottom: 34,
    });
  });

  it('renders no Imported rows or footer when siblings are populated (no share-token signal yet)', async () => {
    // Imported is structurally empty today (no share-token mechanism yet).
    // When presets and drafts are populated the footer is suppressed so it
    // cannot overlap and swallow taps on the populated list.
    const { view } = renderScreen();
    await waitForLoad();
    // Section header is absent for empty sections (renderSectionHeader returns null).
    expect(view.queryByTestId('practice-catalog-section-imported')).toBeNull();
    // Empty-state footer must also be absent — suppressed while siblings have rows.
    expect(view.queryByTestId('practice-catalog-section-imported-empty')).toBeNull();
  });

  it('shows a + Create button that fires the navigate callback', async () => {
    const { view, navigateToCreate } = renderScreen();
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-catalog-create'));
    expect(navigateToCreate).toHaveBeenCalled();
  });

  it('opens the detail screen when a row is tapped', async () => {
    const { view, navigateToDetail } = renderScreen();
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-catalog-row-2'));
    expect(navigateToDetail).toHaveBeenCalledWith(2);
  });
});

describe('PracticeCatalogScreen — row presentation', () => {
  it('renders the friendly mode label and duration, never the raw snake_case mode', async () => {
    const { view } = renderScreen();
    await waitForLoad();
    expect(view.getByText('Meditation timer · 10 min')).toBeTruthy();
    expect(view.getByText('Random interval bell · 20 min')).toBeTruthy();
    expect(view.queryByText('meditation_timer')).toBeNull();
    expect(view.queryByText('random_interval_bell')).toBeNull();
  });

  it('does not repeat the already-selected stage as a per-row badge', async () => {
    const { view } = renderScreen();
    await waitForLoad();
    // The only "Stage 1" text on screen is the active filter chip, not a
    // redundant badge stamped onto every row.
    expect(view.getAllByText('Stage 1')).toHaveLength(1);
  });

  it('gives each row the mode-specific emoji as a leading visual anchor', async () => {
    const { view } = renderScreen();
    await waitForLoad();
    expect(view.getByTestId('practice-catalog-row-1-icon').props.children).toBe('⏳');
  });

  it('falls back to a generic label and icon when the mode is unrecognised', async () => {
    const unknown: PracticeItem = {
      ...presetA,
      mode: 'totally_new_server_mode' as PracticeItem['mode'],
    };
    const { view } = renderScreen({ loadPractices: jest.fn(async () => [unknown]) });
    await waitForLoad();
    expect(view.getByText('Practice · 10 min')).toBeTruthy();
    expect(view.getByTestId('practice-catalog-row-1-icon').props.children).toBe('🧘');
  });
});

describe('PracticeCatalogScreen — filters', () => {
  it('filters by name with the search bar', async () => {
    const { view } = renderScreen();
    await waitForLoad();
    fireEvent.changeText(view.getByTestId('practice-catalog-search'), 'awareness');
    expect(view.queryByTestId('practice-catalog-row-1')).toBeNull();
    expect(view.getByTestId('practice-catalog-row-2')).toBeTruthy();
  });

  it('filters by mode category chip', async () => {
    const { view } = renderScreen();
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-catalog-mode-bells'));
    expect(view.queryByTestId('practice-catalog-row-1')).toBeNull();
    expect(view.getByTestId('practice-catalog-row-2')).toBeTruthy();
  });

  it('clears the mode category filter when All is tapped', async () => {
    const { view } = renderScreen();
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-catalog-mode-bells'));
    expect(view.queryByTestId('practice-catalog-row-1')).toBeNull();
    fireEvent.press(view.getByTestId('practice-catalog-mode-all'));
    expect(view.getByTestId('practice-catalog-row-1')).toBeTruthy();
    expect(view.getByTestId('practice-catalog-row-2')).toBeTruthy();
  });

  it('refetches with the new stage when the stage chip changes', async () => {
    const { view, loadPractices } = renderScreen();
    await waitForLoad();
    loadPractices.mockClear();
    loadPractices.mockResolvedValueOnce([]);
    fireEvent.press(view.getByTestId('practice-catalog-stage-4'));
    await waitForLoad();
    expect(loadPractices).toHaveBeenCalledWith(4);
  });
});

describe('PracticeCatalogScreen — error state', () => {
  it('renders the error block + retry button when loading fails', async () => {
    const loadPractices = jest.fn(async () => {
      throw new Error('nope');
    }) as jest.MockedFunction<(_stage: number) => Promise<PracticeItem[]>>;
    const { view } = renderScreen({ loadPractices });
    await waitForLoad();
    expect(view.getByTestId('practice-catalog-error')).toBeTruthy();
    loadPractices.mockResolvedValueOnce([presetA]);
    fireEvent.press(view.getByTestId('practice-catalog-retry'));
    await waitForLoad();
    expect(view.getByTestId('practice-catalog-row-1')).toBeTruthy();
  });
});

describe('PracticeCatalogScreen — defaults wiring', () => {
  beforeEach(() => {
    mockPracticesList.mockReset();
    mockNavigation.navigate.mockReset();
    mockNavigation.goBack.mockReset();
    mockRoute.params = undefined;
  });

  it('calls practices.listAll with includeMine when no override is provided', async () => {
    mockPracticesList.mockResolvedValueOnce([presetA]);
    render(<PracticeCatalogScreen initialStage={3} />);
    await waitForLoad();
    expect(mockPracticesList).toHaveBeenCalledWith({ stageNumber: 3, includeMine: true });
  });

  it('seeds the stage from the Catalog route param when no prop is given', async () => {
    mockRoute.params = { stageNumber: 4 };
    mockPracticesList.mockResolvedValueOnce([presetA]);
    render(<PracticeCatalogScreen />);
    await waitForLoad();
    expect(mockPracticesList).toHaveBeenCalledWith({ stageNumber: 4, includeMine: true });
  });

  it('prefers an explicit initialStage prop over the route param', async () => {
    mockRoute.params = { stageNumber: 4 };
    mockPracticesList.mockResolvedValueOnce([presetA]);
    render(<PracticeCatalogScreen initialStage={6} />);
    await waitForLoad();
    expect(mockPracticesList).toHaveBeenCalledWith({ stageNumber: 6, includeMine: true });
  });

  it('sets the practice active for the seeded stage when "Use" is tapped, then goes back', async () => {
    const setActive = jest.fn(async () => undefined) as jest.MockedFunction<
      (id: number, stage: number) => Promise<void>
    >;
    mockPracticesList.mockResolvedValueOnce([presetA]);
    const view = render(<PracticeCatalogScreen initialStage={1} setActive={setActive} />);
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-catalog-row-1-use'));
    expect(setActive).toHaveBeenCalledWith(1, 1);
    await waitFor(() => expect(mockNavigation.goBack).toHaveBeenCalledTimes(1));
  });

  it('alerts and stays put when setting the practice active fails', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const setActive = jest.fn(async () => {
      throw new Error('boom');
    }) as jest.MockedFunction<(id: number, stage: number) => Promise<void>>;
    mockPracticesList.mockResolvedValueOnce([presetA]);
    const view = render(<PracticeCatalogScreen initialStage={1} setActive={setActive} />);
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-catalog-row-1-use'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
    expect(mockNavigation.goBack).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('gives the row a spoken-friendly accessibility label (no glyphs, "minutes" spelled out)', async () => {
    mockPracticesList.mockResolvedValueOnce([presetA]);
    const view = render(<PracticeCatalogScreen initialStage={1} />);
    await waitForLoad();
    const label = view.getByTestId('practice-catalog-row-1').props.accessibilityLabel as string;
    expect(label).toBe('Concentration on the breath. Meditation timer, 10 minutes.');
    expect(label).not.toContain('·');
    expect(label).not.toMatch(/\bmin\b/);
  });

  it('navigates to PracticeDetail when a row is tapped without an override', async () => {
    mockPracticesList.mockResolvedValueOnce([presetA]);
    const view = render(<PracticeCatalogScreen initialStage={1} />);
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-catalog-row-1'));
    expect(mockNavigation.navigate).toHaveBeenCalledWith('PracticeDetail', { practiceId: 1 });
  });

  it('navigates to CreatePractice when + Create is tapped without an override', async () => {
    mockPracticesList.mockResolvedValueOnce([presetA]);
    const view = render(<PracticeCatalogScreen initialStage={1} />);
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-catalog-create'));
    expect(mockNavigation.navigate).toHaveBeenCalledWith('CreatePractice');
  });

  it('falls back to meditation_timer when a row has no mode field set', async () => {
    const legacy: PracticeItem = { ...presetA, mode: undefined, mode_config: undefined };
    mockPracticesList.mockResolvedValueOnce([legacy]);
    const view = render(<PracticeCatalogScreen initialStage={1} />);
    await waitForLoad();
    expect(view.getByTestId('practice-catalog-row-1')).toBeTruthy();
    // Filtering by Timers should keep this row visible — the fallback maps it to meditation_timer.
    fireEvent.press(view.getByTestId('practice-catalog-mode-timers'));
    expect(view.getByTestId('practice-catalog-row-1')).toBeTruthy();
  });
});

describe('PracticeCatalogScreen — empty sections', () => {
  it('renders an editorial empty state with a Create CTA into the wizard when the whole catalog is empty', async () => {
    // The empty-state footer (with its Create CTA) shows only when every
    // section is empty — that is the correct, non-overlapping contract.
    const navigateToCreate = jest.fn();
    const view = render(
      <PracticeCatalogScreen
        initialStage={1}
        loadPractices={allEmptyLoad}
        navigateToDetail={jest.fn()}
        navigateToCreate={navigateToCreate}
      />,
    );
    await waitForLoad();
    // All three section footers render under all-empty.
    expect(view.getByTestId('practice-catalog-section-presets-empty')).toBeTruthy();
    // Passive "Nothing here yet." copy must not appear in any footer.
    expect(view.queryByText('Nothing here yet.')).toBeNull();
    // The Create CTA in the presets footer opens the wizard.
    fireEvent.press(view.getByTestId('practice-catalog-section-presets-create'));
    expect(navigateToCreate).toHaveBeenCalled();
  });
});

describe('PracticeCatalogScreen — recently used', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('hides the Recently-used shortcut when there is no history', async () => {
    const { view } = renderScreen();
    await waitForLoad();
    expect(view.queryByTestId('practice-catalog-recently-used')).toBeNull();
  });

  it('surfaces a recorded practice in the Recently-used shortcut and opens its detail', async () => {
    await AsyncStorage.setItem(
      '@adepthood/recent_practices',
      JSON.stringify([
        {
          id: 2,
          name: 'Awareness bells preset',
          mode: 'random_interval_bell',
          durationMinutes: 20,
        },
      ]),
    );
    const { view, navigateToDetail } = renderScreen();
    await waitForLoad();
    expect(view.getByTestId('practice-catalog-recently-used')).toBeTruthy();
    const recentRow = view.getByTestId('practice-catalog-recent-row-2');
    expect(recentRow).toBeTruthy();
    fireEvent.press(recentRow);
    expect(navigateToDetail).toHaveBeenCalledWith(2);
  });

  it('records a practice when its Use button is tapped', async () => {
    const setActive = jest.fn(async () => undefined) as jest.MockedFunction<
      (id: number, stage: number) => Promise<void>
    >;
    const { view } = renderScreen({ setActive });
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-catalog-row-1-use'));
    await waitFor(async () => {
      const raw = await AsyncStorage.getItem('@adepthood/recent_practices');
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw as string)[0].id).toBe(1);
    });
  });
});

describe('PracticeCatalogScreen — virtualization parity', () => {
  it('renders every section + row through the windowed list and still navigates on press', async () => {
    const { view, navigateToDetail } = renderScreen();
    await waitForLoad();

    // Populated section headers render; the empty Imported section renders no header.
    expect(view.getByTestId('practice-catalog-section-presets')).toBeTruthy();
    expect(view.getByTestId('practice-catalog-section-drafts')).toBeTruthy();
    // Footer suppression: Imported is empty but siblings are populated, so no footer.
    expect(view.queryByTestId('practice-catalog-section-imported-empty')).toBeNull();

    // Rows from different sections all appear in the same windowed pass...
    expect(view.getByTestId('practice-catalog-row-1')).toBeTruthy();
    expect(view.getByTestId('practice-catalog-row-2')).toBeTruthy();
    expect(view.getByTestId('practice-catalog-row-9')).toBeTruthy();

    // ...and pressing a row still navigates (behavior unchanged by virtualization).
    fireEvent.press(view.getByTestId('practice-catalog-row-9'));
    expect(navigateToDetail).toHaveBeenCalledWith(9);
  });
});

// ---------------------------------------------------------------------------
// Gate-1 RED: footer-suppression + inline-style contract
// ---------------------------------------------------------------------------

const presetsOnlyLoad = jest.fn(async () => [presetA, presetB]) as jest.MockedFunction<
  (_stage: number) => Promise<PracticeItem[]>
>;

const allEmptyLoad = jest.fn(async () => []) as jest.MockedFunction<
  (_stage: number) => Promise<PracticeItem[]>
>;

describe('PracticeCatalogScreen — footer suppression', () => {
  // Test 1: empty sibling footers must be absent when any section is populated.
  it('hides drafts and imported empty-footers when presets are populated', async () => {
    const setActive = jest.fn(async () => undefined) as jest.MockedFunction<
      (id: number, stage: number) => Promise<void>
    >;
    presetsOnlyLoad.mockResolvedValue([presetA, presetB]);
    const view = render(
      <PracticeCatalogScreen
        initialStage={1}
        loadPractices={presetsOnlyLoad}
        navigateToDetail={jest.fn()}
        navigateToCreate={jest.fn()}
        setActive={setActive}
      />,
    );
    await waitForLoad();
    // Both empty-section footers must be absent while a sibling section has rows.
    expect(view.queryByTestId('practice-catalog-section-drafts-empty')).toBeNull();
    expect(view.queryByTestId('practice-catalog-section-imported-empty')).toBeNull();
  });

  // Test 2: all-empty catalog MUST still show the presets empty footer (characterization guard).
  it('shows the presets empty-footer when the whole catalog is empty', async () => {
    allEmptyLoad.mockResolvedValue([]);
    const view = render(
      <PracticeCatalogScreen
        initialStage={1}
        loadPractices={allEmptyLoad}
        navigateToDetail={jest.fn()}
        navigateToCreate={jest.fn()}
      />,
    );
    await waitForLoad();
    // Must remain visible after the fix — suppression applies only to populated siblings.
    expect(view.getByTestId('practice-catalog-section-presets-empty')).toBeTruthy();
  });

  // Test 3: Use button and row detail handler are reachable when presets are populated.
  it('fires Use handler and detail handler on populated-preset rows', async () => {
    const setActive = jest.fn(async () => undefined) as jest.MockedFunction<
      (id: number, stage: number) => Promise<void>
    >;
    const navigateToDetail = jest.fn();
    presetsOnlyLoad.mockResolvedValue([presetA, presetB]);
    const view = render(
      <PracticeCatalogScreen
        initialStage={1}
        loadPractices={presetsOnlyLoad}
        navigateToDetail={navigateToDetail}
        navigateToCreate={jest.fn()}
        setActive={setActive}
      />,
    );
    await waitForLoad();
    // Use button must exist and fire the activate callback.
    const useBtn = view.getByTestId('practice-catalog-row-1-use');
    expect(useBtn).toBeTruthy();
    fireEvent.press(useBtn);
    await waitFor(() => expect(setActive).toHaveBeenCalledWith(1, 1));
    // Row itself must open detail.
    fireEvent.press(view.getByTestId('practice-catalog-row-1'));
    expect(navigateToDetail).toHaveBeenCalledWith(1);
  });

  // Test 4: the inline empty-footer container must not carry full-screen styles.
  it('section empty-footer has inline style contract (no full-screen canvas bg)', async () => {
    allEmptyLoad.mockResolvedValue([]);
    const view = render(
      <PracticeCatalogScreen
        initialStage={1}
        loadPractices={allEmptyLoad}
        navigateToDetail={jest.fn()}
        navigateToCreate={jest.fn()}
      />,
    );
    await waitForLoad();
    const footer = view.getByTestId('practice-catalog-section-presets-empty');
    const flat = StyleSheet.flatten(
      footer.props.style as Parameters<typeof StyleSheet.flatten>[0],
    ) as { flex?: number; justifyContent?: string; backgroundColor?: string };
    // Must NOT be a full-screen block: no expanding flex, centering, or opaque canvas.
    expect(flat.flex).not.toBe(1);
    expect(flat.justifyContent).not.toBe('center');
    expect(flat.backgroundColor).not.toBe(surface.canvas);
    // Must positively declare itself as non-expanding.
    expect(flat.flex).toBe(0);
  });
});

describe('PracticeCatalogScreen — cross-stage copy', () => {
  beforeEach(() => {
    mockPracticesList.mockReset();
    mockPracticesCreate.mockReset();
    mockUserPracticesCreate.mockReset();
    mockNavigation.navigate.mockReset();
    mockNavigation.goBack.mockReset();
    mockRoute.params = undefined;
  });

  it('shows the copy dialog with no API calls when the row differs from the browsing stage', async () => {
    mockPracticesList.mockResolvedValueOnce([presetA]);
    const view = render(<PracticeCatalogScreen initialStage={6} />);
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-catalog-row-1-use'));
    expect(view.getByTestId('practice-copy-dialog')).toBeTruthy();
    expect(mockPracticesCreate).not.toHaveBeenCalled();
    expect(mockUserPracticesCreate).not.toHaveBeenCalled();
    expect(mockNavigation.goBack).not.toHaveBeenCalled();
  });

  it('confirming the copy dialog creates a draft at the browsing stage, assigns it, records it, and goes back', async () => {
    const createdDraft: PracticeItem = { ...presetA, id: 501, stage_number: 6, approved: false };
    const assignedCopy: UserPractice = {
      id: 1,
      user_id: 9,
      practice_id: 501,
      stage_number: 6,
      start_date: '2026-07-15',
      end_date: null,
    };
    mockPracticesList.mockResolvedValueOnce([presetA]);
    mockPracticesCreate.mockResolvedValueOnce(createdDraft);
    mockUserPracticesCreate.mockResolvedValueOnce(assignedCopy);
    const view = render(<PracticeCatalogScreen initialStage={6} />);
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-catalog-row-1-use'));
    await act(async () => {
      fireEvent.press(view.getByTestId('practice-copy-dialog-confirm'));
      await flushPromises();
    });
    expect(mockPracticesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ stage_number: 6, name: presetA.name }),
    );
    expect(mockUserPracticesCreate).toHaveBeenCalledWith({ practice_id: 501, stage_number: 6 });
    await waitFor(() => expect(mockNavigation.goBack).toHaveBeenCalledTimes(1));
    const raw = await AsyncStorage.getItem('@adepthood/recent_practices');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)[0].id).toBe(501);
  });

  it('cancelling the copy dialog makes zero API calls and stays put', async () => {
    mockPracticesList.mockResolvedValueOnce([presetA]);
    const view = render(<PracticeCatalogScreen initialStage={6} />);
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-catalog-row-1-use'));
    fireEvent.press(view.getByTestId('practice-copy-dialog-cancel'));
    expect(view.queryByTestId('practice-copy-dialog')).toBeNull();
    expect(mockPracticesCreate).not.toHaveBeenCalled();
    expect(mockUserPracticesCreate).not.toHaveBeenCalled();
    expect(mockNavigation.goBack).not.toHaveBeenCalled();
  });

  it('keeps the direct same-stage Use behavior when the row matches the browsing stage', async () => {
    mockPracticesList.mockResolvedValueOnce([presetA]);
    const view = render(<PracticeCatalogScreen initialStage={1} />);
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-catalog-row-1-use'));
    expect(view.queryByTestId('practice-copy-dialog')).toBeNull();
    await waitFor(() =>
      expect(mockUserPracticesCreate).toHaveBeenCalledWith({ practice_id: 1, stage_number: 1 }),
    );
    expect(mockPracticesCreate).not.toHaveBeenCalled();
    await waitFor(() => expect(mockNavigation.goBack).toHaveBeenCalledTimes(1));
  });
});
