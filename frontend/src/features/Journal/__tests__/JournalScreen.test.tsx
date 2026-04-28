/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

import type { JournalMessage, PromptDetail } from '../../../api';

const sampleMessages: JournalMessage[] = [
  {
    id: 2,
    message: 'Welcome to your journal.',
    sender: 'bot',
    timestamp: '2026-01-15T10:31:00Z',
    tag: 'freeform',
    practice_session_id: null,
    user_practice_id: null,
  },
  {
    id: 1,
    message: 'My first reflection.',
    sender: 'user',
    timestamp: '2026-01-15T10:30:00Z',
    tag: 'stage_reflection',
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
  (payload: { message: string; tag?: string }) =>
    Promise.resolve({
      id: 99,
      message: payload.message,
      sender: 'user',
      timestamp: new Date().toISOString(),
      tag: payload.tag ?? 'freeform',
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
  remaining_balance: 5,
  remaining_messages: 49,
  monthly_reset_date: '2026-05-01T00:00:00Z',
  bot_entry_id: 100,
});

// Default stream mock emits two chunks and a complete event — enough to
// verify progressive rendering and final state update without any real
// network I/O. Individual tests override via ``mockImplementationOnce``.
interface StreamCallbacks {
  onChunk: (_t: string) => void;
  onComplete: (_r: unknown) => void;
  onStreamError: (_e: { status: number; detail: string }) => void;
}
const defaultStreamImpl = async (
  _payload: { message: string },
  callbacks: StreamCallbacks,
): Promise<void> => {
  callbacks.onChunk('BotMason ');
  callbacks.onChunk('responds wisely.');
  callbacks.onComplete({
    response: 'BotMason responds wisely.',
    remaining_balance: 5,
    remaining_messages: 49,
    monthly_reset_date: '2026-05-01T00:00:00Z',
    bot_entry_id: 100,
  });
};
const mockBotmasonChatStream = (jest.fn() as any).mockImplementation(defaultStreamImpl);

const mockBotmasonGetBalance = (jest.fn() as any).mockResolvedValue({ balance: 5 });
const mockBotmasonGetUsage = (jest.fn() as any).mockResolvedValue({
  monthly_messages_used: 0,
  monthly_messages_remaining: 50,
  monthly_cap: 50,
  monthly_reset_date: '2026-05-01T00:00:00Z',
  offering_balance: 5,
});

class MockApiError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(`Request failed with status ${status}: ${detail}`);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

class MockStreamingUnsupportedError extends Error {
  constructor() {
    super('streaming_unsupported');
    this.name = 'StreamingUnsupportedError';
  }
}

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
    chatStream: (...args: unknown[]) => mockBotmasonChatStream(...args),
    getBalance: (...args: unknown[]) => mockBotmasonGetBalance(...args),
    getUsage: (...args: unknown[]) => mockBotmasonGetUsage(...args),
    addBalance: jest.fn() as any,
  },
  ApiError: MockApiError,
  StreamingUnsupportedError: MockStreamingUnsupportedError,
}));

let mockRouteParams: Record<string, unknown> | undefined;
jest.mock('../../../navigation/hooks', () => ({
  useAppRoute: () => ({ key: 'Journal-test', name: 'Journal', params: mockRouteParams }),
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

const renderJournal = (params?: Record<string, unknown>) => {
  mockRouteParams = params;
  return render(<JournalScreen />);
};

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
    mockBotmasonGetUsage.mockResolvedValue({
      monthly_messages_used: 0,
      monthly_messages_remaining: 50,
      monthly_cap: 50,
      monthly_reset_date: '2026-05-01T00:00:00Z',
      offering_balance: 5,
    });
    mockBotmasonChat.mockResolvedValue({
      response: 'BotMason responds wisely.',
      remaining_balance: 5,
      remaining_messages: 49,
      monthly_reset_date: '2026-05-01T00:00:00Z',
      bot_entry_id: 100,
    });
    mockBotmasonChatStream.mockImplementation(defaultStreamImpl);
  });

  it('shows loading spinner initially', () => {
    // Don't resolve the API calls immediately
    mockJournalList.mockReturnValue(new Promise(() => {}));
    mockPromptsCurrent.mockReturnValue(new Promise(() => {}));
    mockBotmasonGetUsage.mockReturnValue(new Promise(() => {}));

    const { getByTestId } = renderJournal();
    expect(getByTestId('journal-loading')).toBeTruthy();
  });

  it('renders messages after loading', async () => {
    const { getByText } = renderJournal();

    await waitFor(() => {
      expect(getByText('My first reflection.')).toBeTruthy();
      expect(getByText('Welcome to your journal.')).toBeTruthy();
    });
  });

  it('shows weekly prompt banner when prompt is available', async () => {
    const { getByTestId, getByText } = renderJournal();

    await waitFor(() => {
      expect(getByTestId('weekly-prompt-banner')).toBeTruthy();
      expect(getByText('What are you grateful for?')).toBeTruthy();
    });
  });

  it('hides weekly prompt banner when prompt is already responded', async () => {
    mockPromptsCurrent.mockResolvedValue({ ...samplePrompt, has_responded: true });

    const { queryByTestId } = renderJournal();

    await waitFor(() => {
      expect(queryByTestId('weekly-prompt-banner')).toBeNull();
    });
  });

  it('sends a message via BotMason chatStream when balance > 0', async () => {
    const { getByTestId, getByText } = renderJournal();

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

    // Streaming is the default transport; the legacy ``chat()`` is reserved
    // for the StreamingUnsupportedError fallback which this test doesn't hit.
    expect(mockBotmasonChatStream).toHaveBeenCalledWith(
      { message: 'New message' },
      expect.objectContaining({
        onChunk: expect.any(Function),
        onComplete: expect.any(Function),
        onStreamError: expect.any(Function),
      }),
    );
    expect(mockBotmasonChat).not.toHaveBeenCalled();
  });

  it('sends freeform journal when both wallets are empty', async () => {
    mockBotmasonGetUsage.mockResolvedValue({
      monthly_messages_used: 50,
      monthly_messages_remaining: 0,
      monthly_cap: 50,
      monthly_reset_date: '2026-05-01T00:00:00Z',
      offering_balance: 0,
    });

    const { getByTestId, getByText } = renderJournal();

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

    expect(mockJournalCreate).toHaveBeenCalledWith({
      message: 'Freeform thought',
      tag: 'freeform',
      practice_session_id: null,
      user_practice_id: null,
    });
    expect(mockBotmasonChat).not.toHaveBeenCalled();
  });

  it('sends a message with tag when a tag is selected', async () => {
    mockBotmasonGetUsage.mockResolvedValue({
      monthly_messages_used: 50,
      monthly_messages_remaining: 0,
      monthly_cap: 50,
      monthly_reset_date: '2026-05-01T00:00:00Z',
      offering_balance: 0,
    });
    const { getByTestId, getByText } = renderJournal();

    await waitFor(() => {
      expect(getByText('My first reflection.')).toBeTruthy();
    });

    // Open tag picker and select reflection tag
    await act(async () => {
      fireEvent.press(getByTestId('tag-toggle'));
    });

    await act(async () => {
      fireEvent.press(getByTestId('tag-option-stage_reflection'));
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
      tag: 'stage_reflection',
      practice_session_id: null,
      user_practice_id: null,
    });
  });

  it('shows empty state when there are no messages', async () => {
    mockJournalList.mockResolvedValue({ items: [], total: 0, has_more: false });

    const { getByText } = renderJournal();

    await waitFor(() => {
      expect(getByText('Your Journal Awaits')).toBeTruthy();
    });
  });

  it('calls journal.list with pagination params', async () => {
    renderJournal();

    await waitFor(() => {
      expect(mockJournalList).toHaveBeenCalledWith({ limit: 50, offset: 0 });
    });
  });

  it('shows counter when free monthly messages remain', async () => {
    mockBotmasonGetUsage.mockResolvedValue({
      monthly_messages_used: 0,
      monthly_messages_remaining: 42,
      monthly_cap: 50,
      monthly_reset_date: '2026-05-01T00:00:00Z',
      offering_balance: 10,
    });

    const { getByTestId, getByText } = renderJournal();

    await waitFor(() => {
      expect(getByTestId('balance-counter')).toBeTruthy();
      expect(getByText(/42 free BotMason messages left this month/)).toBeTruthy();
    });
  });

  it('shows "cap reached" counter when free tier is spent but offerings remain', async () => {
    mockBotmasonGetUsage.mockResolvedValue({
      monthly_messages_used: 50,
      monthly_messages_remaining: 0,
      monthly_cap: 50,
      monthly_reset_date: '2026-05-01T00:00:00Z',
      offering_balance: 4,
    });

    const { getByTestId, getByText } = renderJournal();

    await waitFor(() => {
      expect(getByTestId('balance-counter')).toBeTruthy();
      expect(getByText(/Monthly cap reached/)).toBeTruthy();
      expect(getByText(/4 offerings available/)).toBeTruthy();
    });
  });

  it('shows "BotMason is resting" banner when both wallets are empty', async () => {
    mockBotmasonGetUsage.mockResolvedValue({
      monthly_messages_used: 50,
      monthly_messages_remaining: 0,
      monthly_cap: 50,
      monthly_reset_date: '2026-05-01T00:00:00Z',
      offering_balance: 0,
    });

    const { getByTestId, getByText } = renderJournal();

    await waitFor(() => {
      expect(getByTestId('balance-empty-banner')).toBeTruthy();
      expect(getByText(/BotMason is resting until the cap resets/)).toBeTruthy();
    });
  });

  it('does not show empty banner while free messages remain', async () => {
    mockBotmasonGetUsage.mockResolvedValue({
      monthly_messages_used: 0,
      monthly_messages_remaining: 50,
      monthly_cap: 50,
      monthly_reset_date: '2026-05-01T00:00:00Z',
      offering_balance: 5,
    });

    const { queryByTestId } = renderJournal();

    await waitFor(() => {
      expect(queryByTestId('balance-empty-banner')).toBeNull();
    });
  });

  it('fetches usage on mount', async () => {
    renderJournal();

    await waitFor(() => {
      expect(mockBotmasonGetUsage).toHaveBeenCalled();
    });
  });

  it('renders search bar and tag filter', async () => {
    const { getByTestId, getByText } = renderJournal();

    await waitFor(() => {
      expect(getByTestId('search-toggle')).toBeTruthy();
      expect(getByText('All')).toBeTruthy();
      expect(getByText('Reflections')).toBeTruthy();
    });
  });

  it('filters messages by tag when tag chip is pressed', async () => {
    const { getByText } = renderJournal();

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

    const { getByTestId, getByText } = renderJournal();

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

  it('shows practice reflection header when practiceSessionId is passed', async () => {
    const { getByTestId, getByText } = renderJournal({
      tag: 'practice_note',
      practiceSessionId: 42,
      userPracticeId: 10,
      practiceName: 'Breath Awareness',
      practiceDuration: 10,
    });

    await waitFor(() => {
      expect(getByTestId('practice-reflection-header')).toBeTruthy();
      expect(getByText(/Reflection on Breath Awareness/)).toBeTruthy();
      expect(getByText(/10 minutes/)).toBeTruthy();
    });
  });

  it('does not show practice reflection header without practice params', async () => {
    const { queryByTestId } = renderJournal();

    await waitFor(() => {
      expect(queryByTestId('practice-reflection-header')).toBeNull();
    });
  });

  it('shows course reflection header when tag is stage_reflection with content', async () => {
    const { getByTestId, getByText } = renderJournal({
      tag: 'stage_reflection',
      stageNumber: 3,
      contentTitle: 'The Hero Journey',
    });

    await waitFor(() => {
      expect(getByTestId('course-reflection-header')).toBeTruthy();
      expect(getByText(/Reflecting on: The Hero Journey/)).toBeTruthy();
      expect(getByText(/Stage 3/)).toBeTruthy();
    });
  });

  it('does not show course reflection header without tag param', async () => {
    const { queryByTestId } = renderJournal();

    await waitFor(() => {
      expect(queryByTestId('course-reflection-header')).toBeNull();
    });
  });

  it('sends journal entry with stage_reflection tag when in course reflection mode', async () => {
    mockBotmasonGetUsage.mockResolvedValue({
      monthly_messages_used: 50,
      monthly_messages_remaining: 0,
      monthly_cap: 50,
      monthly_reset_date: '2026-05-01T00:00:00Z',
      offering_balance: 0,
    });

    const { getByTestId, getByText } = renderJournal({
      tag: 'stage_reflection',
      stageNumber: 3,
      contentTitle: 'The Hero Journey',
    });

    await waitFor(() => {
      expect(getByText('My first reflection.')).toBeTruthy();
    });

    const input = getByTestId('chat-input');
    await act(async () => {
      fireEvent.changeText(input, 'This essay changed my perspective');
    });

    await act(async () => {
      fireEvent.press(getByTestId('send-button'));
    });

    expect(mockJournalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'This essay changed my perspective',
        tag: 'stage_reflection',
      }),
    );
  });

  it('sends journal entry with practice session data when in reflection mode', async () => {
    mockBotmasonGetUsage.mockResolvedValue({
      monthly_messages_used: 50,
      monthly_messages_remaining: 0,
      monthly_cap: 50,
      monthly_reset_date: '2026-05-01T00:00:00Z',
      offering_balance: 0,
    });

    const { getByTestId, getByText } = renderJournal({
      tag: 'practice_note',
      practiceSessionId: 42,
      userPracticeId: 10,
      practiceName: 'Breath Awareness',
      practiceDuration: 10,
    });

    await waitFor(() => {
      expect(getByText('My first reflection.')).toBeTruthy();
    });

    const input = getByTestId('chat-input');
    await act(async () => {
      fireEvent.changeText(input, 'Great session');
    });

    await act(async () => {
      fireEvent.press(getByTestId('send-button'));
    });

    expect(mockJournalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Great session',
        tag: 'practice_note',
        practice_session_id: 42,
        user_practice_id: 10,
      }),
    );
  });

  // ── Streaming (issue #188) ───────────────────────────────────────────

  // Wires up a chatStream mock whose promise resolves only when
  // ``onComplete`` or ``onStreamError`` fires. This lets tests drive the
  // streaming state machine step by step while still letting the
  // production code ``await`` the stream to completion naturally.
  function installControlledStreamMock(): {
    chunk: (_t: string) => Promise<void>;
    complete: (_r: unknown) => Promise<void>;
  } {
    let onChunk: ((_t: string) => void) | null = null;
    let onComplete: ((_r: unknown) => void) | null = null;
    let resolveStream: () => void = () => {};
    const streamDone = new Promise<void>((r) => {
      resolveStream = r;
    });
    mockBotmasonChatStream.mockImplementation(
      async (_payload: unknown, callbacks: StreamCallbacks) => {
        onChunk = callbacks.onChunk;
        onComplete = (result: unknown) => {
          callbacks.onComplete(result);
          resolveStream();
        };
        await streamDone;
      },
    );
    return {
      chunk: async (text: string) => {
        await act(async () => {
          onChunk?.(text);
        });
      },
      complete: async (result: unknown) => {
        await act(async () => {
          onComplete?.(result);
        });
      },
    };
  }

  it('progressively renders streamed bot chunks as they arrive', async () => {
    const stream = installControlledStreamMock();
    const { getByTestId, getByText, queryByTestId } = renderJournal();
    await waitFor(() => {
      expect(getByText('My first reflection.')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.changeText(getByTestId('chat-input'), 'How do I meditate?');
    });
    await act(async () => {
      fireEvent.press(getByTestId('send-button'));
    });

    // First chunk: streaming bubble appears with partial text + cursor.
    await stream.chunk('The first ');
    expect(getByTestId('streaming-bubble-text')).toBeTruthy();
    expect(getByText(/The first/)).toBeTruthy();

    await stream.chunk('step is to breathe.');
    expect(getByText(/The first step is to breathe\./)).toBeTruthy();

    // ``complete`` finalises the bot message — the streaming cursor goes away.
    await stream.complete({
      response: 'The first step is to breathe.',
      remaining_balance: 4,
      remaining_messages: 48,
      monthly_reset_date: '2026-05-01T00:00:00Z',
      bot_entry_id: 321,
    });

    await waitFor(() => {
      expect(queryByTestId('streaming-bubble-text')).toBeNull();
    });
    expect(getByText('The first step is to breathe.')).toBeTruthy();
  });

  it('shows typing indicator until the first chunk arrives', async () => {
    const stream = installControlledStreamMock();
    const { getByTestId, getByText, queryByTestId } = renderJournal();
    await waitFor(() => {
      expect(getByText('My first reflection.')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.changeText(getByTestId('chat-input'), 'hi');
    });
    await act(async () => {
      fireEvent.press(getByTestId('send-button'));
    });

    // Indicator is visible before any chunk lands.
    expect(getByTestId('typing-indicator')).toBeTruthy();

    // First chunk hides the indicator — the bubble itself signals progress.
    await stream.chunk('Hello');
    expect(queryByTestId('typing-indicator')).toBeNull();

    await stream.complete({
      response: 'Hello',
      remaining_balance: 4,
      remaining_messages: 48,
      monthly_reset_date: '2026-05-01T00:00:00Z',
      bot_entry_id: 9,
    });
  });

  it('shows retry button when the server emits a mid-stream error event', async () => {
    mockBotmasonChatStream.mockImplementationOnce(
      async (_payload: unknown, callbacks: StreamCallbacks) => {
        callbacks.onStreamError({ status: 502, detail: 'llm_provider_error' });
      },
    );

    const { getByTestId, getByText } = renderJournal();
    await waitFor(() => {
      expect(getByText('My first reflection.')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.changeText(getByTestId('chat-input'), 'Hi');
    });
    await act(async () => {
      fireEvent.press(getByTestId('send-button'));
    });

    await waitFor(() => {
      expect(getByTestId('message-error')).toBeTruthy();
    });
    expect(getByText(/having trouble connecting/)).toBeTruthy();
    expect(getByTestId('message-retry')).toBeTruthy();
  });

  it('shows "add your API key" error when provider requires a key', async () => {
    mockBotmasonChatStream.mockImplementationOnce(async () => {
      throw new MockApiError(402, 'llm_key_required');
    });

    const { getByTestId, getByText } = renderJournal();
    await waitFor(() => {
      expect(getByText('My first reflection.')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.changeText(getByTestId('chat-input'), 'Hi');
    });
    await act(async () => {
      fireEvent.press(getByTestId('send-button'));
    });

    await waitFor(() => {
      expect(getByText(/Add your API key in Settings/)).toBeTruthy();
    });
  });

  it('shows rate-limit error when server returns 429', async () => {
    mockBotmasonChatStream.mockImplementationOnce(async () => {
      throw new MockApiError(429, 'rate_limit_exceeded');
    });

    const { getByTestId, getByText } = renderJournal();
    await waitFor(() => {
      expect(getByText('My first reflection.')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.changeText(getByTestId('chat-input'), 'Hi');
    });
    await act(async () => {
      fireEvent.press(getByTestId('send-button'));
    });

    await waitFor(() => {
      expect(getByText(/Slow down/)).toBeTruthy();
    });
  });

  it('shows offline error on network failure', async () => {
    mockBotmasonChatStream.mockImplementationOnce(async () => {
      throw new TypeError('Network request failed');
    });

    const { getByTestId, getByText } = renderJournal();
    await waitFor(() => {
      expect(getByText('My first reflection.')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.changeText(getByTestId('chat-input'), 'Hi');
    });
    await act(async () => {
      fireEvent.press(getByTestId('send-button'));
    });

    await waitFor(() => {
      expect(getByText(/offline/i)).toBeTruthy();
    });
  });

  it('retries a failed message without creating a duplicate user entry', async () => {
    // First attempt: provider error. Second attempt: success.
    mockBotmasonChatStream.mockImplementationOnce(
      async (_payload: unknown, callbacks: StreamCallbacks) => {
        callbacks.onStreamError({ status: 502, detail: 'llm_provider_error' });
      },
    );
    mockBotmasonChatStream.mockImplementationOnce(defaultStreamImpl);

    const { getByTestId, getByText, queryByTestId, queryAllByText } = renderJournal();
    await waitFor(() => {
      expect(getByText('My first reflection.')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.changeText(getByTestId('chat-input'), 'Single message');
    });
    await act(async () => {
      fireEvent.press(getByTestId('send-button'));
    });

    // Failure state appears.
    await waitFor(() => {
      expect(getByTestId('message-retry')).toBeTruthy();
    });

    // Retry — the errored user message becomes healthy again, stream completes.
    await act(async () => {
      fireEvent.press(getByTestId('message-retry'));
    });

    await waitFor(() => {
      expect(queryByTestId('message-retry')).toBeNull();
      expect(getByText('BotMason responds wisely.')).toBeTruthy();
    });

    // No duplicate user message — the original optimistic entry stayed in
    // place across the retry; the list should contain exactly one "Single
    // message" text node.
    expect(queryAllByText('Single message')).toHaveLength(1);
    expect(mockBotmasonChatStream).toHaveBeenCalledTimes(2);
  });

  it('falls back to non-streaming chat when StreamingUnsupportedError is thrown', async () => {
    mockBotmasonChatStream.mockImplementationOnce(async () => {
      throw new MockStreamingUnsupportedError();
    });

    const { getByTestId, getByText } = renderJournal();
    await waitFor(() => {
      expect(getByText('My first reflection.')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.changeText(getByTestId('chat-input'), 'Graceful degradation');
    });
    await act(async () => {
      fireEvent.press(getByTestId('send-button'));
    });

    await waitFor(() => {
      expect(mockBotmasonChat).toHaveBeenCalledWith({ message: 'Graceful degradation' });
    });
    // The server's final reply lands in the list even though streaming was
    // unavailable — the user doesn't need to notice the transport swap.
    await waitFor(() => {
      expect(getByText('BotMason responds wisely.')).toBeTruthy();
    });
  });

  it('falls through to freeform when streaming endpoint returns 402', async () => {
    mockBotmasonChatStream.mockImplementationOnce(async () => {
      throw new MockApiError(402, 'insufficient_offerings');
    });

    const { getByTestId, getByText } = renderJournal();
    await waitFor(() => {
      expect(getByText('My first reflection.')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.changeText(getByTestId('chat-input'), 'Out of credit');
    });
    await act(async () => {
      fireEvent.press(getByTestId('send-button'));
    });

    await waitFor(() => {
      expect(mockJournalCreate).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Out of credit' }),
      );
    });
  });

  it('persists the user message via journal API when the bot stream throws (BUG-FE-JOURNAL-002)', async () => {
    // Reset call count specifically for this assertion — sample data load
    // would otherwise inflate the number.
    mockJournalCreate.mockClear();
    mockBotmasonChatStream.mockImplementationOnce(async () => {
      throw new TypeError('Network request failed');
    });

    const { getByTestId, getByText } = renderJournal();
    await waitFor(() => {
      expect(getByText('My first reflection.')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.changeText(getByTestId('chat-input'), 'Save my words');
    });
    await act(async () => {
      fireEvent.press(getByTestId('send-button'));
    });

    // Inline retry UX still surfaces — user can re-send for a bot reply.
    await waitFor(() => {
      expect(getByTestId('message-retry')).toBeTruthy();
    });

    // The user's text was also POSTed to the journal so a reload won't
    // lose it. Before this fix, journalApi.create was never called on
    // the synchronous-throw path and the user's words vanished.
    await waitFor(() => {
      expect(mockJournalCreate).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Save my words' }),
      );
    });
  });
});
