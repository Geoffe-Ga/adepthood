/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { JournalListResponse, JournalMessage, PromptDetail } from '@/api';

const mockList = jest.fn() as jest.MockedFunction<
  (_p?: { search?: string; limit?: number; offset?: number }) => Promise<JournalListResponse>
>;
const mockDelete = jest.fn() as jest.MockedFunction<(_id: number) => Promise<void>>;
const mockPromptCurrent = jest.fn() as jest.MockedFunction<() => Promise<PromptDetail>>;
const mockNavigate = jest.fn();

jest.mock('@/api', () => ({
  journal: {
    list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
    delete: (...a: unknown[]) => (mockDelete as unknown as (...x: unknown[]) => unknown)(...a),
  },
  prompts: {
    current: (...a: unknown[]) =>
      (mockPromptCurrent as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

jest.mock('@react-navigation/native', () => {
  const react = jest.requireActual('react') as {
    useEffect: (_cb: () => undefined | (() => void), _deps: unknown[]) => void;
  };
  return {
    useNavigation: () => ({ navigate: mockNavigate, setOptions: jest.fn() }),
    useFocusEffect: (cb: () => undefined | (() => void)) => react.useEffect(cb, []),
  };
});

jest.mock('../SearchBar', () => {
  const { TextInput, View } = require('react-native');
  const Stub = ({ onSearch }: { onSearch: (_q: string) => void }) => (
    <View>
      <TextInput testID="shelf-search" onChangeText={onSearch} />
    </View>
  );
  return { __esModule: true, default: Stub };
});

jest.mock('../StatTileRow', () => {
  const { View } = require('react-native');
  const Stub = () => <View testID="stat-tile-row-stub" />;
  return { __esModule: true, default: Stub };
});
jest.mock('@/features/Return/ReturnStack', () => {
  const { View } = require('react-native');
  const Stub = () => <View testID="return-stack-stub" />;
  return { __esModule: true, default: Stub };
});
jest.mock('@/features/Invitations/InvitationStack', () => {
  const { View } = require('react-native');
  const Stub = () => <View testID="invitation-stack-stub" />;
  return { __esModule: true, default: Stub };
});
jest.mock('../MorningPagesTip', () => {
  const { View } = require('react-native');
  const Stub = () => <View testID="morning-pages-tip-stub" />;
  return { __esModule: true, default: Stub };
});

const JournalShelfScreen = require('../JournalShelfScreen').default;

function entry(id: number, overrides: Partial<JournalMessage> = {}): JournalMessage {
  return {
    id,
    message: `Body of entry ${id}.`,
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'reflection' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: `Entry ${id}`,
    status: 'finished',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function page(items: JournalMessage[]): JournalListResponse {
  return { items, total: items.length, has_more: false };
}

beforeEach(() => {
  mockList.mockReset();
  mockDelete.mockReset();
  mockNavigate.mockReset();
  mockPromptCurrent.mockReset();
  mockList.mockResolvedValue(page([entry(2), entry(1)]));
  mockDelete.mockResolvedValue(undefined);
  mockPromptCurrent.mockResolvedValue({
    week_number: 3,
    question: 'What did you notice this week?',
    has_responded: true,
    response: null,
    timestamp: null,
  });
});

/** Render the shelf and press the delete affordance on entry 2. */
async function shelfWithDeleteRequested() {
  const utils = render(<JournalShelfScreen />);
  await utils.findByTestId('journal-shelf-card-2');
  await act(async () => {
    fireEvent.press(utils.getByTestId('journal-shelf-delete-2'));
  });
  return utils;
}

describe('deleting one journal entry from the shelf', () => {
  it('asks first — the page is still on the shelf and nothing has reached the server', async () => {
    const { getByTestId } = await shelfWithDeleteRequested();

    expect(getByTestId('journal-delete-dialog')).toBeTruthy();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(getByTestId('journal-shelf-card-2')).toBeTruthy();
  });

  it('says the page goes from the app and that its corpus copy goes with it', async () => {
    const { getByTestId } = await shelfWithDeleteRequested();

    const body = getByTestId('journal-delete-dialog-body').props.children as string;
    // Recoverable server-side, but the app offers no restore: say only what is true here.
    expect(body).toMatch(/no way back to it from inside the app/i);
    // The withdrawal from the ontologized corpus is a promise about where the writing goes.
    expect(body).toMatch(/reflections draw on/i);
    // Never scold somebody for unwriting their own page.
    expect(body).not.toMatch(/permanent|forever|warning|sure\?/i);
  });

  it('leaves the page exactly where it was when the ask is declined', async () => {
    const { getByTestId, queryByTestId } = await shelfWithDeleteRequested();

    await act(async () => {
      fireEvent.press(getByTestId('journal-delete-cancel'));
    });

    expect(queryByTestId('journal-delete-dialog')).toBeNull();
    expect(getByTestId('journal-shelf-card-2')).toBeTruthy();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('deletes the confirmed page by its own id and drops only that row', async () => {
    const { getByTestId, queryByTestId } = await shelfWithDeleteRequested();

    await act(async () => {
      fireEvent.press(getByTestId('journal-delete-confirm'));
    });

    expect(mockDelete).toHaveBeenCalledWith(2);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(queryByTestId('journal-shelf-card-2')).toBeNull());
    expect(getByTestId('journal-shelf-card-1')).toBeTruthy();
  });

  it('puts the page back and says so when the server refuses', async () => {
    mockDelete.mockRejectedValue(new Error('network down'));
    const { getByTestId, findByTestId } = await shelfWithDeleteRequested();

    await act(async () => {
      fireEvent.press(getByTestId('journal-delete-confirm'));
    });

    const notice = await findByTestId('journal-delete-error');
    expect(notice.props.children).toMatch(/still on your shelf/i);
    expect(getByTestId('journal-shelf-card-2')).toBeTruthy();
  });
});
