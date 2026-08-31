/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { RESONANCE_BUTTON_CLEARANCE } from '../JournalEntry.styles';

import type { JournalMessage } from '@/api';
import { colors, writingField, writingFieldFocus } from '@/design/tokens';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockCreate = jest.fn() as jest.MockedFunction<(_e: unknown) => Promise<JournalMessage>>;
const mockUpdate = jest.fn() as jest.MockedFunction<
  (_id: number, _p: unknown) => Promise<JournalMessage>
>;

const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;
const mockRespond = jest.fn() as jest.MockedFunction<
  (_w: number, _b: string, _t?: string) => Promise<unknown>
>;
const mockGenerate = jest.fn() as jest.MockedFunction<(_id: number) => Promise<unknown>>;

jest.mock('@/api', () => ({
  journal: {
    get: (...a: unknown[]) => (mockGet as unknown as (...x: unknown[]) => unknown)(...a),
    create: (...a: unknown[]) => (mockCreate as unknown as (...x: unknown[]) => unknown)(...a),
    update: (...a: unknown[]) => (mockUpdate as unknown as (...x: unknown[]) => unknown)(...a),
  },
  prompts: {
    respond: (...a: unknown[]) => (mockRespond as unknown as (...x: unknown[]) => unknown)(...a),
  },
  resonance: {
    list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
    generate: (...a: unknown[]) => (mockGenerate as unknown as (...x: unknown[]) => unknown)(...a),
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

const JournalEntryScreen = require('../JournalEntryScreen').default;

function entry(overrides: Partial<JournalMessage> = {}): JournalMessage {
  return {
    id: 7,
    message: 'An existing page about rivers.',
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'reflection' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: 'Rivers',
    status: 'draft',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

interface ReturnToCourse {
  screen: 'Course';
  params: { stageNumber?: number; contentId: number; scrollOffset: number };
}

function renderScreen(
  params?: {
    entryId?: number;
    weekNumber?: number;
    promptOrdinal?: number;
    promptQuestion?: string;
    prefillTitle?: string;
    practiceSessionId?: number;
    userPracticeId?: number;
    prefillQuote?: { text: string; sourceTitle: string };
    returnTo?: ReturnToCourse;
  },
  extraProps: Record<string, unknown> = {},
) {
  const route = { key: 'k', name: 'JournalEntry' as const, params };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return {
    ...render(<Screen navigation={navigation} route={route} {...extraProps} />),
    navigation,
  };
}

beforeEach(() => {
  mockGet.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockCreate.mockResolvedValue(entry({ id: 42 }));
  mockUpdate.mockResolvedValue(entry({ id: 42 }));
  mockList.mockReset();
  mockList.mockResolvedValue({ items: [] });
  mockRespond.mockReset();
  mockRespond.mockResolvedValue({});
  mockGenerate.mockReset();
  mockGenerate.mockResolvedValue({ marginalia: [], suggestions: [] });
});

type StyledNode = {
  type: unknown;
  props: { style?: StyleProp<ViewStyle> };
  parent: StyledNode | null;
};

/** Flatten the nearest host ancestor's style — where a wrapper's layout lives. */
function hostWrapperStyle(element: { parent: unknown }): ViewStyle {
  let node = element.parent as StyledNode | null;
  while (node && typeof node.type !== 'string') node = node.parent;
  return StyleSheet.flatten(node?.props.style) ?? {};
}

describe('JournalEntryScreen', () => {
  /** A finished entry loaded into read mode, shared by the read-mode specs. */
  async function renderFinished(message = 'I walked.') {
    mockGet.mockResolvedValue(entry({ id: 7, message, status: 'finished' }));
    mockList.mockResolvedValue({ items: [] });
    const view = renderScreen({ entryId: 7 });
    await waitFor(() => expect(view.queryByTestId('journal-edit-button')).not.toBeNull());
    return view;
  }

  it('records a weekly-prompt page via respond, not a duplicate create', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId, queryByTestId } = renderScreen(
        {
          weekNumber: 3,
          promptQuestion: 'What did you notice?',
          prefillTitle: 'Week 3 Reflection',
        },
        { autosaveDelayMs: 100 },
      );
      expect(getByTestId('journal-title-input').props.value).toBe('Week 3 Reflection');
      fireEvent.changeText(getByTestId('journal-body-input'), 'I noticed the willow.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockRespond).toHaveBeenCalledWith(3, 'I noticed the willow.', {
        title: 'Week 3 Reflection',
      });
      expect(mockCreate).not.toHaveBeenCalled(); // no double-create
      // Resonance can't run on a prompt-compose entry (no local id), so the
      // button must stay hidden even once idle with content.
      expect(queryByTestId('get-resonance-button')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('answers the prompt that was tapped, carrying its ordinal to respond', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(
        {
          weekNumber: 14,
          promptOrdinal: 3,
          promptQuestion: 'Which curiosity serves which problem?',
          prefillTitle: 'Combine Multiple Curiosities',
        },
        { autosaveDelayMs: 100 },
      );
      fireEvent.changeText(getByTestId('journal-body-input'), 'Wayfinding and loneliness.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockRespond).toHaveBeenCalledWith(14, 'Wayfinding and loneliness.', {
        title: 'Combine Multiple Curiosities',
        promptOrdinal: 3,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('opens a prompt page blank rather than under a title the client guessed', () => {
    // A week number alone names no prompt: the title is curriculum text the
    // server sends, so without one the page opens untitled.
    const { getByTestId } = renderScreen({ weekNumber: 3, promptQuestion: 'What did you notice?' });
    expect(getByTestId('journal-title-input').props.value).toBe('');
  });

  it('does not silently discard a typed title in weekly-prompt compose mode', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(
        {
          weekNumber: 3,
          promptQuestion: 'What did you notice?',
          prefillTitle: 'Week 3 Reflection',
        },
        { autosaveDelayMs: 100 },
      );
      expect(getByTestId('journal-title-input').props.editable).not.toBe(false);
      fireEvent.changeText(getByTestId('journal-title-input'), 'Reclaiming my anger');
      fireEvent.changeText(getByTestId('journal-body-input'), 'I noticed the willow.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockRespond).toHaveBeenCalledWith(3, 'I noticed the willow.', {
        title: 'Reclaiming my anger',
      });
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the title editable for a plain journal entry', () => {
    const { getByTestId } = renderScreen();
    expect(getByTestId('journal-title-input').props.editable).not.toBe(false);
  });

  it('keeps the title editable for a practice-session entry', () => {
    const { getByTestId } = renderScreen({
      practiceSessionId: 55,
      prefillTitle: 'After Forest grounding',
    });
    expect(getByTestId('journal-title-input').props.editable).not.toBe(false);
  });

  it('pre-links a practice session on the created entry', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(
        { practiceSessionId: 55, prefillTitle: 'After Forest grounding' },
        { autosaveDelayMs: 100 },
      );
      fireEvent.changeText(getByTestId('journal-body-input'), 'That was calming.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'That was calming.', practice_session_id: 55 }),
      );
      expect(mockRespond).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('pre-links a user practice on the created entry', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(
        { userPracticeId: 91, prefillTitle: 'After a habit check-in' },
        { autosaveDelayMs: 100 },
      );
      fireEvent.changeText(getByTestId('journal-body-input'), 'That felt grounding.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'That felt grounding.', user_practice_id: 91 }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('never double-submits a weekly-prompt response on a second autosave', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(
        {
          weekNumber: 3,
          promptQuestion: 'What did you notice?',
          prefillTitle: 'Week 3 Reflection',
        },
        { autosaveDelayMs: 100 },
      );
      fireEvent.changeText(getByTestId('journal-body-input'), 'I noticed the willow.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockRespond).toHaveBeenCalledTimes(1);

      fireEvent.changeText(getByTestId('journal-body-input'), 'I noticed the willow and the oak.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockRespond).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('renders the title + body inputs and no chat UI', () => {
    const { getByTestId, queryByText } = renderScreen();
    expect(getByTestId('journal-title-input')).toBeTruthy();
    expect(getByTestId('journal-body-input')).toBeTruthy();
    // No chat affordances on the writing surface.
    expect(queryByText('Send')).toBeNull();
  });

  it('grows the body input to fill available vertical space on a tall desktop viewport', () => {
    const rn = require('react-native');
    const spy = jest
      .spyOn(rn, 'useWindowDimensions')
      .mockReturnValue({ width: 1280, height: 900, scale: 1, fontScale: 1 });
    try {
      const { getByTestId } = renderScreen();
      const body = StyleSheet.flatten(getByTestId('journal-body-input').props.style);
      expect(body.flexGrow).toBeGreaterThan(0);
      expect(body.minHeight).toBe(240);
    } finally {
      spy.mockRestore();
    }
  });

  it('reserves a margin column for the inline marginalia UI', () => {
    const { getByTestId } = renderScreen();
    expect(getByTestId('journal-margin-column')).toBeTruthy();
  });

  it('reserves bottom clearance in edit mode, where Get Resonance floats over the page', () => {
    const { getByTestId } = renderScreen();
    const page = StyleSheet.flatten(getByTestId('journal-page').props.style);
    expect(page.paddingBottom).toBe(RESONANCE_BUTTON_CLEARANCE);
  });

  it('leaves no dead band below the entry in read mode, where nothing floats', async () => {
    const { getByTestId } = await renderFinished();
    const page = StyleSheet.flatten(getByTestId('journal-page').props.style);
    expect(page.paddingBottom).toBeUndefined();
  });

  it('gathers the read-mode actions into one row', async () => {
    const { getByTestId } = await renderFinished();
    const row = within(getByTestId('journal-read-actions'));
    expect(row.getByTestId('get-resonance-button')).toBeTruthy();
    expect(row.getByTestId('promote-quote-button')).toBeTruthy();
    expect(row.getByTestId('journal-edit-button')).toBeTruthy();
  });

  it('does not float the resonance affordance over the entry in read mode', async () => {
    const { getByTestId } = await renderFinished();
    expect(hostWrapperStyle(getByTestId('get-resonance-button')).position).not.toBe('absolute');
  });

  it('leaves no phantom gap in the read row when an empty entry hides resonance', async () => {
    const { getByTestId, queryByTestId } = await renderFinished('');
    const row = within(getByTestId('journal-read-actions'));
    expect(row.getByTestId('promote-quote-button')).toBeTruthy();
    expect(row.getByTestId('journal-edit-button')).toBeTruthy();
    expect(queryByTestId('get-resonance-button')).toBeNull();
    const hidden = getByTestId('get-resonance-button', { includeHiddenElements: true });
    expect(hostWrapperStyle(hidden).height).toBe(0);
  });

  it('runs a resonance pass exactly once from the inline read-mode action', async () => {
    const { getByTestId } = await renderFinished();
    const row = within(getByTestId('journal-read-actions'));
    fireEvent.press(row.getByTestId('get-resonance-button'));
    await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(1));
    expect(mockGenerate).toHaveBeenCalledWith(7);
  });

  it('still enters edit mode from the Edit action in the read-mode row', async () => {
    const { getByTestId, findByTestId } = await renderFinished();
    fireEvent.press(within(getByTestId('journal-read-actions')).getByTestId('journal-edit-button'));
    fireEvent.press(getByTestId('edit-confirm-edit'));
    expect(await findByTestId('journal-body-input')).toBeTruthy();
  });

  it('floats the writing area as a lighter sheet above the deeper desk', () => {
    const { getByTestId } = renderScreen();
    const sheet = StyleSheet.flatten(getByTestId('journal-sheet').props.style);
    // The sheet is the lighter paper ground, lifted by the warm paper shadow.
    expect(sheet.backgroundColor).toBe(colors.paper.background);
    expect(sheet.shadowRadius).toBeGreaterThan(0);
    expect(sheet.elevation).toBeGreaterThan(0);
    // The screen root is the deeper desk ground the sheet floats above.
    const root = StyleSheet.flatten(getByTestId('journal-screen').props.style);
    expect(root.backgroundColor).toBe(colors.paper.desk);
  });

  it('rules a faint vertical page-margin between the columns on wide screens', () => {
    const { getByTestId } = renderScreen();
    const margin = StyleSheet.flatten(getByTestId('journal-margin-column').props.style);
    expect(margin.borderLeftWidth).toBeGreaterThan(0);
    expect(margin.borderLeftColor).toBe(colors.paper.hairline);
  });

  it('moves the margin rule to the top when the marginalia stacks on narrow screens', () => {
    const rn = require('react-native');
    const spy = jest
      .spyOn(rn, 'useWindowDimensions')
      .mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
    try {
      const { getByTestId } = renderScreen();
      const margin = StyleSheet.flatten(getByTestId('journal-margin-column').props.style);
      expect(margin.borderTopWidth).toBeGreaterThan(0);
      expect(margin.borderLeftWidth).toBe(0);
      expect(margin.borderTopColor).toBe(colors.paper.hairline);
    } finally {
      spy.mockRestore();
    }
  });

  it('autosaves once after the debounce when the body changes', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 1500 });
      fireEvent.changeText(getByTestId('journal-body-input'), 'A new thought.');
      expect(mockCreate).not.toHaveBeenCalled(); // still within the debounce window
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1500);
      });
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'A new thought.' }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('updates (not creates again) on the second save after the initial create', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });
      fireEvent.changeText(getByTestId('journal-body-input'), 'First save.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockCreate).toHaveBeenCalledTimes(1);

      fireEvent.changeText(getByTestId('journal-body-input'), 'Second save.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockCreate).toHaveBeenCalledTimes(1); // create not repeated
      expect(mockUpdate).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ message: 'Second save.' }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('creates only once when a second save overlaps an in-flight create on a new entry', async () => {
    jest.useFakeTimers();
    try {
      // A create that stays pending so the second save overlaps it.
      mockCreate.mockReturnValue(new Promise<JournalMessage>(() => {}));
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });
      fireEvent.changeText(getByTestId('journal-body-input'), 'First.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockCreate).toHaveBeenCalledTimes(1);

      fireEvent.changeText(getByTestId('journal-body-input'), 'First and second.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      // The in-flight guard makes the overlapping save await the pending create
      // instead of POSTing a duplicate — still exactly one create.
      expect(mockCreate).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('routes the overlapping save to update once the in-flight create resolves', async () => {
    jest.useFakeTimers();
    try {
      let resolveCreate!: (_v: JournalMessage) => void;
      mockCreate.mockReturnValue(
        new Promise<JournalMessage>((res) => {
          resolveCreate = res;
        }),
      );
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });
      fireEvent.changeText(getByTestId('journal-body-input'), 'First.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      fireEvent.changeText(getByTestId('journal-body-input'), 'First and second.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      // Release the create: the queued save now sees the created id and PATCHes it
      // rather than starting a second create.
      await act(async () => {
        resolveCreate(entry({ id: 42 }));
        await jest.advanceTimersByTimeAsync(1);
      });
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockUpdate).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ message: 'First and second.' }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('drains queued saves onto one retry when a create fails with saves piled behind it', async () => {
    jest.useFakeTimers();
    try {
      let rejectCreate!: (_e: Error) => void;
      // The first create stays pending, then fails; the retry (2nd call) resolves
      // via the beforeEach default. Saves that pile up behind the failing create
      // must serialize onto that single retry, never fan out into parallel creates.
      mockCreate.mockReturnValueOnce(
        new Promise<JournalMessage>((_res, rej) => {
          rejectCreate = rej;
        }),
      );
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });
      fireEvent.changeText(getByTestId('journal-body-input'), 'First.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      fireEvent.changeText(getByTestId('journal-body-input'), 'Second.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      fireEvent.changeText(getByTestId('journal-body-input'), 'Third.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      await act(async () => {
        rejectCreate(new Error('network'));
        await jest.advanceTimersByTimeAsync(1);
      });
      // One failed create + exactly one retry — never three concurrent creates.
      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(mockUpdate).toHaveBeenCalledWith(42, expect.objectContaining({ message: 'Third.' }));
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows a distinct error hint when a save fails', async () => {
    mockCreate.mockRejectedValue(new Error('network'));
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });
      fireEvent.changeText(getByTestId('journal-body-input'), 'A thought.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(getByTestId('journal-save-hint').props.children).toMatch(/save/i);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not persist an empty draft', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 1500 });
      fireEvent.changeText(getByTestId('journal-body-input'), '   ');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1500);
      });
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  function noteRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 50,
      journal_entry_id: 7,
      kind: 'theme',
      anchor_start: 2,
      anchor_end: 8,
      anchor_text: 'walked',
      note: 'You keep moving.',
      essay: null,
      essay_generated_at: null,
      status: 'active',
      created_at: '',
      updated_at: '',
      ...overrides,
    };
  }

  it('renders read-mode highlights + margin notes for a finished entry', async () => {
    mockGet.mockResolvedValue(
      entry({ id: 7, message: 'I walked by the river.', status: 'finished' }),
    );
    mockList.mockResolvedValue({ items: [noteRow()] });
    const { findByTestId, queryByTestId } = renderScreen({ entryId: 7 });
    expect(await findByTestId('margin-note-50')).toBeTruthy();
    expect(queryByTestId('journal-body-read')).not.toBeNull();
    expect(queryByTestId('highlight-50')).not.toBeNull();
    // Read mode replaces the editable body.
    expect(queryByTestId('journal-body-input')).toBeNull();
  });

  it('loads an existing draft by id (editable)', async () => {
    mockGet.mockResolvedValue(entry({ id: 7, title: 'Rivers', message: 'An existing page.' }));
    const { getByTestId } = renderScreen({ entryId: 7 });
    await waitFor(() => {
      expect(getByTestId('journal-title-input').props.value).toBe('Rivers');
    });
    expect(mockGet).toHaveBeenCalledWith(7);
    expect(getByTestId('journal-body-input').props.value).toBe('An existing page.');
  });

  it('loads an existing draft with no title into a blank title field', async () => {
    mockGet.mockResolvedValue(entry({ id: 7, title: null, message: 'No title yet.' }));
    const { getByTestId } = renderScreen({ entryId: 7 });
    await waitFor(() => {
      expect(getByTestId('journal-body-input').props.value).toBe('No title yet.');
    });
    expect(getByTestId('journal-title-input').props.value).toBe('');
  });

  describe('edit gate (finished entries)', () => {
    it('opens the confirm dialog when editing a finished entry', async () => {
      const { getByTestId, queryByTestId } = await renderFinished();
      fireEvent.press(getByTestId('journal-edit-button'));
      expect(queryByTestId('edit-confirm-dialog')).not.toBeNull();
      // Still locked — body not editable yet.
      expect(queryByTestId('journal-body-input')).toBeNull();
    });

    it('Edit unlocks the editable body', async () => {
      const { getByTestId, findByTestId } = await renderFinished();
      fireEvent.press(getByTestId('journal-edit-button'));
      fireEvent.press(getByTestId('edit-confirm-edit'));
      expect(await findByTestId('journal-body-input')).toBeTruthy();
    });

    it('Start new navigates to a blank JournalEntry', async () => {
      const { getByTestId, navigation } = await renderFinished();
      fireEvent.press(getByTestId('journal-edit-button'));
      fireEvent.press(getByTestId('edit-confirm-start-new'));
      expect(navigation.push).toHaveBeenCalledWith('JournalEntry');
    });

    it('Cancel keeps the entry locked', async () => {
      const { getByTestId, queryByTestId } = await renderFinished();
      fireEvent.press(getByTestId('journal-edit-button'));
      fireEvent.press(getByTestId('edit-confirm-cancel'));
      expect(queryByTestId('journal-body-input')).toBeNull();
      expect(queryByTestId('edit-confirm-dialog')).toBeNull();
    });

    it('re-fetches marginalia after the first save following an edit', async () => {
      jest.useFakeTimers();
      try {
        mockGet.mockResolvedValue(entry({ id: 7, message: 'I walked.', status: 'finished' }));
        mockList.mockResolvedValue({ items: [] });
        const { getByTestId, findByTestId } = renderScreen(
          { entryId: 7 },
          { autosaveDelayMs: 100 },
        );
        await act(async () => {
          await Promise.resolve();
        });
        fireEvent.press(getByTestId('journal-edit-button'));
        fireEvent.press(getByTestId('edit-confirm-edit'));
        const input = await findByTestId('journal-body-input');
        mockList.mockClear();
        fireEvent.changeText(input, 'I strolled instead.');
        await act(async () => {
          await jest.advanceTimersByTimeAsync(100);
        });
        expect(mockUpdate).toHaveBeenCalledWith(
          7,
          expect.objectContaining({ message: 'I strolled instead.' }),
        );
        expect(mockList).toHaveBeenCalledWith(7); // re-read after the edit-save
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('marks a draft finished via the Finish control', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId, findByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });
      fireEvent.changeText(getByTestId('journal-body-input'), 'A finished thought.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      mockUpdate.mockClear();
      fireEvent.press(getByTestId('journal-finish-button'));
      await act(async () => {
        await Promise.resolve();
      });
      // Spec change: Finish now writes the full body + title atomically with the status flip, not a status-only PATCH.
      expect(mockUpdate).toHaveBeenCalledWith(42, {
        message: 'A finished thought.',
        title: null,
        status: 'finished',
      });
      // Returns to read mode.
      expect(await findByTestId('journal-edit-button')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  describe('prefillQuote + returnTo', () => {
    const quote = {
      text: 'To open your heart not just to yourself, but to others.',
      sourceTitle: 'The Mood of Blue',
    };
    const formattedQuote =
      '> To open your heart not just to yourself, but to others.\n> — The Mood of Blue\n\n';
    const returnTo: ReturnToCourse = {
      screen: 'Course',
      params: { stageNumber: 2, contentId: 17, scrollOffset: 480 },
    };

    it('pre-fills the body with the formatted quote block', () => {
      const { getByTestId } = renderScreen({ prefillQuote: quote });
      expect(getByTestId('journal-body-input').props.value).toBe(formattedQuote);
    });

    it('composes with prefillTitle: title and body both pre-fill', () => {
      const { getByTestId } = renderScreen({
        prefillQuote: quote,
        prefillTitle: 'Reflecting on The Mood of Blue',
      });
      expect(getByTestId('journal-title-input').props.value).toBe('Reflecting on The Mood of Blue');
      expect(getByTestId('journal-body-input').props.value).toBe(formattedQuote);
    });

    it('shows a Back to reading affordance when returnTo is present', () => {
      const { getByTestId, getByText } = renderScreen({ returnTo });
      expect(getByTestId('journal-return-to-reading')).toBeTruthy();
      expect(getByText('Back to reading')).toBeTruthy();
    });

    it('navigates back to the Course content on Back to reading', () => {
      const { getByTestId, navigation } = renderScreen({ returnTo });
      fireEvent.press(getByTestId('journal-return-to-reading'));
      expect(navigation.navigate).toHaveBeenCalledWith(
        'Tabs',
        expect.objectContaining({
          screen: 'Course',
          params: { stageNumber: 2, contentId: 17, scrollOffset: 480 },
        }),
      );
    });

    it('hides the return affordance when returnTo is absent', () => {
      const { queryByTestId } = renderScreen();
      expect(queryByTestId('journal-return-to-reading')).toBeNull();
    });

    it('leaves the body blank and hides the return affordance with no params', () => {
      const { getByTestId, queryByTestId } = renderScreen();
      expect(getByTestId('journal-body-input').props.value).toBe('');
      expect(queryByTestId('journal-return-to-reading')).toBeNull();
    });

    it('flushes the typed draft before navigating away via Back to reading', async () => {
      jest.useFakeTimers();
      try {
        const { getByTestId } = renderScreen({ returnTo }, { autosaveDelayMs: 100 });
        fireEvent.changeText(getByTestId('journal-body-input'), 'A thought mid-read.');
        fireEvent.press(getByTestId('journal-return-to-reading'));
        await act(async () => {
          await jest.advanceTimersByTimeAsync(100);
        });
        expect(mockCreate).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'A thought mid-read.' }),
        );
      } finally {
        jest.useRealTimers();
      }
    });
  });
});

/**
 * The writing page carries no field borders, so the browser's own focus ring
 * (a blue box on the paper sheet) is dropped and the accent caret takes over as
 * the focus signal. ``writingFieldFocus`` is empty off web — Jest renders as
 * ``ios`` — so it is pinned here by identity; its web contents are asserted in
 * ``design/__tests__/writingFieldFocus.test.ts``.
 */
describe('JournalEntryScreen writing-field focus', () => {
  it.each([
    ['title', 'journal-title-input'],
    ['body', 'journal-body-input'],
  ])('gives the %s field no focus ring and an accent caret', (_field, testID) => {
    const input = renderScreen().getByTestId(testID);
    const style = Array.isArray(input.props.style) ? input.props.style : [input.props.style];
    expect(style).toContain(writingFieldFocus);
    expect(input.props.selectionColor).toBe(writingField.caret);
    expect(input.props.cursorColor).toBe(writingField.caret);
  });
});
/**
 * The live word count under the writing column. It counts the body only — the
 * prose the writer is producing — and stays silent on a blank page.
 */
describe('JournalEntryScreen word count', () => {
  it('says nothing before a word is written', () => {
    expect(renderScreen().getByTestId('journal-word-count').props.children).toBe('');
  });

  it('counts up live as the body is typed', () => {
    const { getByTestId } = renderScreen();
    fireEvent.changeText(getByTestId('journal-body-input'), 'I walked to the river');
    expect(getByTestId('journal-word-count').props.children).toBe('5 words');
  });

  it('uses the singular for a one-word page', () => {
    const { getByTestId } = renderScreen();
    fireEvent.changeText(getByTestId('journal-body-input'), 'willow');
    expect(getByTestId('journal-word-count').props.children).toBe('1 word');
  });

  it('counts the prose, not the punctuation between it', () => {
    const { getByTestId } = renderScreen();
    fireEvent.changeText(getByTestId('journal-body-input'), 'time—space  ***  \n  well-being');
    expect(getByTestId('journal-word-count').props.children).toBe('3 words');
  });

  it('leaves the title out of the count', () => {
    const { getByTestId } = renderScreen();
    fireEvent.changeText(getByTestId('journal-title-input'), 'A long title about rivers');
    fireEvent.changeText(getByTestId('journal-body-input'), 'willow');
    expect(getByTestId('journal-word-count').props.children).toBe('1 word');
  });
});
