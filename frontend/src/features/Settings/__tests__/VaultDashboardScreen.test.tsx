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
  CORPUS_TOTALS_HEADING,
  CORPUS_TOTALS_NONE_WORKED,
  CORPUS_TOTALS_NOTHING_SENT,
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
import { touchTarget } from '@/design/tokens';
import { setActiveUser } from '@/storage/userScope';
import { resetAllStores } from '@/store/registry';
import { expectNavigationOwnsTitle } from '@/testing/navigationOwnsTitle';
import {
  pipelineAnswer,
  receipt,
  SENT_TOTALS,
  STAGE_TOTALS,
  stageRun,
  VAULT_SNAPSHOT,
} from '@/testing/vaultPipelineFixtures';

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

    const fragments = screen.getByTestId('vault-area-01-Fragments');
    expect(fragments).toHaveTextContent(/Fragments/u);
    expect(screen.getByTestId('vault-area-count-01-Fragments')).toHaveTextContent('212');
    expect(screen.getByTestId('vault-area-summary-01-Fragments')).toHaveTextContent(
      'Writing · Substack 212',
    );
    expect(screen.getByTestId('vault-area-note-04-Praxis')).toHaveTextContent(
      'Nothing here yet — fills as practices surface in your writing.',
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

    const count = await screen.findByTestId('vault-area-count-03-Eddies');
    expect(count).toHaveStyle({ fontVariant: ['tabular-nums'] });
  });

  test('the shape leads with areas, folded, and opens one to show its folders', async () => {
    mockPipeline.mockResolvedValue(pipelineAnswer());
    const screen = await renderScreen();
    await screen.findByTestId('vault-dashboard-shape');

    // Folded by default: no folder row is rendered for any area.
    expect(screen.queryByTestId('vault-folder-01-Fragments/Writing/Substack')).toBeNull();
    expect(screen.queryByTestId('vault-folder-04-Praxis/Daily')).toBeNull();

    const toggle = screen.getByTestId('vault-area-toggle-01-Fragments');
    expect(toggle.props.accessibilityRole).toBe('button');
    expect(toggle.props.accessibilityState).toEqual({ expanded: false });
    expect(toggle).toHaveStyle({ minHeight: touchTarget.minimum });

    fireEvent.press(toggle);

    expect(screen.getByTestId('vault-area-toggle-01-Fragments').props.accessibilityState).toEqual({
      expanded: true,
    });
    const substack = screen.getByTestId('vault-folder-01-Fragments/Writing/Substack');
    expect(substack).toHaveTextContent(/Writing · Substack/u);
    expect(
      screen.getByTestId('vault-folder-count-01-Fragments/Writing/Substack'),
    ).toHaveTextContent('212');
    expect(screen.queryByTestId('vault-folder-01-Fragments')).toBeNull();

    fireEvent.press(screen.getByTestId('vault-area-toggle-01-Fragments'));
    expect(screen.queryByTestId('vault-folder-01-Fragments/Writing/Substack')).toBeNull();
  });

  test('a container is only ever a header, and says nothing about holding folders', async () => {
    mockPipeline.mockResolvedValue(pipelineAnswer());
    const screen = await renderScreen();
    await screen.findByTestId('vault-dashboard-shape');
    for (const area of ['01-Fragments', '04-Praxis', '09-Reference', '10-Liminal']) {
      fireEvent.press(screen.getByTestId(`vault-area-toggle-${area}`));
    }

    expect(textOf(screen).join(' ')).not.toMatch(/holds the folders beneath it/u);
    expect(screen.queryByTestId('vault-folder-04-Praxis')).toBeNull();
  });

  test('folders kept together at their area are said once, never listed', async () => {
    mockPipeline.mockResolvedValue(pipelineAnswer());
    const screen = await renderScreen();
    await screen.findByTestId('vault-dashboard-shape');

    expect(screen.getByTestId('vault-area-indexed-06-Frequencies')).toHaveTextContent(
      'Notes for all 2 of its folders are kept together here.',
    );
    expect(screen.queryByTestId('vault-area-toggle-06-Frequencies')).toBeNull();
    expect(screen.queryByTestId('vault-folder-06-Frequencies/F1-Agency')).toBeNull();
    expect(screen.getAllByText(/kept together here/u)).toHaveLength(1);
  });

  test('an empty area says what fills it once; a folder’s own reason shows only when open', async () => {
    mockPipeline.mockResolvedValue(pipelineAnswer());
    const screen = await renderScreen();
    await screen.findByTestId('vault-dashboard-shape');

    expect(screen.getAllByText(/fills as practices surface/u)).toHaveLength(1);
    expect(screen.getByTestId('vault-area-note-09-Reference')).toHaveTextContent(
      `${WRITERLESS_LINE}.`,
    );
    expect(screen.queryByText(/yours to fill/u)).toBeNull();
    expect(screen.queryByText(/example that came with your vault/u)).toBeNull();

    fireEvent.press(screen.getByTestId('vault-area-toggle-09-Reference'));
    fireEvent.press(screen.getByTestId('vault-area-toggle-11-Other-Authors'));
    fireEvent.press(screen.getByTestId('vault-area-toggle-04-Praxis'));

    expect(screen.getByTestId('vault-folder-09-Reference/External-Sources')).toHaveTextContent(
      `${WRITERLESS_LINE} — it's yours to fill.`,
      { exact: false },
    );
    expect(screen.getByText(/example that came with your vault/u)).toBeTruthy();
    expect(screen.getAllByText(/fills as practices surface/u)).toHaveLength(1);
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
        vault: {
          folders: [],
          documents: [],
          documents_withheld: 0,
          jobs: [],
          stage_totals: null,
        },
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

/** A whole answer over a populated corpus: 1,243 sent, 1,240 held, stages at every state. */
function populatedAnswer(overrides: Partial<VaultPipeline> = {}): VaultPipeline {
  return pipelineAnswer({
    totals: { sent: SENT_TOTALS },
    vault: { ...VAULT_SNAPSHOT, stage_totals: STAGE_TOTALS },
    ...overrides,
  });
}

const STAGE_TOKENS = [
  'ingested',
  'classified',
  'praxis_scanned',
  'linked:embeddings',
  'linked:temporal',
  'linked:eddies',
  'linked:threads',
] as const;

describe('VaultDashboardScreen whole-corpus totals (#3796)', () => {
  test('leads with how many files landed of all that were sent, and how many did not', async () => {
    mockPipeline.mockResolvedValue(populatedAnswer());
    const screen = await renderScreen();

    const section = await screen.findByTestId('corpus-totals');
    expect(section).toHaveTextContent(new RegExp(CORPUS_TOTALS_HEADING, 'u'));
    expect(screen.getByTestId('corpus-totals-sent')).toHaveTextContent(
      '1,240 of 1,243 files landed',
    );
    expect(screen.getByTestId('corpus-totals-not-landed')).toHaveTextContent(
      '3 turned away for their file type',
    );
    const text = textOf(screen);
    expect(text.indexOf(CORPUS_TOTALS_HEADING)).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(CORPUS_TOTALS_HEADING)).toBeLessThan(text.indexOf('What came in'));
  });

  test('says nothing about files that did not land when every one did', async () => {
    mockPipeline.mockResolvedValue(pipelineAnswer());
    const screen = await renderScreen();

    expect(await screen.findByTestId('corpus-totals-sent')).toHaveTextContent('1 of 1 file landed');
    expect(screen.queryByTestId('corpus-totals-not-landed')).toBeNull();
  });

  test('lists every stage in pipeline order as "x of y files", in the screen’s own words', async () => {
    mockPipeline.mockResolvedValue(populatedAnswer());
    const screen = await renderScreen();
    await screen.findByTestId('corpus-totals-stages');

    const rows = [
      ['ingested', 'Brought in', '1,240 of 1,240 files'],
      ['classified', 'Classified', '1,180 of 1,240 files'],
      ['praxis_scanned', 'Read for praxis', '1,240 of 1,240 files'],
      ['linked:embeddings', 'Linked by meaning', '900 of 1,240 files'],
      ['linked:temporal', 'Linked in time', '1,100 of 1,240 files'],
      ['linked:eddies', 'Eddies', '64 of 1,240 files'],
      ['linked:threads', 'Threads', '0 of 1,240 files'],
    ] as const;
    rows.forEach(([stage, label, count], index) => {
      expect(screen.getByTestId(`corpus-stage-label-${String(index)}`)).toHaveTextContent(label);
      expect(screen.getByTestId(`corpus-stage-count-${String(index)}`)).toHaveTextContent(count);
      expect(STAGE_TOKENS[index]).toBe(stage);
    });
    expect(screen.queryByTestId('corpus-stage-label-7')).toBeNull();

    const section = textOf(screen);
    for (const line of section) {
      for (const token of ['praxis_scanned', 'linked:', 'ingested', 'unsupported_source']) {
        expect(line).not.toContain(token);
      }
      expect(line).not.toMatch(PRESSURE);
    }
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  test('a finished stage carries the tick; one that left files says so on its row', async () => {
    mockPipeline.mockResolvedValue(populatedAnswer());
    const screen = await renderScreen();
    await screen.findByTestId('corpus-totals-stages');

    expect(screen.getByTestId('corpus-stage-done-0')).toHaveTextContent('✓');
    expect(screen.getByTestId('corpus-stage-done-2')).toHaveTextContent('✓');
    for (const unfinished of [1, 3, 4, 5, 6]) {
      expect(screen.queryByTestId(`corpus-stage-done-${String(unfinished)}`)).toBeNull();
    }
    expect(screen.getByTestId('corpus-stage-left-1')).toHaveTextContent('60 partly done');
    expect(screen.getByTestId('corpus-stage-left-3')).toHaveTextContent("3 didn't finish");
    expect(screen.getByTestId('corpus-stage-left-4')).toHaveTextContent(
      "12 partly done · 2 didn't finish",
    );
    for (const quiet of [0, 2, 5, 6]) {
      expect(screen.queryByTestId(`corpus-stage-left-${String(quiet)}`)).toBeNull();
    }
    expect(screen.getByTestId('corpus-stage-1')).toHaveTextContent(
      /Classified.*1,180 of 1,240 files.*60 partly done/u,
    );
  });

  test('every count is in tabular numerals and its column is right-aligned', async () => {
    mockPipeline.mockResolvedValue(populatedAnswer());
    const screen = await renderScreen();
    await screen.findByTestId('corpus-totals-stages');

    for (const id of ['corpus-totals-sent', 'corpus-totals-not-landed', 'corpus-stage-left-1']) {
      expect(screen.getByTestId(id)).toHaveStyle({ fontVariant: ['tabular-nums'] });
    }
    for (const index of STAGE_TOKENS.keys()) {
      expect(screen.getByTestId(`corpus-stage-count-${String(index)}`)).toHaveStyle({
        fontVariant: ['tabular-nums'],
        textAlign: 'right',
      });
    }
  });

  test('an older image shows the sent line and the update notice in place of the stages', async () => {
    mockPipeline.mockResolvedValue(populatedAnswer({ vault: VAULT_SNAPSHOT }));
    const screen = await renderScreen();

    expect(await screen.findByTestId('corpus-totals-sent')).toHaveTextContent(
      '1,240 of 1,243 files landed',
    );
    expect(screen.getByTestId('corpus-totals-update-needed')).toHaveTextContent(
      VAULT_UPDATE_NEEDED,
    );
    expect(screen.queryByTestId('corpus-totals-stages')).toBeNull();
    expect(screen.getByTestId('vault-dashboard-shape')).toBeTruthy();
  });

  test.each([
    ['unreachable', true, 'vault-dashboard-unreachable'],
    ['not_connected', false, 'vault-dashboard-not-connected'],
    ['update_needed', false, 'vault-dashboard-update-needed'],
  ] as const)(
    'a vault that is %s still shows the sent line, and its own notice once',
    async (status, unreachable, notice) => {
      mockPipeline.mockResolvedValue(
        populatedAnswer({ vault: null, vault_status: status, vault_unreachable: unreachable }),
      );
      const screen = await renderScreen();

      expect(await screen.findByTestId('corpus-totals-sent')).toHaveTextContent(
        '1,240 of 1,243 files landed',
      );
      expect(screen.getByTestId(notice)).toBeTruthy();
      expect(screen.queryByTestId('corpus-totals-stages')).toBeNull();
      expect(screen.queryByTestId('corpus-totals-update-needed')).toBeNull();
    },
  );

  test('an account that has sent nothing says so, without "0 of 0"', async () => {
    mockPipeline.mockResolvedValue(
      pipelineAnswer({
        recent_uploads: [],
        totals: { sent: { ...SENT_TOTALS, accepted: 0, unsupported_source: 0 } },
        vault: { ...VAULT_SNAPSHOT, stage_totals: { ...STAGE_TOTALS, documents: 0 } },
      }),
    );
    const screen = await renderScreen();

    expect(await screen.findByTestId('corpus-totals-sent')).toHaveTextContent(
      CORPUS_TOTALS_NOTHING_SENT,
    );
    expect(screen.queryByTestId('corpus-totals-stages')).toBeNull();
    expect(screen.queryByText(CORPUS_TOTALS_NONE_WORKED)).toBeNull();
    expect(screen.queryByText(/0 of 0/u)).toBeNull();
  });

  test('files that landed but are not counted yet say so instead of "0 of 0"', async () => {
    mockPipeline.mockResolvedValue(
      populatedAnswer({
        vault: { ...VAULT_SNAPSHOT, stage_totals: { ...STAGE_TOTALS, documents: 0 } },
      }),
    );
    const screen = await renderScreen();

    expect(await screen.findByText(CORPUS_TOTALS_NONE_WORKED)).toBeTruthy();
    expect(screen.queryByTestId('corpus-totals-stages')).toBeNull();
  });

  test('the counts move on the existing poll while a pass is going', async () => {
    jest.useFakeTimers();
    const going = [stageRun({ outcome: 'attempted' })];
    const moved = {
      ...STAGE_TOTALS,
      stages: STAGE_TOTALS.stages.map((row) =>
        row.stage === 'classified' ? { ...row, covered: 1240, partial: 0 } : row,
      ),
    };
    mockPipeline
      .mockResolvedValueOnce(populatedAnswer({ stage_runs: going }))
      .mockResolvedValueOnce(
        populatedAnswer({ vault: { ...VAULT_SNAPSHOT, stage_totals: moved } }),
      );
    const screen = await renderScreen();
    expect(await screen.findByTestId('corpus-stage-count-1')).toHaveTextContent(
      '1,180 of 1,240 files',
    );

    await act(async () => {
      jest.advanceTimersByTime(VAULT_DASHBOARD_POLL_INTERVAL_MS);
    });
    await waitFor(() =>
      expect(screen.getByTestId('corpus-stage-count-1')).toHaveTextContent('1,240 of 1,240 files'),
    );
    expect(screen.getByTestId('corpus-stage-done-1')).toHaveTextContent('✓');
    expect(screen.queryByTestId('corpus-stage-left-1')).toBeNull();
  });
});
