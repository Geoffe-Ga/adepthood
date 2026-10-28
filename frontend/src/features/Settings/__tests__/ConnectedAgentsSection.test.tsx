/* global describe, test, expect, beforeEach, jest */
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';

import {
  AGENTS_ADDRESS_COPIED,
  AGENTS_ADDRESS_COPY,
  AGENTS_ADDRESS_COPY_FAILED,
  AGENTS_ADDRESS_LABEL,
  AGENTS_EMPTY,
  AGENTS_EYEBROW,
  AGENTS_HEADING,
  AGENTS_LOAD_FAILED,
  AGENTS_NOT_USED_YET,
  AGENTS_ON_THIS_COMPUTER,
  AGENTS_STOP,
  AGENTS_STOPPED,
  AGENTS_STOPPING,
  AGENTS_STOP_CONFIRM,
  AGENTS_STOP_CONFIRM_BUTTON,
  AGENTS_STOP_FAILED,
  AGENTS_STOP_KEEP,
  AGENTS_UNNAMED,
  AGENTS_WHAT_THEY_ARE,
} from '../agentsCopy';
import ConnectedAgentsSection from '../ConnectedAgentsSection';
import type { VaultConnectionState } from '../vaultConnectionState';

import { ApiError, vault, type ConnectedAgent } from '@/api';
import { copyToClipboard } from '@/utils/clipboard';

/**
 * "Agents that may read your vault", rendered against a mocked client (#3534).
 *
 * The section's promises, each pinned here: every approved agent is listed
 * with what it may do in plain words and never as a permission name; Stop asks
 * in place -- no ``window.confirm``, no dialog that react-native-web cannot
 * draw -- and only a confirmed stop reaches the wire; a failed list never
 * reads as an empty one; the empty state offers no button that cannot finish;
 * and the address to give an agent is shown, with a way to copy it, exactly
 * when the server says there is one.
 */

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return {
    ...actual,
    vault: {
      agents: jest.fn(),
      revokeAgent: jest.fn(),
      agentActivity: jest.fn(() => Promise.resolve({ status: 'ok', rows: [] })),
    },
  };
});

jest.mock('@/utils/clipboard', () => ({ copyToClipboard: jest.fn() }));

const mockAgents = vault.agents as jest.MockedFunction<typeof vault.agents>;
const mockRevoke = vault.revokeAgent as jest.MockedFunction<typeof vault.revokeAgent>;
const mockCopy = copyToClipboard as jest.MockedFunction<typeof copyToClipboard>;

const HOUR_MS = 3_600_000;
const HTTP_SERVER_ERROR = 500;
const AGENT_ADDRESS = 'https://vault.example/mcp';

const CONNECTED: VaultConnectionState = {
  kind: 'connected',
  address: 'https://vault.example/v1',
  agentAddress: AGENT_ADDRESS,
};
const MANAGED: VaultConnectionState = { kind: 'managed' };
const NONE: VaultConnectionState = { kind: 'none' };
const UNKNOWN: VaultConnectionState = { kind: 'unknown' };

const OPENCLAW: ConnectedAgent = {
  id: 3,
  name: 'OpenClaw on my Mac mini',
  grants: ['vault:read', 'vault:desk', 'offline_access'],
  created_at: '2026-10-20T16:00:00Z',
  last_used_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
  redirect_host: '127.0.0.1',
};
const CONNECTOR: ConnectedAgent = {
  id: 7,
  name: null,
  grants: ['vault:desk', 'vault:telepathy'],
  created_at: '2026-10-21T16:00:00Z',
  last_used_at: null,
  redirect_host: 'chatgpt.com',
};

/** A promise and the hands that settle it, for holding a request in flight. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (_value: T) => void;
  reject: (_reason: unknown) => void;
} {
  let resolve: (_value: T) => void = () => undefined;
  let reject: (_reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function renderSection(vaultState: VaultConnectionState = CONNECTED) {
  const view = render(<ConnectedAgentsSection vault={vaultState} />);
  await waitFor(() => expect(mockAgents).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAgents.mockResolvedValue([OPENCLAW, CONNECTOR]);
  mockRevoke.mockResolvedValue(undefined);
  mockCopy.mockResolvedValue(true);
});

describe('ConnectedAgentsSection — the deck', () => {
  test('names the section and explains it in one paragraph', async () => {
    const { getByText } = await renderSection();

    expect(getByText(AGENTS_EYEBROW)).toBeTruthy();
    expect(getByText(AGENTS_HEADING)).toBeTruthy();
    expect(getByText(AGENTS_WHAT_THEY_ARE)).toBeTruthy();
  });

  test('marks the heading as a heading', async () => {
    const { getByText } = await renderSection();

    expect(getByText(AGENTS_HEADING).props.accessibilityRole).toBe('header');
  });

  test('shows a spinner, not an empty state, while the list is on its way', () => {
    mockAgents.mockReturnValue(deferred<ConnectedAgent[]>().promise);

    const { getByTestId, queryByText } = render(<ConnectedAgentsSection vault={CONNECTED} />);

    expect(getByTestId('vault-agents-loading')).toBeTruthy();
    expect(queryByText(AGENTS_EMPTY)).toBeNull();
  });
});

describe('ConnectedAgentsSection — the list', () => {
  test('lists each agent with its name, its permissions in words and when it was used', async () => {
    const { getByTestId } = await renderSection();
    const row = within(getByTestId('vault-agent-row-3'));

    expect(row.getByText('OpenClaw on my Mac mini')).toBeTruthy();
    expect(row.getByText('Read and search your Open and Personal writing')).toBeTruthy();
    expect(row.getByText('Draft and reflect from your Open and Personal writing')).toBeTruthy();
    expect(row.getByText('Stay connected without asking you again')).toBeTruthy();
    expect(row.getByText(AGENTS_ON_THIS_COMPUTER)).toBeTruthy();
    expect(row.getByText('Last used 2 hours ago')).toBeTruthy();
  });

  test('names an unnamed agent in words, and says where it signs in and that it is unused', async () => {
    const { getByTestId } = await renderSection();
    const row = within(getByTestId('vault-agent-row-7'));

    expect(row.getByText(AGENTS_UNNAMED)).toBeTruthy();
    expect(row.getByText('Signs in through chatgpt.com')).toBeTruthy();
    expect(row.getByText(AGENTS_NOT_USED_YET)).toBeTruthy();
  });

  test('never renders a permission name, known or not', async () => {
    const { toJSON } = await renderSection();

    expect(JSON.stringify(toJSON())).not.toMatch(/vault:|offline_access/u);
  });

  test('says how an agent arrives when there is none, with no button to press', async () => {
    mockAgents.mockResolvedValue([]);

    const { getByTestId, getByText, queryByRole } = await renderSection();

    expect(getByText(AGENTS_EMPTY)).toBeTruthy();
    expect(getByTestId('vault-agents-empty')).toBeTruthy();
    expect(queryByRole('button', { name: /stop/iu })).toBeNull();
  });

  test('says the list could not be read rather than that there is nobody', async () => {
    mockAgents.mockRejectedValue(new ApiError(HTTP_SERVER_ERROR, 'boom'));

    const { getByText, queryByText } = await renderSection();

    expect(getByText(AGENTS_LOAD_FAILED)).toBeTruthy();
    expect(queryByText(AGENTS_EMPTY)).toBeNull();
  });

  test('reads the list once, on mount', async () => {
    const { rerender } = await renderSection();

    rerender(<ConnectedAgentsSection vault={MANAGED} />);

    expect(mockAgents).toHaveBeenCalledTimes(1);
  });
});

describe('ConnectedAgentsSection — when it shows at all', () => {
  test('stays out of the way for an account with no vault and no agents', async () => {
    mockAgents.mockResolvedValue([]);

    const { queryByTestId } = await renderSection(NONE);

    expect(queryByTestId('vault-agents-section')).toBeNull();
  });

  test('still lists agents approved before the vault was disconnected, so they can be stopped', async () => {
    const { getByTestId } = await renderSection(NONE);

    expect(getByTestId('vault-agent-row-3')).toBeTruthy();
  });

  test('renders for a managed vault and for a read that could not tell', async () => {
    for (const state of [MANAGED, UNKNOWN]) {
      const { getByTestId, unmount } = await renderSection(state);

      expect(getByTestId('vault-agents-section')).toBeTruthy();
      unmount();
    }
  });
});

describe('ConnectedAgentsSection — stopping an agent', () => {
  test('asks in place first, and sends nothing until the answer is yes', async () => {
    const { getByTestId } = await renderSection();
    const row = within(getByTestId('vault-agent-row-3'));

    fireEvent.press(row.getByRole('button', { name: `${AGENTS_STOP} OpenClaw on my Mac mini` }));

    expect(row.getByText(AGENTS_STOP_CONFIRM)).toBeTruthy();
    expect(row.getByRole('button', { name: AGENTS_STOP_CONFIRM_BUTTON })).toBeTruthy();
    expect(row.getByRole('button', { name: AGENTS_STOP_KEEP })).toBeTruthy();
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  test('Keep closes the question and changes nothing', async () => {
    const { getByTestId } = await renderSection();
    const row = within(getByTestId('vault-agent-row-3'));
    fireEvent.press(row.getByTestId('vault-agent-stop-3'));

    fireEvent.press(row.getByText(AGENTS_STOP_KEEP));

    expect(row.queryByText(AGENTS_STOP_CONFIRM)).toBeNull();
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  test('a confirmed stop revokes that one agent, drops its row and says so', async () => {
    const { getByTestId, queryByTestId, getByText } = await renderSection();
    fireEvent.press(getByTestId('vault-agent-stop-3'));

    await act(async () => {
      fireEvent.press(getByTestId('vault-agent-stop-confirm-3'));
    });

    expect(mockRevoke).toHaveBeenCalledWith(OPENCLAW.id);
    expect(queryByTestId('vault-agent-row-3')).toBeNull();
    expect(getByTestId('vault-agent-row-7')).toBeTruthy();
    expect(getByText(AGENTS_STOPPED)).toBeTruthy();
  });

  test('says it is stopping, and takes no second press, while the stop is in flight', async () => {
    const pending = deferred<void>();
    mockRevoke.mockReturnValue(pending.promise);
    const { getByTestId } = await renderSection();
    fireEvent.press(getByTestId('vault-agent-stop-3'));
    fireEvent.press(getByTestId('vault-agent-stop-confirm-3'));

    const busy = getByTestId('vault-agent-stop-confirm-3');
    expect(within(busy).getByText(AGENTS_STOPPING)).toBeTruthy();
    fireEvent.press(busy);
    expect(mockRevoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(undefined);
      await pending.promise;
    });
  });

  test('a stop that did not land keeps the agent listed and says why', async () => {
    mockRevoke.mockRejectedValue(new ApiError(HTTP_SERVER_ERROR, 'boom'));
    const { getByTestId, getByText } = await renderSection();
    fireEvent.press(getByTestId('vault-agent-stop-3'));

    await act(async () => {
      fireEvent.press(getByTestId('vault-agent-stop-confirm-3'));
    });

    expect(getByTestId('vault-agent-row-3')).toBeTruthy();
    expect(getByText(AGENTS_STOP_FAILED)).toBeTruthy();
  });

  test('the last stopped agent leaves the empty state behind', async () => {
    mockAgents.mockResolvedValue([OPENCLAW]);
    const { getByTestId, getByText } = await renderSection();
    fireEvent.press(getByTestId('vault-agent-stop-3'));

    await act(async () => {
      fireEvent.press(getByTestId('vault-agent-stop-confirm-3'));
    });

    expect(getByText(AGENTS_EMPTY)).toBeTruthy();
  });
});

describe('ConnectedAgentsSection — the address to give an agent', () => {
  test('shows the address the server names, under its label', async () => {
    const { getByTestId, getByText } = await renderSection();

    expect(getByText(AGENTS_ADDRESS_LABEL)).toBeTruthy();
    expect(within(getByTestId('vault-agents-address')).getByText(AGENT_ADDRESS)).toBeTruthy();
  });

  test('copies it, and says so', async () => {
    const { getByRole, getByText } = await renderSection();

    await act(async () => {
      fireEvent.press(getByRole('button', { name: AGENTS_ADDRESS_COPY }));
    });

    expect(mockCopy).toHaveBeenCalledWith(AGENT_ADDRESS);
    expect(getByText(AGENTS_ADDRESS_COPIED)).toBeTruthy();
  });

  test('offers the way that always works when this device will not copy', async () => {
    mockCopy.mockResolvedValue(false);
    const { getByRole, getByText } = await renderSection();

    await act(async () => {
      fireEvent.press(getByRole('button', { name: AGENTS_ADDRESS_COPY }));
    });

    expect(getByText(AGENTS_ADDRESS_COPY_FAILED)).toBeTruthy();
  });

  test('explains when the agent address cannot be confirmed for a managed vault', async () => {
    mockAgents.mockResolvedValue([]);
    const { getByText, queryByText } = await renderSection(MANAGED);

    expect(
      getByText('Adepthood can’t show an agent sign-in address for this vault yet.'),
    ).toBeTruthy();
    expect(queryByText(AGENTS_EMPTY)).toBeNull();
  });

  test('shows a managed public agent address when the server names one', async () => {
    const { getByTestId, queryByText } = await renderSection({
      kind: 'managed',
      agentAddress: AGENT_ADDRESS,
    });

    expect(within(getByTestId('vault-agents-address')).getByText(AGENT_ADDRESS)).toBeTruthy();
    expect(
      queryByText('Adepthood can’t show an agent sign-in address for this vault yet.'),
    ).toBeNull();
    fireEvent.press(getByTestId('vault-agents-copy'));
    await waitFor(() => expect(mockCopy).toHaveBeenCalledWith(AGENT_ADDRESS));
  });

  test('shows no address and no copy when a managed public address is unconfirmed', async () => {
    const { queryByTestId, queryByText } = await renderSection(MANAGED);

    expect(queryByTestId('vault-agents-address')).toBeNull();
    expect(queryByText(AGENTS_ADDRESS_COPY)).toBeNull();
  });

  test('shows no address for a vault of your own the server names none for', async () => {
    const { queryByTestId } = await renderSection({ ...CONNECTED, agentAddress: null });

    expect(queryByTestId('vault-agents-address')).toBeNull();
  });
});

describe('ConnectedAgentsSection — recent activity', () => {
  test('renders what agents asked for beneath the agent rows, inside the section', async () => {
    const { getByTestId, findByTestId } = await renderSection(CONNECTED);

    const section = getByTestId('vault-agents-section');
    await findByTestId('vault-activity-empty');
    expect(within(section).getByTestId('vault-activity')).toBeTruthy();
    expect(vault.agentActivity).toHaveBeenCalledTimes(1);
  });

  test('is not read for an account whose section stays out of the way', async () => {
    mockAgents.mockResolvedValue([]);
    const { queryByTestId } = render(<ConnectedAgentsSection vault={NONE} />);
    await waitFor(() => expect(mockAgents).toHaveBeenCalled());

    expect(queryByTestId('vault-activity')).toBeNull();
    expect(vault.agentActivity).not.toHaveBeenCalled();
  });
});
