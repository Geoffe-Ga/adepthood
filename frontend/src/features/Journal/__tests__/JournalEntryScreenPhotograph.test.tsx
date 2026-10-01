/* eslint-env jest */
/**
 * Photographing a page or screenshot from the page you are already writing.
 *
 * A Course reflection IS a journal entry — the reader hands off to this screen
 * with a prefilled title — so the affordance lives here rather than in a
 * Course-specific fork, and the transcript comes back INTO the open page rather
 * than being saved as a separate entry. These tests hold both halves: the
 * affordance and the route it opens, and the append that lands the transcribed
 * prose in the body the writer is already in, under the title they arrived with.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { Camera } from 'lucide-react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { exitRowOrder } from './entryLayoutTestKit';

import type { JournalMessage } from '@/api';
import { NAV_ICON_SIZE, NAV_ICON_STROKE } from '@/components/drawer';
import { accent, touchTarget } from '@/design/tokens';
import { useCapturedTranscriptStore } from '@/store/useCapturedTranscriptStore';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockCreate = jest.fn() as jest.MockedFunction<(_e: unknown) => Promise<JournalMessage>>;
const mockUpdate = jest.fn() as jest.MockedFunction<
  (_id: number, _p: unknown) => Promise<JournalMessage>
>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;

// ``useAuth`` throws outside a provider; the screen reads only the zone.
jest.mock('@/context/AuthContext', () => require('./authContextTestKit'));

jest.mock('@/api', () => ({
  journal: {
    get: (...a: unknown[]) => (mockGet as unknown as (...x: unknown[]) => unknown)(...a),
    create: (...a: unknown[]) => (mockCreate as unknown as (...x: unknown[]) => unknown)(...a),
    update: (...a: unknown[]) => (mockUpdate as unknown as (...x: unknown[]) => unknown)(...a),
  },
  prompts: { respond: jest.fn() },
  resonance: {
    list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
    generate: jest.fn(),
  },
  completionSuggestions: {
    list: jest.fn(() => Promise.resolve({ items: [] })),
    accept: jest.fn(),
    dismiss: jest.fn(),
  },
  promotions: {
    create: jest.fn(),
    remove: jest.fn(),
    setIncluded: jest.fn(),
    list: jest.fn(() => Promise.resolve([])),
  },
}));

jest.mock('@/navigation/hooks', () => ({
  ...(jest.requireActual('@/navigation/hooks') as Record<string, unknown>),
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
}));

jest.mock('@/context/ApiKeyContext', () => require('./apiKeyContextTestKit'));

// The web field measurement, stubbed so a programmatic write's re-measure is
// observable without switching the whole screen to web (#3001). It measures
// nothing unless a test says otherwise, exactly as on native.
const mockReadWebContentHeight = jest.fn<(_node: unknown) => number | undefined>();
jest.mock('../webFieldMeasure', () => ({
  readWebContentHeight: (node: unknown) => mockReadWebContentHeight(node),
}));

const JournalEntryScreen = require('../JournalEntryScreen').default;

/** The title the Course reader hands a reflection off under. */
const REFLECTION_TITLE = 'Stage 3 reflection — The Threshold';

function entry(overrides: Partial<JournalMessage> = {}): JournalMessage {
  return {
    id: 7,
    message: 'An existing page about rivers.',
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'freeform' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: 'Rivers',
    status: 'draft',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

/** The course reader's hand-back address, as the Course screen passes it. */
interface ReturnToCourse {
  screen: 'Course';
  params: { stageNumber?: number; contentId: number; scrollOffset: number };
}

interface RouteParams {
  entryId?: number;
  prefillTitle?: string;
  returnTo?: ReturnToCourse;
}

/** A course hand-off, so the exit row also carries "Back to reading". */
const RETURN_TO: ReturnToCourse = {
  screen: 'Course',
  params: { stageNumber: 3, contentId: 11, scrollOffset: 120 },
};

/** Render at a fixed window width, restoring the real hook afterwards. */
function withWidth<T>(width: number, run: () => T): T {
  const rn = require('react-native');
  const spy = jest
    .spyOn(rn, 'useWindowDimensions')
    .mockReturnValue({ width, height: 800, scale: 1, fontScale: 1 });
  try {
    return run();
  } finally {
    spy.mockRestore();
  }
}

function renderScreen(params?: RouteParams, autosaveDelayMs = 0) {
  const route = { key: 'k', name: 'JournalEntry' as const, params };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return {
    ...render(<Screen navigation={navigation} route={route} autosaveDelayMs={autosaveDelayMs} />),
    navigation,
  };
}

/** A jest mock of the screen's ``navigation.navigate``. */
type NavigateMock = jest.MockedFunction<(_route: string, _params?: unknown) => void>;

/** The token the screen addressed its capture hand-off to, read off the route it opened. */
function openedToken(navigate: NavigateMock): string {
  const call = navigate.mock.calls.find(([route]) => route === 'JournalPhotograph');
  return (call?.[1] as { appendTo: string } | undefined)?.appendTo ?? '';
}

beforeEach(() => {
  mockGet.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockCreate.mockResolvedValue(entry({ id: 42 }));
  mockUpdate.mockResolvedValue(entry({ id: 42 }));
  mockList.mockReset();
  mockList.mockResolvedValue({ items: [] });
  mockReadWebContentHeight.mockReset();
  mockReadWebContentHeight.mockReturnValue(undefined);
  act(() => {
    useCapturedTranscriptStore.getState().clear();
  });
});

// ---------------------------------------------------------------------------
// The affordance
// ---------------------------------------------------------------------------

describe('JournalEntryScreen — photograph a page', () => {
  it('offers the photograph affordance while writing', () => {
    const { getByTestId } = renderScreen({ prefillTitle: REFLECTION_TITLE });

    const button = getByTestId('journal-photograph-page');

    expect(button.props.accessibilityRole).toBe('button');
    expect(String(button.props.accessibilityLabel).length).toBeGreaterThan(0);
  });

  it('withholds it in read mode, where there is nothing to append to', async () => {
    mockGet.mockResolvedValue(entry({ id: 7, status: 'finished' }));

    const { queryByTestId, findByTestId, getByTestId } = renderScreen({ entryId: 7 });
    await findByTestId('journal-read-actions');

    expect(queryByTestId('journal-photograph-page')).toBeNull();
    // The exit row still renders in read mode — just without the camera.
    expect(exitRowOrder(getByTestId('journal-entry-exit-row'))).toEqual([
      'journal-api-key-settings',
      'journal-close-entry',
    ]);
  });

  it.each([{ width: 390 }, { width: 1280 }])(
    'offers the camera icon-only in the exit row, directly left of the close X at $width px',
    ({ width }) => {
      const view = withWidth(width, () => renderScreen({ prefillTitle: REFLECTION_TITLE }));
      const exitRow = view.getByTestId('journal-entry-exit-row');

      expect(exitRowOrder(exitRow)).toEqual([
        'journal-api-key-settings',
        'journal-photograph-page',
        'journal-close-entry',
      ]);
      expect(
        within(view.getByTestId('journal-writing-controls')).queryByTestId(
          'journal-photograph-page',
        ),
      ).toBeNull();

      const camera = within(exitRow).getByTestId('journal-photograph-page');
      expect(view.queryByText('Photograph a page')).toBeNull();
      expect(within(camera).getByTestId('journal-photograph-page-icon')).toBeTruthy();

      const cameraStyle = StyleSheet.flatten(camera.props.style);
      expect(cameraStyle.minWidth).toBeGreaterThanOrEqual(touchTarget.minimum);
      expect(cameraStyle.minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
      // Parity with the X beside it: the same icon-button footprint.
      expect(cameraStyle).toEqual(
        StyleSheet.flatten(view.getByTestId('journal-close-entry').props.style),
      );

      expect(camera.props.accessibilityRole).toBe('button');
      expect(camera.props.accessibilityLabel).toMatch(
        /^Photograph a page or screenshot and add its text to this entry$/,
      );

      const glyphs = view.UNSAFE_getAllByType(Camera);
      expect(glyphs).toHaveLength(1);
      expect(glyphs[0]?.props).toMatchObject({
        size: NAV_ICON_SIZE,
        strokeWidth: NAV_ICON_STROKE,
        color: accent.primary,
      });
      view.unmount();
    },
  );

  it('keeps the course return first, ahead of the key, camera and X', () => {
    const { getByTestId } = renderScreen({ prefillTitle: REFLECTION_TITLE, returnTo: RETURN_TO });

    expect(exitRowOrder(getByTestId('journal-entry-exit-row'))).toEqual([
      'journal-return-to-reading',
      'journal-api-key-settings',
      'journal-photograph-page',
      'journal-close-entry',
    ]);
  });

  it('opens the existing capture route in append mode rather than a fork of it', () => {
    const { getByTestId, navigation } = renderScreen({ prefillTitle: REFLECTION_TITLE });

    fireEvent.press(getByTestId('journal-photograph-page'));

    expect(navigation.navigate).toHaveBeenCalledWith('JournalPhotograph', {
      appendTo: expect.any(String),
    });
  });

  it('addresses the hand-off to itself, so a second page cannot collect it', () => {
    const { getByTestId, navigation } = renderScreen({ prefillTitle: REFLECTION_TITLE });

    fireEvent.press(getByTestId('journal-photograph-page'));
    const [, params] = navigation.navigate.mock.calls[0] as [string, { appendTo: string }];

    act(() => {
      useCapturedTranscriptStore.getState().deliver('some-other-page', 'Not for you.');
    });

    expect(getByTestId('journal-body-input').props.value).not.toContain('Not for you.');
    expect(params.appendTo).not.toBe('some-other-page');
  });
});

// ---------------------------------------------------------------------------
// The append
// ---------------------------------------------------------------------------

describe('JournalEntryScreen — the transcript comes back into the open page', () => {
  it('appends the transcript below prose already on the page', () => {
    const { getByTestId, navigation } = renderScreen({ prefillTitle: REFLECTION_TITLE });
    fireEvent.changeText(getByTestId('journal-body-input'), 'What I typed first.');
    fireEvent.press(getByTestId('journal-photograph-page'));

    act(() => {
      useCapturedTranscriptStore
        .getState()
        .deliver(openedToken(navigation.navigate), 'What I wrote by hand.');
    });

    expect(getByTestId('journal-body-input').props.value).toBe(
      'What I typed first.\n\nWhat I wrote by hand.',
    );
  });

  it('fills a blank reflection with the transcript alone', () => {
    const { getByTestId, navigation } = renderScreen({ prefillTitle: REFLECTION_TITLE });
    fireEvent.press(getByTestId('journal-photograph-page'));

    act(() => {
      useCapturedTranscriptStore
        .getState()
        .deliver(openedToken(navigation.navigate), 'My handwritten response.');
    });

    expect(getByTestId('journal-body-input').props.value).toBe('My handwritten response.');
  });

  it("keeps the reflection's prefilled title and saves one entry, not two", async () => {
    const { getByTestId, navigation } = renderScreen({ prefillTitle: REFLECTION_TITLE });
    fireEvent.press(getByTestId('journal-photograph-page'));

    act(() => {
      useCapturedTranscriptStore
        .getState()
        .deliver(openedToken(navigation.navigate), 'My handwritten response.');
    });

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    // Let the save state settle inside act() before reading the fields back.
    await waitFor(() => expect(getByTestId('journal-save-hint')).toHaveTextContent('Saved'));
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      title: REFLECTION_TITLE,
      message: 'My handwritten response.',
    });
    expect(getByTestId('journal-title-input').props.value).toBe(REFLECTION_TITLE);
  });

  it('collects the transcript exactly once, never re-appending it on a later render', () => {
    const { getByTestId, navigation } = renderScreen({ prefillTitle: REFLECTION_TITLE });
    fireEvent.press(getByTestId('journal-photograph-page'));

    act(() => {
      useCapturedTranscriptStore
        .getState()
        .deliver(openedToken(navigation.navigate), 'Read me once.');
    });
    // Any later keystroke re-renders the screen against a now-empty hand-off.
    fireEvent.changeText(getByTestId('journal-body-input'), 'Read me once. And more.');

    expect(useCapturedTranscriptStore.getState().pending).toBeNull();
    expect(getByTestId('journal-body-input').props.value).toBe('Read me once. And more.');
  });

  it('ignores a transcript addressed to a hand-off it never opened', () => {
    const { getByTestId } = renderScreen({ prefillTitle: REFLECTION_TITLE });

    act(() => {
      useCapturedTranscriptStore.getState().deliver('capture-999', 'Somebody else’s page.');
    });

    expect(getByTestId('journal-body-input').props.value).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Growth after a write that is not typed (#3001)
// ---------------------------------------------------------------------------

/** How much taller the measured content is after a programmatic write. */
const WRITTEN_GROWTH = 400;

/** Measure ``height`` off any mounted host, and nothing off a field with no ref to read. */
function measureMountedAs(height: number): void {
  mockReadWebContentHeight.mockImplementation((node) => (node == null ? undefined : height));
}

/** A field's flattened laid-out height. */
function fieldHeight(node: ReturnType<ReturnType<typeof render>['getByTestId']>): number {
  return StyleSheet.flatten(node.props.style).height as number;
}

describe('JournalEntryScreen — fields re-measure after a write that is not typed (#3001)', () => {
  it('grows the body when a transcript is appended into it', () => {
    const { getByTestId, navigation } = renderScreen({ prefillTitle: REFLECTION_TITLE });
    fireEvent.press(getByTestId('journal-photograph-page'));
    const grown = Math.ceil(fieldHeight(getByTestId('journal-body-input')) + WRITTEN_GROWTH);
    measureMountedAs(grown);

    act(() => {
      useCapturedTranscriptStore
        .getState()
        .deliver(openedToken(navigation.navigate), 'A long handwritten page.');
    });

    expect(fieldHeight(getByTestId('journal-body-input'))).toBe(grown);
  });

  it('grows the title and the body when a saved entry loads into them', async () => {
    let resolveLoad: (loaded: JournalMessage) => void = () => undefined;
    mockGet.mockReturnValue(
      new Promise<JournalMessage>((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const { getByTestId } = renderScreen({ entryId: 7 });
    const loadedHeight = Math.ceil(fieldHeight(getByTestId('journal-body-input')) + WRITTEN_GROWTH);
    measureMountedAs(loadedHeight);

    await act(async () => {
      resolveLoad(entry());
    });

    await waitFor(() => expect(getByTestId('journal-title-input').props.value).toBe('Rivers'));
    expect(fieldHeight(getByTestId('journal-title-input'))).toBe(loadedHeight);
    expect(fieldHeight(getByTestId('journal-body-input'))).toBe(loadedHeight);
  });
});
