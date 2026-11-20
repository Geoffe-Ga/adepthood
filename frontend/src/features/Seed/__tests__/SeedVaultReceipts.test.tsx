/* eslint-env jest */
/* global describe, test, expect, afterEach, beforeEach, jest */

const mockPipeline = jest.fn<Promise<VaultPipeline>, []>();
const mockNavigate = jest.fn();

jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/api');
  return { ...actual, vault: { pipeline: () => mockPipeline() } };
});

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { SeedItem } from '../seedRun';
import { SeedRowLanding, SeedVaultReceiptsLink } from '../SeedVaultReceipts';

import type { VaultPipeline } from '@/api';
import { setActiveUser } from '@/storage/userScope';
import { resetAllStores } from '@/store/registry';
import { pipelineAnswer, receipt } from '@/testing/vaultPipelineFixtures';

/**
 * A finished Seed run says where each file landed and opens "Your vault" (#3776).
 */

const LANDED: SeedItem = { id: 'seed-0', name: 'on-attention.html', status: 'ingested' };
const IN_FLIGHT: SeedItem = { id: 'seed-1', name: 'later.md', status: 'queued' };

const Run = ({ items, isSending }: { items: SeedItem[]; isSending: boolean }) => (
  <>
    {items.map((item) => (
      <SeedRowLanding key={item.id} item={item} />
    ))}
    <SeedVaultReceiptsLink items={items} isSending={isSending} />
  </>
);

beforeEach(() => {
  jest.clearAllMocks();
  setActiveUser(1);
  resetAllStores();
});

afterEach(() => {
  setActiveUser(null);
});

describe('a Seed run’s receipts', () => {
  test('reads nothing and offers nothing while documents are still going over', () => {
    const screen = render(<Run items={[LANDED, IN_FLIGHT]} isSending />);

    expect(mockPipeline).not.toHaveBeenCalled();
    expect(screen.queryByTestId('seed-open-vault-dashboard')).toBeNull();
  });

  test('once finished, names the folder each landed file went to and opens the dashboard', async () => {
    mockPipeline.mockResolvedValue(pipelineAnswer());
    const screen = render(<Run items={[LANDED]} isSending={false} />);

    expect(await screen.findByTestId('seed-item-landed-seed-0')).toHaveTextContent(
      'Landed in Writing · Substack',
    );
    fireEvent.press(screen.getByTestId('seed-open-vault-dashboard'));
    expect(mockNavigate).toHaveBeenCalledWith('VaultDashboard');
  });

  test('a run where nothing landed in a vault reads nothing and offers nothing', () => {
    const refused: SeedItem = { ...LANDED, status: 'vault_unavailable' };
    const screen = render(<Run items={[refused]} isSending={false} />);

    expect(mockPipeline).not.toHaveBeenCalled();
    expect(screen.queryByTestId('seed-open-vault-dashboard')).toBeNull();
    expect(screen.queryByTestId('seed-item-landed-seed-0')).toBeNull();
  });

  test('a row the receipts cannot place claims no folder', async () => {
    mockPipeline.mockResolvedValue(
      pipelineAnswer({ recent_uploads: [receipt({ landed_in: null })] }),
    );
    const screen = render(<Run items={[LANDED]} isSending={false} />);

    await waitFor(() => expect(mockPipeline).toHaveBeenCalledTimes(1));
    await screen.findByTestId('seed-open-vault-dashboard');
    expect(screen.queryByTestId('seed-item-landed-seed-0')).toBeNull();
  });

  test('reads again when more have landed since', async () => {
    mockPipeline.mockResolvedValue(pipelineAnswer());
    const second: SeedItem = { id: 'seed-2', name: 'second.md', status: 'ingested' };
    const screen = render(<Run items={[LANDED]} isSending={false} />);
    await waitFor(() => expect(mockPipeline).toHaveBeenCalledTimes(1));

    screen.rerender(<Run items={[LANDED, second]} isSending={false} />);

    await waitFor(() => expect(mockPipeline).toHaveBeenCalledTimes(2));
  });
});
