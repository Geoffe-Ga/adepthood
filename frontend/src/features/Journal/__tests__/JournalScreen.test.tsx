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
    is_stage_reflection: true,
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

const mockJournalCreate = (jest.fn() as any).mockImplementation(
  (payload: { message: string; is_stage_reflection?: boolean }) =>
    Promise.resolve({
      id: 99,
      message: payload.message,
      sender: 'user',
      user_id: 1,
      timestamp: new Date().toISOString(),
      is_stage_reflection: payload.is_stage_reflection ?? false,
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

const mockBotmasonChat = (jest.fn() as any).mockResolvedValue({
  response: 'BotMason responds wisely.',
  remaining_balance: 4,
  bot_entry_id: 100,
});

const mockBotmasonGetBalance = (jest.fn() as any).mockResolvedValue({ balance: 5 });

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
  botmason: {
    chat: (...args: unknown[]) => mockBotmasonChat(...args),
    getBalance: (...args: unknown[]) => mockBotmasonGetBalance(...args),
    addBalance: jest.fn() as any,
  },
  ApiError: class ApiError extends Error {
    status: number;
    detail: string;
    constructor(status: number, detail: string) {
      super(`Request failed with status ${status}: ${detail}`);
      this.name = 'ApiError';
      this.status = status;
      this.detail = detail;
    }
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
    mockBotmasonGetBalance.mockResolvedValue({ balance: 5 });
    mockBotmasonChat.mockResolvedValue({
      response: 'BotMason responds wisely.',
      remaining_balance: 4,
      bot_entry_id: 100,
    });
  });

  it('shows loading spinner initially', () => {
    // Don't resolve the API calls immediately
    mockJournalList.mockReturnValue(new Promise(() => {}));
    mockPromptsCurrent.mockReturnValue(new Promise(() => {}));
    mockBotmasonGetBalance.mockReturnValue(new Promise(() => {}));

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

  it('sends a message via BotMason chat when balance > 0', async () => {
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

    expect(mockBotmasonChat).toHaveBeenCalledWith({ message: 'New message' });
  });

  it('sends freeform journal when balance is 0', async () => {
    mockBotmasonGetBalance.mockResolvedValue({ balance: 0 });

    const { getByTestId, getByText } = render(<JournalScreen />);

    await waitFor(() => {
      expect(getByText('My first reflection.')).toBeTruthy();
    });

    const input = getByTestId('chat-input');

    await act(async () => {
      fireEvent.changeText(input, 'Freeform thought');
    });

    const sendBtn = getByTestId('send-button');

    await act(async () => {
      fireEvent.press(sendBtn);
    });

    expect(mockJournalCreate).toHaveBeenCalledWith({ message: 'Freeform thought' });
    expect(mockBotmasonChat).not.toHaveBeenCalled();
  });

  it('sends a message with tags when tags are selected', async () => {
    mockBotmasonGetBalance.mockResolvedValue({ balance: 0 });
    const { getByTestId, getByText } = render(<JournalScreen />);

    await waitFor(() => {
      expect(getByText('My first reflection.')).toBeTruthy();
    });

    // Open tag picker and select reflection tag
    await act(async () => {
      fireEvent.press(getByTestId('tag-toggle'));
    });

    await act(async () => {
      fireEvent.press(getByTestId('tag-option-is_stage_reflection'));
    });

    const input = getByTestId('chat-input');
    await act(async () => {
      fireEvent.changeText(input, 'Tagged message');
    });

    await act(async () => {
      fireEvent.press(getByTestId('send-button'));
    });

    expect(mockJournalCreate).toHaveBeenCalledWith({
      message: 'Tagged message',
      is_stage_reflection: true,
      is_practice_note: false,
      is_habit_note: false,
    });
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

  it('shows balance counter when balance > 0', async () => {
    mockBotmasonGetBalance.mockResolvedValue({ balance: 10 });

    const { getByTestId } = render(<JournalScreen />);

    await waitFor(() => {
      expect(getByTestId('balance-counter')).toBeTruthy();
    });
  });

  it('shows "BotMason is resting" banner when balance is 0', async () => {
    mockBotmasonGetBalance.mockResolvedValue({ balance: 0 });

    const { getByTestId, getByText } = render(<JournalScreen />);

    await waitFor(() => {
      expect(getByTestId('balance-empty-banner')).toBeTruthy();
      expect(
        getByText('BotMason is resting. You can still write freeform reflections.'),
      ).toBeTruthy();
    });
  });

  it('does not show balance banner when balance is positive', async () => {
    mockBotmasonGetBalance.mockResolvedValue({ balance: 5 });

    const { queryByTestId } = render(<JournalScreen />);

    await waitFor(() => {
      expect(queryByTestId('balance-empty-banner')).toBeNull();
    });
  });

  it('fetches balance on mount', async () => {
    render(<JournalScreen />);

    await waitFor(() => {
      expect(mockBotmasonGetBalance).toHaveBeenCalled();
    });
  });

  it('renders search bar and tag filter', async () => {
    const { getByTestId, getByText } = render(<JournalScreen />);

    await waitFor(() => {
      expect(getByTestId('search-toggle')).toBeTruthy();
      expect(getByText('All')).toBeTruthy();
      expect(getByText('Reflections')).toBeTruthy();
    });
  });

  it('filters messages by tag when tag chip is pressed', async () => {
    const { getByText } = render(<JournalScreen />);

    await waitFor(() => {
      expect(getByText('My first reflection.')).toBeTruthy();
    });

    mockJournalList.mockResolvedValue({
      items: [sampleMessages[1]],
      total: 1,
      has_more: false,
    });

    await act(async () => {
      fireEvent.press(getByText('Reflections'));
    });

    await waitFor(() => {
      expect(mockJournalList).toHaveBeenCalledWith(
        expect.objectContaining({ tag: 'stage_reflection' }),
      );
    });
  });

  it('searches messages when search query is entered', async () => {
    jest.useFakeTimers();

    const { getByTestId, getByText } = render(<JournalScreen />);

    await waitFor(() => {
      expect(getByText('My first reflection.')).toBeTruthy();
    });

    // Open search bar
    await act(async () => {
      fireEvent.press(getByTestId('search-toggle'));
    });

    mockJournalList.mockResolvedValue({
      items: [sampleMessages[0]],
      total: 1,
      has_more: false,
    });

    const searchInput = getByTestId('search-input');
    await act(async () => {
      fireEvent.changeText(searchInput, 'Welcome');
    });

    // Advance past debounce
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    await waitFor(() => {
      expect(mockJournalList).toHaveBeenCalledWith(expect.objectContaining({ search: 'Welcome' }));
    });

    jest.useRealTimers();
  });
});
