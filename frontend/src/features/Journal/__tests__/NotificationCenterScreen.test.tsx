/* eslint-env jest */
/**
 * ``NotificationCenterScreen`` (#3142): one quiet inbox for what sat above the
 * fold on the Journal home — the stat tiles, Return, invitations, the stage's
 * prompts and the voice-readiness band — in that order, each with the ring
 * gating it has on the home. A heading appears only over a section that has
 * something to show, and an inbox with nothing waiting says so once.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';

import NotificationCenterScreen, {
  EMPTY_SETTLE_MS,
  NOTIFICATION_CENTER_EMPTY,
  NOTIFICATION_CENTER_HEADINGS,
} from '../NotificationCenterScreen';

import type { StagePromptsResponse } from '@/api';
import { editorialType, ink } from '@/design/tokens';
import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';

const mockNavigate = jest.fn();
const mockBand = jest.fn<() => { stage: StagePromptsResponse | null }>();

/** What each stubbed section reports, set per test before render. */
const mockSlots: Record<string, { visible: boolean; count: number }> = {};

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, setOptions: jest.fn() }),
  useFocusEffect: () => undefined,
}));

/** A stub section that renders a marker and reports itself as the real one does. */
function mockStubSection(slot: string, testID: string) {
  return () => {
    const { Text } = require('react-native');
    const { useReportNotificationPresence } = require('../notificationPresence');
    const presence = mockSlots[slot] ?? { visible: false, count: 0 };
    useReportNotificationPresence(slot, presence.visible, presence.count);
    return presence.visible ? <Text testID={testID}>{slot}</Text> : null;
  };
}

jest.mock('../JournalPrimaryInvitation', () => ({
  __esModule: true,
  default: mockStubSection('writing', 'stub-writing'),
}));
jest.mock('../PromptHistoryList', () => ({ __esModule: true, default: () => null }));
jest.mock('../useNotificationCount', () => ({ useFocusRefreshKey: () => 0 }));

jest.mock('../StatTileRow', () => ({
  __esModule: true,
  default: mockStubSection('today', 'stub-stat-tiles'),
}));
jest.mock('@/features/Return/ReturnStack', () => ({
  __esModule: true,
  default: mockStubSection('return', 'stub-return'),
}));
jest.mock('@/features/Invitations/InvitationStack', () => ({
  __esModule: true,
  default: mockStubSection('invitations', 'stub-invitations'),
}));
jest.mock('../VoiceReadinessBand', () => ({
  __esModule: true,
  default: mockStubSection('voice', 'stub-voice'),
}));
jest.mock('../StagePromptSection', () => {
  const actual = jest.requireActual('../StagePromptSection') as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    useStagePromptPlace: () => ({ week: 9, stage: 3 }),
    useStagePrompts: () => ({
      answered: new Set<number>(),
      writable: true,
      setAside: jest.fn(),
      bringBack: jest.fn(),
      ...mockBand(),
    }),
  };
});

const RED_PROMPTS: StagePromptsResponse = {
  stage: 3,
  stage_name: 'Red',
  prompts: [
    { ordinal: 1, title: 'Name your power', body: 'Where is it?', cadence: 'Daily' },
    { ordinal: 2, title: 'Own a want', body: 'What do you want?', cadence: null, dismissed: true },
  ],
} as StagePromptsResponse;

/** Render the screen and let its settle window pass. */
function renderSettled(): ReturnType<typeof render> {
  jest.useFakeTimers();
  try {
    const view = render(<NotificationCenterScreen />);
    act(() => {
      jest.advanceTimersByTime(EMPTY_SETTLE_MS);
    });
    return view;
  } finally {
    jest.useRealTimers();
  }
}

/** The empty note: the exact words, in the note face. */
function assertEmptyNote(empty: { props: { children?: unknown; style?: unknown } }): void {
  expect(empty.props.children).toBe(NOTIFICATION_CENTER_EMPTY);
  expect(NOTIFICATION_CENTER_EMPTY).toBe('Nothing waiting.');
  const style = Object.assign({}, ...[empty.props.style].flat(3));
  expect(style.fontSize).toBe(editorialType.note.fontSize);
}

function setSlots(next: Record<string, { visible: boolean; count: number }>): void {
  for (const key of Object.keys(mockSlots)) delete mockSlots[key];
  Object.assign(mockSlots, next);
}

beforeEach(() => {
  jest.clearAllMocks();
  setSlots({});
  mockBand.mockReturnValue({ stage: null });
  useDepthPreferencesStore.setState({ enable_habits: true, enable_practices: true });
});

describe('NotificationCenterScreen', () => {
  it('renders the five sections inside one scroll, in order', () => {
    setSlots({
      today: { visible: true, count: 0 },
      return: { visible: true, count: 1 },
      invitations: { visible: true, count: 2 },
      voice: { visible: true, count: 1 },
    });
    mockBand.mockReturnValue({ stage: RED_PROMPTS });

    const { getByTestId, toJSON } = render(<NotificationCenterScreen />);
    const scroll = getByTestId('journal-notification-center');
    const ids = [
      'stub-stat-tiles',
      'stub-return',
      'stub-invitations',
      'journal-stage-prompts',
      'stub-voice',
    ];
    for (const id of ids) expect(within(scroll).getByTestId(id)).toBeTruthy();

    const json = JSON.stringify(toJSON());
    const positions = ids.map((id) => json.indexOf(`"testID":"${id}"`));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('heads each section that has something to show, and only those', () => {
    setSlots({
      today: { visible: true, count: 0 },
      invitations: { visible: true, count: 1 },
    });

    const { getByText, queryByText } = render(<NotificationCenterScreen />);

    expect(getByText(NOTIFICATION_CENTER_HEADINGS.today)).toBeTruthy();
    expect(getByText(NOTIFICATION_CENTER_HEADINGS.invitations)).toBeTruthy();
    expect(queryByText(NOTIFICATION_CENTER_HEADINGS.return)).toBeNull();
    expect(queryByText(NOTIFICATION_CENTER_HEADINGS.prompts)).toBeNull();
    expect(queryByText(NOTIFICATION_CENTER_HEADINGS.voice)).toBeNull();
  });

  it('uses the plain editorial headings the design names', () => {
    expect(NOTIFICATION_CENTER_HEADINGS).toEqual({
      today: 'Today',
      writing: 'Writing invitations',
      return: 'Return',
      invitations: 'Invitations',
      prompts: "This week's prompts",
      voice: 'Your voice',
    });
  });

  it('marks each heading as a header, in ink on paper', () => {
    setSlots({ return: { visible: true, count: 1 } });
    const { getByText } = render(<NotificationCenterScreen />);
    const heading = getByText(NOTIFICATION_CENTER_HEADINGS.return);
    expect(heading.props.accessibilityRole).toBe('header');
    const style = Object.assign({}, ...[heading.props.style].flat(3));
    expect(style.color).toBe(ink.primary);
    expect(style.fontFamily).toBe(editorialType.heading.fontFamily);
  });

  it('heads the prompts once the stage has loaded, even when all are set aside', () => {
    mockBand.mockReturnValue({
      stage: {
        ...RED_PROMPTS,
        prompts: RED_PROMPTS.prompts.map((p) => ({ ...p, dismissed: true })),
      },
    });
    const { getByText } = render(<NotificationCenterScreen />);
    expect(getByText(NOTIFICATION_CENTER_HEADINGS.prompts)).toBeTruthy();
  });

  it('says "Nothing waiting." in the note face when no item is waiting', () => {
    // The stat tiles are counters, not items: they never hold the empty note off.
    setSlots({ today: { visible: true, count: 0 } });
    jest.useFakeTimers();
    try {
      const { getByTestId, queryByTestId } = render(<NotificationCenterScreen />);
      // Not while the sections may still be loading: every one starts empty.
      expect(queryByTestId('journal-notification-center-empty')).toBeNull();
      act(() => {
        jest.advanceTimersByTime(EMPTY_SETTLE_MS);
      });
      assertEmptyNote(getByTestId('journal-notification-center-empty'));
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the empty note away while any item waits, however long it has been', () => {
    setSlots({ voice: { visible: true, count: 1 } });
    const { queryByTestId } = renderSettled();
    expect(queryByTestId('journal-notification-center-empty')).toBeNull();
  });

  it('keeps the empty note away while a stage prompt is still offered', () => {
    mockBand.mockReturnValue({ stage: RED_PROMPTS });
    const { queryByTestId } = renderSettled();
    expect(queryByTestId('journal-notification-center-empty')).toBeNull();
  });

  it('quiets Return entirely while the habits ring is declined', () => {
    useDepthPreferencesStore.setState({ enable_habits: false });
    setSlots({ return: { visible: true, count: 1 } });
    const { queryByTestId, queryByText } = render(<NotificationCenterScreen />);
    expect(queryByTestId('stub-return')).toBeNull();
    expect(queryByText(NOTIFICATION_CENTER_HEADINGS.return)).toBeNull();
  });

  it('opens a prompt card on the entry page for that prompt', () => {
    mockBand.mockReturnValue({ stage: RED_PROMPTS });
    const { getByTestId } = render(<NotificationCenterScreen />);
    fireEvent.press(getByTestId('journal-stage-prompt-1'));
    expect(mockNavigate).toHaveBeenCalledWith('JournalEntry', {
      weekNumber: 9,
      promptOrdinal: 1,
      promptQuestion: 'Where is it?',
      prefillTitle: 'Name your power',
    });
  });
});
