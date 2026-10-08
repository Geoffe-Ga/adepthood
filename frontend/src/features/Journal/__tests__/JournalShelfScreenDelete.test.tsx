/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { erasureReceiptNotice } from '../deleteEntryCopy';

import type {
  JournalErasureReceipt,
  JournalListResponse,
  JournalMessage,
  PromptDetail,
} from '@/api';

const mockList = jest.fn() as jest.MockedFunction<
  (_p?: { search?: string; limit?: number; offset?: number }) => Promise<JournalListResponse>
>;
const mockDelete = jest.fn() as jest.MockedFunction<(_id: number) => Promise<void>>;
const mockEraseLocally = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<JournalErasureReceipt>
>;
const mockPromptCurrent = jest.fn() as jest.MockedFunction<() => Promise<PromptDetail>>;
const mockNavigate = jest.fn();

jest.mock('@/api', () => ({
  // The shelf's primary invitation asks what review is due; answer "none" so
  // the daily-page fallback runs through a real resolved null, not a caught
  // TypeError from a client this mock forgot.
  reflections: {
    due: jest.fn(() => Promise.resolve({ due: null })),
    current: jest.fn(() => Promise.resolve({ scopes: [] })),
  },
  journal: {
    list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
    delete: (...a: unknown[]) => (mockDelete as unknown as (...x: unknown[]) => unknown)(...a),
    eraseLocally: (...a: unknown[]) =>
      (mockEraseLocally as unknown as (...x: unknown[]) => unknown)(...a),
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
  mockEraseLocally.mockReset();
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
    expect(body).toMatch(/connected Creek vault.*removed/i);
    expect(body).toMatch(/offline.*shelf.*try again/i);
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

  it('says the deletion is set and finishes once Creek confirms — not that it failed', async () => {
    mockDelete.mockRejectedValue({ status: 503, detail: 'vault_withdrawal_pending' });
    const { getByTestId, findByTestId } = await shelfWithDeleteRequested();

    await act(async () => {
      fireEvent.press(getByTestId('journal-delete-confirm'));
    });

    // The server recorded the deletion and finishes it itself (#3098), so the
    // notice may not say it could not delete, nor ask for another delete.
    const notice = (await findByTestId('journal-delete-error')).props.children as string;
    expect(notice).toMatch(/set to be deleted/i);
    expect(notice).toMatch(/finishes once your Creek vault confirms its copy is gone/i);
    expect(notice).toMatch(/can't be edited/i);
    expect(notice).not.toMatch(/could not delete|delete this page again|still on your shelf/i);
    expect(getByTestId('journal-shelf-card-2')).toBeTruthy();
  });

  it('treats a retried delete the background already finished as done, not refused', async () => {
    mockDelete.mockRejectedValue({ status: 404, detail: 'journal_entry_not_found' });
    const { getByTestId, queryByTestId } = await shelfWithDeleteRequested();

    await act(async () => {
      fireEvent.press(getByTestId('journal-delete-confirm'));
    });

    await waitFor(() => expect(queryByTestId('journal-shelf-card-2')).toBeNull());
    expect(queryByTestId('journal-delete-error')).toBeNull();
    expect(queryByTestId('journal-unreachable-choice')).toBeNull();
  });
});

/** Confirm the delete of entry 2 and let the server refuse it with ``detail``. */
async function refusedWith(detail: string) {
  mockDelete.mockRejectedValue({ status: 503, detail });
  const utils = await shelfWithDeleteRequested();
  await act(async () => {
    fireEvent.press(utils.getByTestId('journal-delete-confirm'));
  });
  await utils.findByTestId('journal-unreachable-choice');
  return utils;
}

describe('a page whose vault copy cannot be confirmed gone (#3094)', () => {
  it('names the previous vault and offers reconnect first, then "I can\'t reach it"', async () => {
    const { getByTestId } = await refusedWith('vault_withdrawal_previous_vault');

    const notice = getByTestId('journal-delete-error').props.children as string;
    expect(notice).toMatch(/set to be deleted/i);
    expect(notice).toMatch(/vault you were connected to before/i);
    expect(notice).toMatch(/finishes once you reconnect that vault/i);
    expect(notice).not.toMatch(/could not delete/i);
    expect(getByTestId('journal-unreachable-reconnect')).toBeTruthy();
    expect(getByTestId('journal-unreachable-erase')).toBeTruthy();
    const explainer = getByTestId('journal-unreachable-explainer').props.children as string;
    expect(explainer).toMatch(/can't confirm/i);
    expect(explainer).toMatch(/delete it there yourself/i);
    expect(getByTestId('journal-shelf-card-2')).toBeTruthy();
    expect(mockEraseLocally).not.toHaveBeenCalled();
  });

  it('names the disconnected vault the same way', async () => {
    const { getByTestId } = await refusedWith('vault_withdrawal_disconnected_vault');

    const notice = getByTestId('journal-delete-error').props.children as string;
    expect(notice).toMatch(/vault you disconnected/i);
  });

  it('reconnect first opens vault settings and erases nothing', async () => {
    const { getByTestId, queryByTestId } = await refusedWith('vault_withdrawal_previous_vault');

    await act(async () => {
      fireEvent.press(getByTestId('journal-unreachable-reconnect'));
    });

    expect(mockNavigate).toHaveBeenCalledWith('VaultSettings');
    expect(queryByTestId('journal-unreachable-choice')).toBeNull();
    expect(mockEraseLocally).not.toHaveBeenCalled();
    expect(getByTestId('journal-shelf-card-2')).toBeTruthy();
  });

  it('"I can\'t reach it" deletes here only and says a copy may remain — never "withdrawn"', async () => {
    mockEraseLocally.mockResolvedValue({
      entry_id: 2,
      remote_copy: 'unconfirmed',
      copy_location: 'previous_vault',
    });
    const { getByTestId, queryByTestId, findByTestId } = await refusedWith(
      'vault_withdrawal_previous_vault',
    );

    await act(async () => {
      fireEvent.press(getByTestId('journal-unreachable-erase'));
    });

    expect(mockEraseLocally).toHaveBeenCalledWith(2);
    const receipt = (await findByTestId('journal-erasure-receipt')).props.children as string;
    expect(receipt).toMatch(/deleted from adepthood/i);
    expect(receipt).toMatch(/copy may still be in the Creek vault you were connected to before/i);
    expect(receipt).toMatch(/delete it there/i);
    expect(receipt).not.toMatch(/withdrawn|removed from your vault|is gone/i);
    await waitFor(() => expect(queryByTestId('journal-shelf-card-2')).toBeNull());
    expect(queryByTestId('journal-unreachable-choice')).toBeNull();
    expect(queryByTestId('journal-delete-error')).toBeNull();
  });

  it('says the vault copy is gone only when the receipt says the vault confirmed it', async () => {
    mockEraseLocally.mockResolvedValue({
      entry_id: 2,
      remote_copy: 'confirmed_absent',
      copy_location: null,
    });
    const { getByTestId, findByTestId } = await refusedWith('vault_withdrawal_pending');

    await act(async () => {
      fireEvent.press(getByTestId('journal-unreachable-erase'));
    });

    const receipt = (await findByTestId('journal-erasure-receipt')).props.children as string;
    expect(receipt).toMatch(/confirmed/i);
    expect(receipt).not.toMatch(/may still be/i);
  });

  it('puts the page back if deleting here only is refused too', async () => {
    mockEraseLocally.mockRejectedValue(new Error('network down'));
    const { getByTestId, findByTestId, queryByTestId } = await refusedWith(
      'vault_withdrawal_disconnected_vault',
    );

    await act(async () => {
      fireEvent.press(getByTestId('journal-unreachable-erase'));
    });

    const notice = await findByTestId('journal-delete-error');
    expect(notice.props.children).toMatch(/still on your shelf/i);
    expect(getByTestId('journal-shelf-card-2')).toBeTruthy();
    expect(queryByTestId('journal-erasure-receipt')).toBeNull();
  });

  it('treats "delete here only" after the background already finished as done', async () => {
    mockEraseLocally.mockRejectedValue({ status: 404, detail: 'journal_entry_not_found' });
    const { getByTestId, queryByTestId, findByTestId } = await refusedWith(
      'vault_withdrawal_previous_vault',
    );

    await act(async () => {
      fireEvent.press(getByTestId('journal-unreachable-erase'));
    });

    await waitFor(() => expect(queryByTestId('journal-shelf-card-2')).toBeNull());
    expect(queryByTestId('journal-delete-error')).toBeNull();
    const receipt = (await findByTestId('journal-erasure-receipt')).props.children as string;
    expect(receipt).toMatch(/already deleted/i);
    // A 404 cannot say what the vault did, so nothing is claimed about the copy.
    expect(receipt).not.toMatch(/withdrawn|confirmed|is gone/i);
  });

  it('offers no choice for an ordinary failure', async () => {
    mockDelete.mockRejectedValue(new Error('network down'));
    const { getByTestId, findByTestId, queryByTestId } = await shelfWithDeleteRequested();

    await act(async () => {
      fireEvent.press(getByTestId('journal-delete-confirm'));
    });

    await findByTestId('journal-delete-error');
    expect(queryByTestId('journal-unreachable-choice')).toBeNull();
  });
});

describe('the receipt names where a copy may remain (#3094)', () => {
  it('names the connected vault when that vault itself could not confirm', () => {
    const notice = erasureReceiptNotice({
      entry_id: 2,
      remote_copy: 'unconfirmed',
      copy_location: 'connected_vault',
    });
    expect(notice).toMatch(/copy may still be in your Creek vault/);
    expect(notice).not.toMatch(/withdrawn|is gone too/);
  });

  it('falls back to the connected vault when the server names no location', () => {
    const notice = erasureReceiptNotice({
      entry_id: 2,
      remote_copy: 'unconfirmed',
      copy_location: null,
    });
    expect(notice).toMatch(/copy may still be in your Creek vault/);
  });
});
