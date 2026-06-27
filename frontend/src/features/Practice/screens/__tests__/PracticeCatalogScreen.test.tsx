/* eslint-env jest */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { PracticeItem } from '@/api';

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

const mockNavigation = { navigate: jest.fn() as jest.Mock<(...args: unknown[]) => void> };
const mockRoute: { params?: { stageNumber?: number } } = { params: undefined };

const mockPracticesList = jest.fn() as jest.MockedFunction<
  (opts: { stageNumber: number; includeMine?: boolean }) => Promise<PracticeItem[]>
>;

jest.mock('@/api', () => ({
  practices: {
    listAll: (...args: unknown[]) =>
      (mockPracticesList as unknown as (...a: unknown[]) => Promise<PracticeItem[]>)(...args),
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

  it('renders an empty Imported section because no share-token signal exists yet', async () => {
    const { view } = renderScreen();
    await waitForLoad();
    expect(view.getByTestId('practice-catalog-section-imported-empty')).toBeTruthy();
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
    mockRoute.params = undefined;
  });

  it('calls practices.list with includeMine when no override is provided', async () => {
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

describe('PracticeCatalogScreen — virtualization parity', () => {
  it('renders every section + row through the windowed list and still navigates on press', async () => {
    const { view, navigateToDetail } = renderScreen();
    await waitForLoad();

    // All three section headers render (the empty Imported section keeps its footer).
    expect(view.getByTestId('practice-catalog-section-presets')).toBeTruthy();
    expect(view.getByTestId('practice-catalog-section-drafts')).toBeTruthy();
    expect(view.getByTestId('practice-catalog-section-imported-empty')).toBeTruthy();

    // Rows from different sections all appear in the same windowed pass...
    expect(view.getByTestId('practice-catalog-row-1')).toBeTruthy();
    expect(view.getByTestId('practice-catalog-row-2')).toBeTruthy();
    expect(view.getByTestId('practice-catalog-row-9')).toBeTruthy();

    // ...and pressing a row still navigates (behavior unchanged by virtualization).
    fireEvent.press(view.getByTestId('practice-catalog-row-9'));
    expect(navigateToDetail).toHaveBeenCalledWith(9);
  });
});
