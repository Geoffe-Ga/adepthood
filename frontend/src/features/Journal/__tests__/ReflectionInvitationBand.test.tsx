/* eslint-env jest */
// RED: `ReflectionInvitationBand` does not exist yet -- `require('../ReflectionInvitationBand')`
// throws until the implementation-specialist adds it (self-contained, like
// `ReturnStack`/`InvitationStack`: no props, fetches its own due-reflection state).
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { ReflectionDue, Stage } from '@/api';

const mockDue = jest.fn() as jest.MockedFunction<() => Promise<{ due: ReflectionDue | null }>>;
const mockStagesListAll = jest.fn() as jest.MockedFunction<() => Promise<Stage[]>>;
const mockLoadDismissed = jest.fn() as jest.MockedFunction<(_k: string) => Promise<boolean>>;
const mockSaveDismissed = jest.fn() as jest.MockedFunction<
  (_k: string, _v: boolean) => Promise<void>
>;
const mockNavigate = jest.fn();

jest.mock('@/api', () => ({
  reflections: {
    due: (...a: unknown[]) => (mockDue as unknown as (...x: unknown[]) => unknown)(...a),
  },
  stages: {
    listAll: (...a: unknown[]) =>
      (mockStagesListAll as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

jest.mock('@/storage/reflectionDismissalStorage', () => ({
  loadReflectionDismissed: (...a: unknown[]) =>
    (mockLoadDismissed as unknown as (...x: unknown[]) => unknown)(...a),
  saveReflectionDismissed: (...a: unknown[]) =>
    (mockSaveDismissed as unknown as (...x: unknown[]) => unknown)(...a),
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

const ReflectionInvitationBand = require('../ReflectionInvitationBand').default;

function due(overrides: Partial<ReflectionDue> = {}): ReflectionDue {
  return {
    level: 'week',
    scope_key: 'c1:w14',
    window_start: '2026-07-01T00:00:00Z',
    window_end: '2026-07-08T00:00:00Z',
    existing_entry_id: null,
    ...overrides,
  };
}

function stage(overrides: Partial<Stage> = {}): Stage {
  return {
    id: 1,
    title: 'Survival',
    subtitle: 'Beige',
    stage_number: 1,
    overview_url: 'https://example.com',
    category: 'foundation',
    aspect: 'body',
    spiral_dynamics_color: 'Beige',
    growing_up_stage: 'Archaic',
    divine_gender_polarity: 'neutral',
    relationship_to_free_will: 'reactive',
    free_will_description: 'Instinctual survival',
    is_unlocked: true,
    progress: 1,
    ...overrides,
  };
}

beforeEach(() => {
  mockDue.mockReset();
  mockStagesListAll.mockReset();
  mockLoadDismissed.mockReset();
  mockSaveDismissed.mockReset();
  mockNavigate.mockReset();
  mockDue.mockResolvedValue({ due: due() });
  mockStagesListAll.mockResolvedValue([stage()]);
  mockLoadDismissed.mockResolvedValue(false);
  mockSaveDismissed.mockResolvedValue(undefined);
});

describe('ReflectionInvitationBand', () => {
  it('renders the band with level-appropriate copy when a reflection is due', async () => {
    const { findByTestId, getByTestId } = render(<ReflectionInvitationBand />);
    const band = await findByTestId('journal-reflection-band');
    expect(band).toBeTruthy();
    expect(getByTestId('journal-reflection-band')).toBeTruthy();
  });

  it('shows the stage title alongside stage-level copy', async () => {
    mockDue.mockResolvedValue({ due: due({ level: 'stage', scope_key: 'c1:s1' }) });
    const { findByText } = render(<ReflectionInvitationBand />);
    expect(await findByText(/Stage Reflection/)).toBeTruthy();
    expect(await findByText(/Survival/)).toBeTruthy();
  });

  it('renders nothing when nothing is due', async () => {
    mockDue.mockResolvedValue({ due: null });
    const { queryByTestId } = render(<ReflectionInvitationBand />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(queryByTestId('journal-reflection-band')).toBeNull();
  });

  it('renders nothing when a dismissal is already stored for this scope key', async () => {
    mockLoadDismissed.mockResolvedValue(true);
    const { queryByTestId } = render(<ReflectionInvitationBand />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(queryByTestId('journal-reflection-band')).toBeNull();
  });

  it('renders quietly hidden when the due lookup rejects, without crashing', async () => {
    mockDue.mockRejectedValue(new Error('network down'));
    const { queryByTestId } = render(<ReflectionInvitationBand />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(queryByTestId('journal-reflection-band')).toBeNull();
  });

  it('dismissing persists the scope key and hides the band, with no nag/streak copy', async () => {
    const { findByTestId, getByTestId, queryByTestId, queryByText } = render(
      <ReflectionInvitationBand />,
    );
    await findByTestId('journal-reflection-band');
    expect(queryByText(/streak/i)).toBeNull();
    expect(queryByText(/don't break/i)).toBeNull();

    await act(async () => {
      fireEvent.press(getByTestId('journal-reflection-dismiss'));
    });

    expect(mockSaveDismissed).toHaveBeenCalledWith('c1:w14', true);
    await waitFor(() => expect(queryByTestId('journal-reflection-band')).toBeNull());
  });

  it('resurfaces for a new scope key even after a prior scope key was dismissed', async () => {
    mockLoadDismissed.mockImplementation((key: string) => Promise.resolve(key === 'c1:w14'));
    mockDue.mockResolvedValue({ due: due({ scope_key: 'c1:w15' }) });

    const { findByTestId } = render(<ReflectionInvitationBand />);
    expect(await findByTestId('journal-reflection-band')).toBeTruthy();
  });

  it('shows a Continue affordance and navigates with the existing entryId when one is in progress', async () => {
    mockDue.mockResolvedValue({ due: due({ existing_entry_id: 99 }) });
    const { findByTestId, getByTestId } = render(<ReflectionInvitationBand />);
    await findByTestId('journal-reflection-band');
    expect(getByTestId('journal-reflection-band').props.accessibilityLabel).toMatch(/continue/i);

    fireEvent.press(getByTestId('journal-reflection-band'));
    expect(mockNavigate).toHaveBeenCalledWith('JournalEntry', { entryId: 99 });
  });

  it('navigates a fresh reflection with the level/scope/prefillTitle params, not weekNumber', async () => {
    const { findByTestId, getByTestId } = render(<ReflectionInvitationBand />);
    await findByTestId('journal-reflection-band');

    fireEvent.press(getByTestId('journal-reflection-band'));

    expect(mockNavigate).toHaveBeenCalledWith(
      'JournalEntry',
      expect.objectContaining({
        reflectionLevel: 'week',
        reflectionScopeKey: 'c1:w14',
        prefillTitle: 'Week 14 Reflection',
      }),
    );
    const [, params] = mockNavigate.mock.calls[0] as [string, Record<string, unknown>];
    expect(params).not.toHaveProperty('weekNumber');
  });
});
