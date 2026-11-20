/* eslint-env jest */
/* global describe, test, expect, afterEach, beforeEach, jest */

const mockPipeline = jest.fn<Promise<VaultPipeline>, []>();
let mockFocused = true;

jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/api');
  return { ...actual, vault: { pipeline: () => mockPipeline() } };
});

jest.mock('@react-navigation/native', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useFocusEffect: (effect: () => void) => {
      useEffect(() => effect(), [effect]);
    },
    useIsFocused: () => mockFocused,
  };
});

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { VAULT_UNREACHABLE } from '../vaultCopy';
import {
  VAULT_DASHBOARD_NO_PASSES,
  VAULT_DASHBOARD_NOT_CONNECTED,
  VAULT_DASHBOARD_NOTHING_YET,
  VAULT_DASHBOARD_READ_FAILURE,
  VAULT_DASHBOARD_TITLE,
  VAULT_UPDATE_NEEDED,
  WRITERLESS_LINE,
} from '../vaultDashboardCopy';
import VaultDashboardScreen, { VAULT_DASHBOARD_POLL_INTERVAL_MS } from '../VaultDashboardScreen';

import type { VaultPipeline } from '@/api';
import { setActiveUser } from '@/storage/userScope';
import { resetAllStores } from '@/store/registry';
import { expectNavigationOwnsTitle } from '@/testing/navigationOwnsTitle';
import { pipelineAnswer, receipt, stageRun, VAULT_SNAPSHOT } from '@/testing/vaultPipelineFixtures';

/**
 * The "Your vault" dashboard (#3776): what came in and where it landed, what
 * Creek has done, and the vault's shape -- in words, never tokens -- with a
 * sentence for every way Creek's half can be missing, and polling only while
 * something is still going.
 */

/** Every wire token the fixture answer carries, none of which may reach the screen. */
const RAW_TOKENS = [
  'owner_curated',
  'container',
  'link.eddies',
  'classify.praxis',
  'linked:eddies',
  'praxis_scanned',
  'document_import',
  '01-Fragments',
  'accepted',
];

/** Words NORTH-STAR "Default to quiet" keeps off this screen. */
const PRESSURE = /%|streak|score|percent/iu;

interface RenderedNode {
  children?: (RenderedNode | string)[] | null;
}

/** Every string the screen renders, and nothing else (no style values). */
function textOf(screen: ReturnType<typeof render>): string[] {
  const found: string[] = [];
  const walk = (node: RenderedNode | string | null): void => {
    if (node === null) return;
    if (typeof node === 'string') {
      found.push(node);
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(screen.toJSON() as RenderedNode | null);
  return found;
}

async function renderScreen(navigate = jest.fn()): Promise<ReturnType<typeof render>> {
  const screen = render(<VaultDashboardScreen navigation={{ navigate }} />);
  await waitFor(() => expect(mockPipeline).toHaveBeenCalled());
  return screen;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFocused = true;
  setActiveUser(1);
  resetAllStores();
});

afterEach(() => {
  jest.useRealTimers();
  setActiveUser(null);
});

describe('VaultDashboardScreen', () => {
  test('shows what came in, what Creek has done, and the vault’s shape, in words', async () => {
    mockPipeline.mockResolvedValue(
      pipelineAnswer({
        stage_runs: [
          stageRun({ stage: 'eddies', emitted: 9 }),
          stageRun({ stage: 'classify', emitted: 212 }),
        ],
      }),
    );
    const screen = await renderScreen();

    await screen.findByTestId('vault-dashboard-uploads');
    expect(screen.getByText('Files you chose · 20 Nov')).toBeTruthy();
    expect(screen.getByText('1 landed')).toBeTruthy();
    expect(screen.getAllByText('Landed in Writing · Substack').length).toBeGreaterThan(0);

    expect(screen.getByTestId('vault-pass-classify')).toHaveTextContent('Classified ✓ (212)');
    expect(screen.getByTestId('vault-pass-eddies')).toHaveTextContent('Eddies ✓ (9)');
    expect(screen.getByTestId('vault-document-0')).toHaveTextContent(
      /Brought in ✓ · Classified ✓ · Eddies partly/u,
    );
    expect(screen.getByTestId('vault-documents-withheld')).toBeTruthy();

    const substack = screen.getByTestId('vault-folder-01-Fragments/Writing/Substack');
    expect(substack).toHaveTextContent(/Fragments · Writing · Substack/u);
    expect(substack).toHaveTextContent(/212/u);
    const curated = screen.getByTestId('vault-folder-09-Reference/External-Sources');
    expect(curated).toHaveTextContent(/Reference · External Sources/u);
    expect(curated).toHaveTextContent(`${WRITERLESS_LINE} — it's yours to fill.`, { exact: false });
    expect(screen.getByTestId('vault-folder-04-Praxis/Daily')).toHaveTextContent(
      /Nothing here yet — fills as practices surface in your writing\./u,
    );

    const text = textOf(screen);
    expect(text.length).toBeGreaterThan(RAW_TOKENS.length);
    for (const line of text) {
      for (const token of RAW_TOKENS) expect(line).not.toContain(token);
      expect(line).not.toMatch(PRESSURE);
    }
    expectNavigationOwnsTitle(screen, VAULT_DASHBOARD_TITLE);
  });

  test('a folder import counts what did not land, and a file Creek has not placed claims no folder', async () => {
    mockPipeline.mockResolvedValue(
      pipelineAnswer({
        recent_uploads: [
          receipt({ id: 2, batch: 'b1' }),
          receipt({ id: 1, batch: 'b1', vault_status: 'degraded', landed_in: null }),
        ],
        stage_runs: [stageRun({ outcome: 'failed', failure_code: 'busy' })],
        vault: {
          ...VAULT_SNAPSHOT,
          documents: [{ filename: 'loose.md', landed_in: null, fragment_count: 0, stages: [] }],
          documents_withheld: 0,
        },
      }),
    );
    const screen = await renderScreen();

    expect(await screen.findByText('A folder · 20 Nov')).toBeTruthy();
    expect(screen.getByText("1 landed · 1 didn't")).toBeTruthy();
    expect(screen.getByTestId('vault-receipt-1')).toHaveTextContent(/Couldn't be confirmed/u);
    expect(screen.getByTestId('vault-pass-classify')).toHaveTextContent(/didn't finish/u);
    expect(screen.getByTestId('vault-document-0')).not.toHaveTextContent(/Landed in/u);
    expect(screen.queryByTestId('vault-documents-withheld')).toBeNull();
  });

  test('counts use tabular numerals so a column of them lines up', async () => {
    mockPipeline.mockResolvedValue(pipelineAnswer());
    const screen = await renderScreen();

    const count = await screen.findByTestId('vault-folder-count-03-Eddies');
    expect(count).toHaveStyle({ fontVariant: ['tabular-nums'] });
  });

  test('a vault that needs an update says so, and still shows what came in', async () => {
    mockPipeline.mockResolvedValue(pipelineAnswer({ vault: null, vault_status: 'update_needed' }));
    const screen = await renderScreen();

    expect(await screen.findByText(VAULT_UPDATE_NEEDED)).toBeTruthy();
    expect(screen.getByTestId('vault-dashboard-uploads')).toBeTruthy();
    expect(screen.queryByTestId('vault-dashboard-shape')).toBeNull();
  });

  test('an unreachable vault reads as the outage it is, with the way to check again', async () => {
    mockPipeline.mockResolvedValue(
      pipelineAnswer({ vault: null, vault_status: 'unreachable', vault_unreachable: true }),
    );
    const screen = await renderScreen();

    expect(await screen.findByText(VAULT_UNREACHABLE)).toBeTruthy();
    expect(screen.getByTestId('vault-check-now')).toBeTruthy();
    expect(screen.queryByText(VAULT_DASHBOARD_READ_FAILURE)).toBeNull();
  });

  test('an account with no vault is pointed to where one is set up', async () => {
    mockPipeline.mockResolvedValue(
      pipelineAnswer({
        recent_uploads: [],
        stage_runs: [],
        vault: null,
        vault_status: 'not_connected',
      }),
    );
    const navigate = jest.fn();
    const screen = await renderScreen(navigate);

    expect(await screen.findByText(VAULT_DASHBOARD_NOT_CONNECTED)).toBeTruthy();
    fireEvent.press(screen.getByTestId('vault-dashboard-open-settings'));
    expect(navigate).toHaveBeenCalledWith('VaultSettings');
  });

  test('a vault with nothing in it yet says so quietly', async () => {
    mockPipeline.mockResolvedValue(
      pipelineAnswer({
        recent_uploads: [],
        stage_runs: [],
        vault: { folders: [], documents: [], documents_withheld: 0, jobs: [] },
      }),
    );
    const screen = await renderScreen();

    expect(await screen.findByText(VAULT_DASHBOARD_NOTHING_YET)).toBeTruthy();
    expect(screen.getByText(VAULT_DASHBOARD_NO_PASSES)).toBeTruthy();
    expect(screen.queryByTestId('vault-documents-withheld')).toBeNull();
  });

  test('a read that fails says so and reads again on request', async () => {
    mockPipeline.mockRejectedValueOnce(new Error('offline'));
    const screen = await renderScreen();

    expect(await screen.findByText(VAULT_DASHBOARD_READ_FAILURE)).toBeTruthy();
    mockPipeline.mockResolvedValueOnce(pipelineAnswer());
    fireEvent.press(screen.getByTestId('vault-dashboard-retry'));

    await screen.findByTestId('vault-dashboard-uploads');
    expect(mockPipeline).toHaveBeenCalledTimes(2);
  });

  test('is loading, not empty, before the first answer', () => {
    mockPipeline.mockReturnValue(new Promise(() => undefined));
    const screen = render(<VaultDashboardScreen />);

    expect(screen.getByTestId('vault-dashboard-loading')).toBeTruthy();
    expect(screen.queryByText(VAULT_DASHBOARD_NOTHING_YET)).toBeNull();
  });
});

describe('VaultDashboardScreen polling', () => {
  test('re-reads every interval while a pass is going, and stops once it ends', async () => {
    jest.useFakeTimers();
    mockPipeline
      .mockResolvedValueOnce(pipelineAnswer({ stage_runs: [stageRun({ outcome: 'attempted' })] }))
      .mockResolvedValueOnce(pipelineAnswer());
    const screen = await renderScreen();
    await screen.findByTestId('vault-pass-classify');

    await act(async () => {
      jest.advanceTimersByTime(VAULT_DASHBOARD_POLL_INTERVAL_MS);
    });
    await waitFor(() => expect(mockPipeline).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId('vault-pass-classify')).toHaveTextContent('Classified ✓ (212)'),
    );

    await act(async () => {
      jest.advanceTimersByTime(VAULT_DASHBOARD_POLL_INTERVAL_MS * 3);
    });
    expect(mockPipeline).toHaveBeenCalledTimes(2);
  });

  test('reads once and never polls when nothing is going', async () => {
    jest.useFakeTimers();
    mockPipeline.mockResolvedValue(pipelineAnswer());
    const screen = await renderScreen();
    await screen.findByTestId('vault-dashboard-uploads');

    await act(async () => {
      jest.advanceTimersByTime(VAULT_DASHBOARD_POLL_INTERVAL_MS * 3);
    });

    expect(mockPipeline).toHaveBeenCalledTimes(1);
  });

  test('does not poll while another screen is in front of it', async () => {
    jest.useFakeTimers();
    mockFocused = false;
    mockPipeline.mockResolvedValue(
      pipelineAnswer({ stage_runs: [stageRun({ outcome: 'queued' })] }),
    );
    const screen = await renderScreen();
    await screen.findByTestId('vault-pass-classify');

    await act(async () => {
      jest.advanceTimersByTime(VAULT_DASHBOARD_POLL_INTERVAL_MS * 3);
    });

    expect(mockPipeline).toHaveBeenCalledTimes(1);
  });

  test('leaving the screen stops the polling', async () => {
    jest.useFakeTimers();
    mockPipeline.mockResolvedValue(
      pipelineAnswer({ stage_runs: [stageRun({ outcome: 'queued' })] }),
    );
    const screen = await renderScreen();
    await screen.findByTestId('vault-pass-classify');

    screen.unmount();
    await act(async () => {
      jest.advanceTimersByTime(VAULT_DASHBOARD_POLL_INTERVAL_MS * 3);
    });

    expect(mockPipeline).toHaveBeenCalledTimes(1);
  });
});
