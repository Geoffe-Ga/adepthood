/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

import type { JournalMessage, PromptDetail } from '../../../api';

const sampleMessages: JournalMessage[] = [
  {
    id: 2,
    message: 'Welcome to your journal.',
    sender: 'bot',
    user_id: 1,
    timestamp: '2026-01-15T10:31:00Z',
    is_stage_reflection: false,
    is_practice_note: false,
    is_habit_note: false,
    practice_session_id: null,
    user_practice_id: null,
  },
  {
    id: 1,
    message: 'My first reflection.',
    sender: 'user',
    user_id: 1,
    timestamp: '2026-01-15T10:30:00Z',
    is_stage_reflection: false,
    is_practice_note: false,
    is_habit_note: false,
    practice_session_id: null,
    user_practice_id: null,
  },
];

const samplePrompt: PromptDetail = {
  week_number: 3,
  question: 'What are you grateful for?',
  has_responded: false,
  response: null,
  timestamp: null,
};

const mockJournalList = (jest.fn() as any).mockResolvedValue({
  items: sampleMessages,
  total: 2,
  has_more: false,
});

const mockJournalCreate = (jest.fn() as any).mockImplementation((payload: { message: string }) =>
  Promise.resolve({
    id: 99,
    message: payload.message,
    sender: 'user',
    user_id: 1,
    timestamp: new Date().toISOString(),
    is_stage_reflection: false,
    is_practice_note: false,
    is_habit_note: false,
    practice_session_id: null,
    user_practice_id: null,
  }),
);

const mockPromptsCurrent = (jest.fn() as any).mockResolvedValue(samplePrompt);
const mockPromptsRespond = (jest.fn() as any).mockResolvedValue({
  ...samplePrompt,
  has_responded: true,
  response: samplePrompt.question,
});

jest.mock('../../../api', () => ({
  journal: {
    list: (...args: unknown[]) => mockJournalList(...args),
    create: (...args: unknown[]) => mockJournalCreate(...args),
    get: jest.fn() as any,
    delete: jest.fn() as any,
  },
  prompts: {
    current: (...args: unknown[]) => mockPromptsCurrent(...args),
    respond: (...args: unknown[]) => mockPromptsRespond(...args),
    history: jest.fn() as any,
  },
}));

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  return {
    SafeAreaView: ({ children }: { children: any }) =>
      React.createElement(React.Fragment, null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

// eslint-disable-next-line import/order
const { render, waitFor, fireEvent, act } = require('@testing-library/react-native');
const JournalScreen = require('../JournalScreen').default;

describe('JournalScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockJournalList.mockResolvedValue({
      items: sampleMessages,
      total: 2,
      has_more: false,
    });
    mockPromptsCurrent.mockResolvedValue(samplePrompt);
  });

  it('shows loading spinner initially', () => {
    // Don't resolve the API calls immediately
    mockJournalList.mockReturnValue(new Promise(() => {}));
    mockPromptsCurrent.mockReturnValue(new Promise(() => {}));

    const { getByTestId } = render(<JournalScreen />);
    expect(getByTestId('journal-loading')).toBeTruthy();
  });

  it('renders messages after loading', async () => {
    const { getByText } = render(<JournalScreen />);

    await waitFor(() => {
      expect(getByText('My first reflection.')).toBeTruthy();
      expect(getByText('Welcome to your journal.')).toBeTruthy();
    });
  });

  it('shows weekly prompt banner when prompt is available', async () => {
    const { getByTestId, getByText } = render(<JournalScreen />);

    await waitFor(() => {
      expect(getByTestId('weekly-prompt-banner')).toBeTruthy();
      expect(getByText('What are you grateful for?')).toBeTruthy();
    });
  });

  it('hides weekly prompt banner when prompt is already responded', async () => {
    mockPromptsCurrent.mockResolvedValue({ ...samplePrompt, has_responded: true });

    const { queryByTestId } = render(<JournalScreen />);

    await waitFor(() => {
      expect(queryByTestId('weekly-prompt-banner')).toBeNull();
    });
  });

  it('sends a message via the chat input', async () => {
    const { getByTestId, getByText } = render(<JournalScreen />);

    await waitFor(() => {
      expect(getByText('My first reflection.')).toBeTruthy();
    });

    const input = getByTestId('chat-input');

    await act(async () => {
      fireEvent.changeText(input, 'New message');
    });

    const sendBtn = getByTestId('send-button');

    await act(async () => {
      fireEvent.press(sendBtn);
    });

    expect(mockJournalCreate).toHaveBeenCalledWith({ message: 'New message' });
  });

  it('shows empty state when there are no messages', async () => {
    mockJournalList.mockResolvedValue({ items: [], total: 0, has_more: false });

    const { getByText } = render(<JournalScreen />);

    await waitFor(() => {
      expect(getByText('Your Journal Awaits')).toBeTruthy();
    });
  });

  it('calls journal.list with pagination params', async () => {
    render(<JournalScreen />);

    await waitFor(() => {
      expect(mockJournalList).toHaveBeenCalledWith({ limit: 50, offset: 0 });
    });
  });
});
