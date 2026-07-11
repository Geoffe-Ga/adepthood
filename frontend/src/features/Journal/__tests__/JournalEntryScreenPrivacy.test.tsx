/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';

/**
 * Verifies the privacy classification wiring in ``JournalEntryScreen``:
 * ``PrivacyTierControl`` is mounted in the writing column, the chosen
 * classification persists through autosave / create / update, and resonance is
 * gated off for intimate entries.
 */
import type { JournalMessage, ResonanceResponse } from '@/api';
import { DEFAULT_IDLE_DELAY_MS } from '@/hooks/useIdle';

// ---------------------------------------------------------------------------
// API mock — mirrors JournalEntryScreen.test.tsx / JournalEntryScreenCare.test.tsx
// ---------------------------------------------------------------------------

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockCreate = jest.fn() as jest.MockedFunction<(_e: unknown) => Promise<JournalMessage>>;
const mockUpdate = jest.fn() as jest.MockedFunction<
  (_id: number, _p: unknown) => Promise<JournalMessage>
>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;
const mockGenerate = jest.fn() as jest.MockedFunction<(_id: number) => Promise<ResonanceResponse>>;
const mockRespond = jest.fn() as jest.MockedFunction<(_w: number, _b: string) => Promise<unknown>>;

jest.mock('@/api', () => ({
  journal: {
    get: (...a: unknown[]) => (mockGet as unknown as (...x: unknown[]) => unknown)(...a),
    create: (...a: unknown[]) => (mockCreate as unknown as (...x: unknown[]) => unknown)(...a),
    update: (...a: unknown[]) => (mockUpdate as unknown as (...x: unknown[]) => unknown)(...a),
  },
  prompts: {
    respond: (...a: unknown[]) => (mockRespond as unknown as (...x: unknown[]) => unknown)(...a),
  },
  resonance: {
    list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
    generate: (...a: unknown[]) => (mockGenerate as unknown as (...x: unknown[]) => unknown)(...a),
  },
  completionSuggestions: {
    list: jest.fn(() => Promise.resolve({ items: [] })),
    accept: jest.fn(),
    dismiss: jest.fn(),
  },
}));

jest.mock('@/navigation/hooks', () => ({
  ...(jest.requireActual('@/navigation/hooks') as Record<string, unknown>),
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
}));

const JournalEntryScreen = require('../JournalEntryScreen').default;

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/** ``classification`` is not yet on the TS type — added by #896 implementation. */
type EntryOverrides = Partial<JournalMessage> & {
  classification?: 'public' | 'personal' | 'intimate';
};

function entry(overrides: EntryOverrides = {}): JournalMessage {
  return {
    id: 7,
    message: 'A page about rivers.',
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'freeform' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: 'Rivers',
    status: 'draft',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  } as JournalMessage;
}

function resonancePayload(overrides: Partial<ResonanceResponse> = {}): ResonanceResponse {
  return {
    marginalia: [],
    suggestions: [],
    remaining_messages: 48,
    remaining_balance: 0,
    monthly_reset_date: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

function renderScreen(
  params?: {
    entryId?: number;
    weekNumber?: number;
    promptQuestion?: string;
    prefillTitle?: string;
    practiceSessionId?: number;
  },
  extraProps: Record<string, unknown> = {},
) {
  const route = { key: 'k', name: 'JournalEntry' as const, params };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return {
    ...render(<Screen navigation={navigation} route={route} {...extraProps} />),
    navigation,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGet.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockCreate.mockResolvedValue(entry({ id: 42 }));
  mockUpdate.mockResolvedValue(entry({ id: 42 }));
  mockList.mockReset();
  mockList.mockResolvedValue({ items: [] });
  mockGenerate.mockReset();
  mockRespond.mockReset();
  mockRespond.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// 1. Control renders; default is personal
// ---------------------------------------------------------------------------

describe('JournalEntryScreen — privacy tier control renders (#896)', () => {
  it('renders the PrivacyTierControl inside the writing column', () => {
    const { getByTestId } = renderScreen();
    // The writing column hosts the control; query by containment.
    expect(within(getByTestId('journal-page')).getByTestId('privacy-tier-personal')).toBeTruthy();
  });

  it('defaults to personal (backend default) on a fresh entry', () => {
    const { getByTestId } = renderScreen();
    const personal = within(getByTestId('journal-page')).getByTestId('privacy-tier-personal');
    expect(personal.props.accessibilityState.selected).toBe(true);
  });

  it('all three tier options are present on a fresh entry', () => {
    const { getByTestId } = renderScreen();
    const page = getByTestId('journal-page');
    expect(within(page).getByTestId('privacy-tier-public')).toBeTruthy();
    expect(within(page).getByTestId('privacy-tier-personal')).toBeTruthy();
    expect(within(page).getByTestId('privacy-tier-intimate')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 2a. Persistence — existing entry PATCH
// ---------------------------------------------------------------------------

describe('JournalEntryScreen — tier persists via PATCH on existing entry (#896)', () => {
  it('PATCHes classification when the tier changes on an existing entry', async () => {
    jest.useFakeTimers();
    try {
      mockGet.mockResolvedValue(entry({ id: 7, classification: 'personal' }));
      const { getByTestId } = renderScreen({ entryId: 7 }, { autosaveDelayMs: 100 });
      await waitFor(() => {
        expect(getByTestId('journal-body-input').props.value).toBeTruthy();
      });
      mockUpdate.mockClear();

      fireEvent.press(within(getByTestId('journal-page')).getByTestId('privacy-tier-intimate'));

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockUpdate).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ classification: 'intimate' }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('PATCHes classification="public" when the public tier is chosen', async () => {
    jest.useFakeTimers();
    try {
      mockGet.mockResolvedValue(entry({ id: 7, classification: 'personal' }));
      const { getByTestId } = renderScreen({ entryId: 7 }, { autosaveDelayMs: 100 });
      await waitFor(() => {
        expect(getByTestId('journal-body-input').props.value).toBeTruthy();
      });
      mockUpdate.mockClear();

      fireEvent.press(within(getByTestId('journal-page')).getByTestId('privacy-tier-public'));

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockUpdate).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ classification: 'public' }),
      );
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 2b. Persistence — new entry create carries classification
// ---------------------------------------------------------------------------

describe('JournalEntryScreen — classification on first create (#896)', () => {
  it('creates with classification="intimate" when intimate is chosen before first save', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });

      // Choose intimate before writing anything.
      fireEvent.press(within(getByTestId('journal-page')).getByTestId('privacy-tier-intimate'));
      // Now type to trigger the autosave.
      fireEvent.changeText(getByTestId('journal-body-input'), 'An intimate reflection.');

      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ classification: 'intimate' }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('creates with classification="personal" by default (no tier change)', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });
      fireEvent.changeText(getByTestId('journal-body-input'), 'A personal reflection.');

      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ classification: 'personal' }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('creates with classification="public" when public is chosen first', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });

      fireEvent.press(within(getByTestId('journal-page')).getByTestId('privacy-tier-public'));
      fireEvent.changeText(getByTestId('journal-body-input'), 'A public reflection.');

      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ classification: 'public' }),
      );
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 2c. Persistence — PATCH failure surfaces the error and reverts the selection
// ---------------------------------------------------------------------------

describe('JournalEntryScreen — tier change PATCH failure', () => {
  it('surfaces the save-error hint and reverts to the persisted tier when the PATCH rejects', async () => {
    jest.useFakeTimers();
    try {
      mockGet.mockResolvedValue(entry({ id: 7, classification: 'personal' }));
      const { getByTestId } = renderScreen({ entryId: 7 }, { autosaveDelayMs: 100 });
      await waitFor(() => {
        expect(getByTestId('journal-body-input').props.value).toBeTruthy();
      });
      mockUpdate.mockClear();
      mockUpdate.mockRejectedValueOnce(new Error('network'));

      fireEvent.press(within(getByTestId('journal-page')).getByTestId('privacy-tier-intimate'));

      await act(async () => {
        await Promise.resolve();
      });

      expect(getByTestId('journal-save-hint').props.children).toBe(
        "Couldn't save — keep writing, we'll retry",
      );
      const page = within(getByTestId('journal-page'));
      expect(page.getByTestId('privacy-tier-personal').props.accessibilityState.selected).toBe(
        true,
      );
      expect(page.getByTestId('privacy-tier-intimate').props.accessibilityState.selected).toBe(
        false,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('reverts to the loaded non-default tier (not the module default) when the PATCH rejects', async () => {
    jest.useFakeTimers();
    try {
      // Loaded as intimate — a failed re-tag must fall back to the persisted
      // intimate, never the personal default (which would read as less private).
      mockGet.mockResolvedValue(entry({ id: 7, classification: 'intimate' }));
      const { getByTestId } = renderScreen({ entryId: 7 }, { autosaveDelayMs: 100 });
      await waitFor(() => {
        expect(getByTestId('journal-body-input').props.value).toBeTruthy();
      });
      mockUpdate.mockClear();
      mockUpdate.mockRejectedValueOnce(new Error('network'));

      fireEvent.press(within(getByTestId('journal-page')).getByTestId('privacy-tier-public'));

      await act(async () => {
        await Promise.resolve();
      });

      const page = within(getByTestId('journal-page'));
      expect(page.getByTestId('privacy-tier-intimate').props.accessibilityState.selected).toBe(
        true,
      );
      expect(page.getByTestId('privacy-tier-personal').props.accessibilityState.selected).toBe(
        false,
      );
      expect(page.getByTestId('privacy-tier-public').props.accessibilityState.selected).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the new tier selected with no error hint when the PATCH succeeds', async () => {
    jest.useFakeTimers();
    try {
      mockGet.mockResolvedValue(entry({ id: 7, classification: 'personal' }));
      const { getByTestId } = renderScreen({ entryId: 7 }, { autosaveDelayMs: 100 });
      await waitFor(() => {
        expect(getByTestId('journal-body-input').props.value).toBeTruthy();
      });
      mockUpdate.mockClear();

      fireEvent.press(within(getByTestId('journal-page')).getByTestId('privacy-tier-intimate'));

      await act(async () => {
        await Promise.resolve();
      });

      expect(
        within(getByTestId('journal-page')).getByTestId('privacy-tier-intimate').props
          .accessibilityState.selected,
      ).toBe(true);
      expect(getByTestId('journal-save-hint').props.children).not.toBe(
        "Couldn't save — keep writing, we'll retry",
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not revert a superseding change when the earlier PATCH rejects', async () => {
    jest.useFakeTimers();
    try {
      mockGet.mockResolvedValue(entry({ id: 7, classification: 'personal' }));
      const { getByTestId } = renderScreen({ entryId: 7 }, { autosaveDelayMs: 100 });
      await waitFor(() => {
        expect(getByTestId('journal-body-input').props.value).toBeTruthy();
      });
      mockUpdate.mockClear();
      // First PATCH (intimate) rejects; the superseding one (public) resolves.
      mockUpdate.mockRejectedValueOnce(new Error('network'));

      const page = within(getByTestId('journal-page'));
      fireEvent.press(page.getByTestId('privacy-tier-intimate'));
      fireEvent.press(page.getByTestId('privacy-tier-public'));

      await act(async () => {
        await Promise.resolve();
      });

      expect(page.getByTestId('privacy-tier-public').props.accessibilityState.selected).toBe(true);
      expect(page.getByTestId('privacy-tier-personal').props.accessibilityState.selected).toBe(
        false,
      );
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Load reflects server value
// ---------------------------------------------------------------------------

describe('JournalEntryScreen — loads server classification into the control (#896)', () => {
  it('pre-selects intimate when the loaded entry has classification="intimate"', async () => {
    mockGet.mockResolvedValue(entry({ id: 7, classification: 'intimate' }));
    const { getByTestId } = renderScreen({ entryId: 7 });

    await waitFor(() => {
      const intimate = within(getByTestId('journal-page')).getByTestId('privacy-tier-intimate');
      expect(intimate.props.accessibilityState.selected).toBe(true);
    });
  });

  it('pre-selects public when the loaded entry has classification="public"', async () => {
    mockGet.mockResolvedValue(entry({ id: 7, classification: 'public' }));
    const { getByTestId } = renderScreen({ entryId: 7 });

    await waitFor(() => {
      const pub = within(getByTestId('journal-page')).getByTestId('privacy-tier-public');
      expect(pub.props.accessibilityState.selected).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Intimate explainer shown in the editor
// ---------------------------------------------------------------------------

describe('JournalEntryScreen — intimate explainer in the writing column (#896)', () => {
  it('shows the explainer after choosing intimate', () => {
    const { getByTestId } = renderScreen();
    fireEvent.press(within(getByTestId('journal-page')).getByTestId('privacy-tier-intimate'));
    expect(within(getByTestId('journal-page')).getByTestId('privacy-tier-explainer')).toBeTruthy();
  });

  it('hides the explainer when personal is selected', () => {
    const { queryByTestId } = renderScreen();
    // Default is personal; explainer should not be present.
    expect(queryByTestId('privacy-tier-explainer')).toBeNull();
  });

  it('hides the explainer after switching back from intimate to personal', () => {
    const { getByTestId, queryByTestId } = renderScreen();
    const page = getByTestId('journal-page');

    fireEvent.press(within(page).getByTestId('privacy-tier-intimate'));
    expect(within(page).getByTestId('privacy-tier-explainer')).toBeTruthy();

    fireEvent.press(within(page).getByTestId('privacy-tier-personal'));
    expect(queryByTestId('privacy-tier-explainer')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Resonance disabled with a visible reason for intimate entries
// ---------------------------------------------------------------------------

describe('JournalEntryScreen — resonance disabled for intimate entries (#896)', () => {
  it('shows resonance button disabled (not hidden) when classification=intimate after idle', async () => {
    jest.useFakeTimers();
    try {
      mockCreate.mockResolvedValue(entry({ id: 42, classification: 'intimate' }));

      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });

      // Choose intimate before typing.
      fireEvent.press(within(getByTestId('journal-page')).getByTestId('privacy-tier-intimate'));
      fireEvent.changeText(getByTestId('journal-body-input'), 'An intimate page.');

      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(DEFAULT_IDLE_DELAY_MS);
      });

      // Button must be PRESENT but DISABLED (not hidden).
      const btn = getByTestId('get-resonance-button');
      expect(btn).toBeTruthy();
      expect(btn.props.accessibilityState.disabled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows a visible reason text when resonance is disabled for intimate', async () => {
    jest.useFakeTimers();
    try {
      mockCreate.mockResolvedValue(entry({ id: 42, classification: 'intimate' }));

      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });

      fireEvent.press(within(getByTestId('journal-page')).getByTestId('privacy-tier-intimate'));
      fireEvent.changeText(getByTestId('journal-body-input'), 'An intimate page.');

      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(DEFAULT_IDLE_DELAY_MS);
      });

      expect(getByTestId('privacy-resonance-reason')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does NOT call resonance.generate when the disabled intimate button is tapped', async () => {
    jest.useFakeTimers();
    try {
      mockCreate.mockResolvedValue(entry({ id: 42, classification: 'intimate' }));

      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });

      fireEvent.press(within(getByTestId('journal-page')).getByTestId('privacy-tier-intimate'));
      fireEvent.changeText(getByTestId('journal-body-input'), 'An intimate page.');

      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(DEFAULT_IDLE_DELAY_MS);
      });

      fireEvent.press(getByTestId('get-resonance-button'));

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockGenerate).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('leaves resonance enabled for personal entries after idle', async () => {
    jest.useFakeTimers();
    try {
      mockCreate.mockResolvedValue(entry({ id: 42 }));
      mockGenerate.mockResolvedValue(resonancePayload());

      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });
      fireEvent.changeText(getByTestId('journal-body-input'), 'A personal page.');

      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(DEFAULT_IDLE_DELAY_MS);
      });

      const btn = getByTestId('get-resonance-button');
      expect(btn.props.accessibilityState.disabled).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('leaves resonance enabled for public entries after idle', async () => {
    jest.useFakeTimers();
    try {
      mockCreate.mockResolvedValue(entry({ id: 42 }));
      mockGenerate.mockResolvedValue(resonancePayload());

      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });

      fireEvent.press(within(getByTestId('journal-page')).getByTestId('privacy-tier-public'));
      fireEvent.changeText(getByTestId('journal-body-input'), 'A public page.');

      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(DEFAULT_IDLE_DELAY_MS);
      });

      const btn = getByTestId('get-resonance-button');
      expect(btn.props.accessibilityState.disabled).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Accessibility — control within the screen-level tree
// ---------------------------------------------------------------------------

describe('JournalEntryScreen — privacy control a11y (#896)', () => {
  it('all three tier touchables are inside journal-screen', () => {
    const { getByTestId } = renderScreen();
    const screen = getByTestId('journal-screen');
    expect(within(screen).getByTestId('privacy-tier-public')).toBeTruthy();
    expect(within(screen).getByTestId('privacy-tier-personal')).toBeTruthy();
    expect(within(screen).getByTestId('privacy-tier-intimate')).toBeTruthy();
  });

  it('the resonance reason text is inside journal-screen when intimate is active', async () => {
    jest.useFakeTimers();
    try {
      mockCreate.mockResolvedValue(entry({ id: 42, classification: 'intimate' }));
      const { getByTestId } = renderScreen(undefined, { autosaveDelayMs: 100 });

      fireEvent.press(within(getByTestId('journal-page')).getByTestId('privacy-tier-intimate'));
      fireEvent.changeText(getByTestId('journal-body-input'), 'An intimate page.');

      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(DEFAULT_IDLE_DELAY_MS);
      });

      expect(
        within(getByTestId('journal-screen')).getByTestId('privacy-resonance-reason'),
      ).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });
});
