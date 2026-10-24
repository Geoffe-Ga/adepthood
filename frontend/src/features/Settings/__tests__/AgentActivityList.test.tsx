/* global describe, test, expect, beforeEach, jest */
import { NavigationContext } from '@react-navigation/native';
import { act, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import AgentActivityList, { ACTIVITY_ROW_LIMIT } from '../AgentActivityList';
import {
  ACTIVITY_EMPTY,
  ACTIVITY_HEADING,
  ACTIVITY_REFUSED,
  ACTIVITY_UNAVAILABLE,
  ACTIVITY_WHAT_IT_IS,
} from '../agentsCopy';

import { ApiError, vault, type AgentActivity, type AgentActivityRow } from '@/api';

/**
 * "Recent activity", rendered against a mocked client (#3535).
 *
 * Pinned here: the list asks for twenty and shows at most twenty; each row is
 * the server's words, a relative time and -- only for a refused call -- the
 * small marker; nothing yet and could-not-check are two different sentences;
 * and the list is read on mount and on each return to the screen, never on a
 * timer.
 */

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return { ...actual, vault: { agentActivity: jest.fn() } };
});

const mockActivity = vault.agentActivity as jest.MockedFunction<typeof vault.agentActivity>;

const MINUTE_MS = 60_000;
const HTTP_SERVER_ERROR = 500;
const OVERFULL_ROWS = ACTIVITY_ROW_LIMIT + 5;

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

const DRAFTED: AgentActivityRow = {
  agent: 'OpenClaw on my Mac mini',
  tool_label: 'Drafted an essay',
  at: ago(5 * MINUTE_MS),
  outcome: 'admitted',
};
const RESORT: AgentActivityRow = {
  agent: 'OpenClaw on my Mac mini',
  tool_label: 'Tried to re-sort the vault',
  at: ago(6 * MINUTE_MS),
  outcome: 'refused',
};

function answer(rows: AgentActivityRow[]): AgentActivity {
  return { status: 'ok', rows };
}

/** A navigation object whose focus and blur listeners a test can fire. */
function fakeNavigation(): {
  navigation: React.ContextType<typeof NavigationContext>;
  fire: (_event: 'focus' | 'blur') => void;
} {
  const listeners: Record<string, Array<() => void>> = { focus: [], blur: [] };
  const navigation = {
    isFocused: () => true,
    addListener: (event: string, callback: () => void) => {
      listeners[event]?.push(callback);
      return () => undefined;
    },
  } as unknown as React.ContextType<typeof NavigationContext>;
  return {
    navigation,
    fire: (event) => listeners[event]?.forEach((callback) => callback()),
  };
}

beforeEach(() => {
  mockActivity.mockReset();
});

describe('AgentActivityList', () => {
  test('heads the list and says what it can and cannot show', async () => {
    mockActivity.mockResolvedValue(answer([]));
    const { getByText } = render(<AgentActivityList />);

    expect(getByText(ACTIVITY_HEADING)).toBeTruthy();
    expect(getByText(ACTIVITY_WHAT_IT_IS)).toBeTruthy();
    await waitFor(() => expect(getByText(ACTIVITY_EMPTY)).toBeTruthy());
  });

  test('asks for twenty calls, once, on arrival', async () => {
    mockActivity.mockResolvedValue(answer([]));
    const { findByTestId } = render(<AgentActivityList />);

    await findByTestId('vault-activity-empty');
    expect(mockActivity).toHaveBeenCalledTimes(1);
    expect(mockActivity).toHaveBeenCalledWith(ACTIVITY_ROW_LIMIT);
  });

  test('shows each call in the server words, with when, and marks only the refused one', async () => {
    mockActivity.mockResolvedValue(answer([DRAFTED, RESORT]));
    const { findByTestId, getByText, queryByTestId, getAllByText } = render(<AgentActivityList />);

    await findByTestId('vault-activity-list');
    expect(getByText('Drafted an essay')).toBeTruthy();
    expect(getByText('Tried to re-sort the vault')).toBeTruthy();
    expect(getByText('OpenClaw on my Mac mini · 5 minutes ago')).toBeTruthy();
    expect(getByText('OpenClaw on my Mac mini · 6 minutes ago')).toBeTruthy();
    expect(queryByTestId('vault-activity-refused-0')).toBeNull();
    expect(queryByTestId('vault-activity-refused-1')).toBeTruthy();
    expect(getAllByText(ACTIVITY_REFUSED)).toHaveLength(1);
  });

  test('a time it cannot read leaves just the agent', async () => {
    mockActivity.mockResolvedValue(answer([{ ...DRAFTED, at: 'not a time' }]));
    const { findByText } = render(<AgentActivityList />);

    expect(await findByText('OpenClaw on my Mac mini')).toBeTruthy();
  });

  test('never shows more than twenty, whatever comes back', async () => {
    const many = Array.from({ length: OVERFULL_ROWS }, (_, index) => ({
      ...DRAFTED,
      at: ago(index * MINUTE_MS),
    }));
    mockActivity.mockResolvedValue(answer(many));
    const { findByTestId, queryByTestId } = render(<AgentActivityList />);

    await findByTestId('vault-activity-list');
    expect(queryByTestId(`vault-activity-row-${ACTIVITY_ROW_LIMIT - 1}`)).toBeTruthy();
    expect(queryByTestId(`vault-activity-row-${ACTIVITY_ROW_LIMIT}`)).toBeNull();
  });

  test('says it could not check when the vault could not be read, never nothing yet', async () => {
    mockActivity.mockResolvedValue({ status: 'unavailable', rows: [] });
    const { findByText, queryByText } = render(<AgentActivityList />);

    expect(await findByText(ACTIVITY_UNAVAILABLE)).toBeTruthy();
    expect(queryByText(ACTIVITY_EMPTY)).toBeNull();
  });

  test('says the same when the request itself did not land', async () => {
    mockActivity.mockRejectedValue(new ApiError(HTTP_SERVER_ERROR, 'boom'));
    const { findByText } = render(<AgentActivityList />);

    expect(await findByText(ACTIVITY_UNAVAILABLE)).toBeTruthy();
  });

  test('reads again on a return to the screen, and not before', async () => {
    mockActivity.mockResolvedValueOnce(answer([])).mockResolvedValueOnce(answer([DRAFTED]));
    const { navigation, fire } = fakeNavigation();
    const { findByTestId, findByText } = render(
      <NavigationContext.Provider value={navigation}>
        <AgentActivityList />
      </NavigationContext.Provider>,
    );
    await findByTestId('vault-activity-empty');
    expect(mockActivity).toHaveBeenCalledTimes(1);

    act(() => {
      fire('blur');
      fire('focus');
    });

    expect(await findByText('Drafted an essay')).toBeTruthy();
    expect(mockActivity).toHaveBeenCalledTimes(2);
  });

  test('a read that settles after the screen is gone changes nothing', async () => {
    let settle: (_value: AgentActivity) => void = () => undefined;
    mockActivity.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const { unmount, queryByTestId } = render(<AgentActivityList />);
    expect(queryByTestId('vault-activity-loading')).toBeTruthy();

    unmount();
    await act(async () => {
      settle(answer([DRAFTED]));
      await Promise.resolve();
    });

    expect(mockActivity).toHaveBeenCalledTimes(1);
  });
});
