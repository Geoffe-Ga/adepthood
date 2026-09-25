/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import { PICKER_EMPTY, PICKER_UNAVAILABLE } from '../reviewInvitationCopy';
import ReviewScopePicker from '../ReviewScopePicker';

import type { ReflectionCurrentScope, Stage } from '@/api';

const mockCurrent = jest.fn() as jest.MockedFunction<
  () => Promise<{ scopes: ReflectionCurrentScope[] }>
>;
const mockStagesListAll = jest.fn() as jest.MockedFunction<() => Promise<Stage[]>>;

jest.mock('@/api', () => ({
  reflections: {
    current: (...a: unknown[]) => (mockCurrent as unknown as (...x: unknown[]) => unknown)(...a),
  },
  stages: {
    listAll: (...a: unknown[]) =>
      (mockStagesListAll as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

function scope(overrides: Partial<ReflectionCurrentScope> = {}): ReflectionCurrentScope {
  return {
    level: 'week',
    scope_key: 'c1:w2',
    window_start: '2026-07-08T00:00:00Z',
    window_end: '2026-07-15T00:00:00Z',
    existing_entry_id: null,
    ...overrides,
  };
}

/** Program day 9, delivered out of order so the picker's own ordering is what is tested. */
const DAY_NINE_SHUFFLED = [
  scope({ level: 'course', scope_key: 'c1:course' }),
  scope({ level: 'section', scope_key: 'c1:x1' }),
  scope(),
  scope({ level: 'stage', scope_key: 'c1:s1' }),
];

const SURVIVAL: Stage = {
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
};

const ROW_IDS = [
  'journal-review-scope-week',
  'journal-review-scope-stage',
  'journal-review-scope-section',
  'journal-review-scope-course',
];

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  mockCurrent.mockReset();
  mockStagesListAll.mockReset();
  mockCurrent.mockResolvedValue({ scopes: DAY_NINE_SHUFFLED });
  mockStagesListAll.mockResolvedValue([SURVIVAL]);
});

describe('ReviewScopePicker', () => {
  it('lists every open scope narrowest first, in the program’s own titles', async () => {
    const onChoose = jest.fn();
    const { findByTestId, getAllByRole } = render(
      <ReviewScopePicker enabled onChoose={onChoose} />,
    );
    await findByTestId('journal-review-scope-course');

    const rows = getAllByRole('button');
    expect(rows.map((row) => row.props.testID)).toEqual(ROW_IDS);
    expect(rows.map((row) => row.props.accessibilityLabel)).toEqual([
      'Begin your Weekly Review — Week 2',
      'Begin your Stage Review — Survival',
      'Begin your Section Review — Red',
      'Begin your Course Review',
    ]);
    expect(mockStagesListAll).toHaveBeenCalledTimes(1);
  });

  it('omits the section while the section-less final stage runs', async () => {
    mockCurrent.mockResolvedValue({
      scopes: [
        scope({ scope_key: 'c1:w31' }),
        scope({ level: 'stage', scope_key: 'c1:s10' }),
        scope({ level: 'course', scope_key: 'c1:course' }),
      ],
    });
    const { findByTestId, queryByTestId } = render(
      <ReviewScopePicker enabled onChoose={jest.fn()} />,
    );
    await findByTestId('journal-review-scope-course');
    expect(queryByTestId('journal-review-scope-section')).toBeNull();
  });

  it('offers to continue a review already begun, and opens that entry', async () => {
    mockCurrent.mockResolvedValue({ scopes: [scope({ existing_entry_id: 31 })] });
    const onChoose = jest.fn();
    const { findByText, getByTestId } = render(<ReviewScopePicker enabled onChoose={onChoose} />);

    expect(await findByText('Continue — Weekly Review — Week 2')).toBeTruthy();
    expect(getByTestId('journal-review-scope-week').props.accessibilityLabel).toBe(
      'Continue your Weekly Review — Week 2',
    );
    fireEvent.press(getByTestId('journal-review-scope-week'));
    expect(onChoose).toHaveBeenCalledWith({ entryId: 31 });
  });

  it('begins a fresh review with its scope and titled page', async () => {
    const onChoose = jest.fn();
    const { findByTestId, getByTestId } = render(<ReviewScopePicker enabled onChoose={onChoose} />);
    await findByTestId('journal-review-scope-stage');

    fireEvent.press(getByTestId('journal-review-scope-stage'));

    expect(onChoose).toHaveBeenCalledWith({
      reflectionLevel: 'stage',
      reflectionScopeKey: 'c1:s1',
      prefillTitle: 'Stage Review — Survival',
    });
  });

  it('says so honestly, without throwing, when the open reviews cannot be reached', async () => {
    mockCurrent.mockRejectedValue(new Error('network down'));
    const { findByText, queryAllByRole } = render(
      <ReviewScopePicker enabled onChoose={jest.fn()} />,
    );
    expect(await findByText(PICKER_UNAVAILABLE)).toBeTruthy();
    expect(queryAllByRole('button')).toHaveLength(0);
  });

  it('says nothing is open yet for a writer whose program has not begun', async () => {
    mockCurrent.mockResolvedValue({ scopes: [] });
    const { findByText } = render(<ReviewScopePicker enabled onChoose={jest.fn()} />);
    expect(await findByText(PICKER_EMPTY)).toBeTruthy();
  });

  it('fetches nothing and renders nothing until it is opened', async () => {
    const { toJSON } = render(<ReviewScopePicker enabled={false} onChoose={jest.fn()} />);
    await settle();
    expect(mockCurrent).not.toHaveBeenCalled();
    expect(toJSON()).toBeNull();
  });
});
