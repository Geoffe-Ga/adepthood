/* eslint-env jest */
/**
 * The shelf's one primary writing invitation (issue #2867): on a review day an
 * undismissed review is THE call to write, otherwise the daily page is, and
 * the quiet "Start a review early" link is always beneath either.
 *
 * Retargeted from the old self-contained ``ReflectionInvitationBand`` suite:
 * the band is now a presentational card this component chooses, so every
 * behaviour it used to own (level copy, resume, per-scope dismissal, quiet
 * failure) is asserted here through the component that decides.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { morningPageTitle } from '../morningPagesCopy';

import type { ReflectionCurrentScope, ReflectionDue, ReflectionLevel, Stage } from '@/api';
import { uiType } from '@/design/tokens';
import { todayInUserTZ } from '@/utils/dateUtils';

const mockDue = jest.fn() as jest.MockedFunction<() => Promise<{ due: ReflectionDue | null }>>;
const mockCurrent = jest.fn() as jest.MockedFunction<
  () => Promise<{ scopes: ReflectionCurrentScope[] }>
>;
const mockStagesListAll = jest.fn() as jest.MockedFunction<() => Promise<Stage[]>>;
const mockLoadDismissed = jest.fn() as jest.MockedFunction<(_k: string) => Promise<boolean>>;
const mockSaveDismissed = jest.fn() as jest.MockedFunction<
  (_k: string, _v: boolean) => Promise<void>
>;
const mockLoadTipDismissed = jest.fn() as jest.MockedFunction<() => Promise<boolean>>;
const mockSaveTipDismissed = jest.fn() as jest.MockedFunction<(_v: boolean) => Promise<void>>;
const mockNavigate = jest.fn();
const mockOnBeginPage = jest.fn();
const USER_TIMEZONE = 'America/New_York';

jest.mock('@/api', () => ({
  reflections: {
    due: (...a: unknown[]) => (mockDue as unknown as (...x: unknown[]) => unknown)(...a),
    current: (...a: unknown[]) => (mockCurrent as unknown as (...x: unknown[]) => unknown)(...a),
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

jest.mock('@/storage/morningPagesTipStorage', () => ({
  loadMorningPagesTipDismissed: (...a: unknown[]) =>
    (mockLoadTipDismissed as unknown as (...x: unknown[]) => unknown)(...a),
  saveMorningPagesTipDismissed: (...a: unknown[]) =>
    (mockSaveTipDismissed as unknown as (...x: unknown[]) => unknown)(...a),
}));

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ userTimezone: 'America/New_York' }),
}));

// Mount-only focus: this suite is about what one visit shows. Re-reading on a
// return to the shelf is JournalShelfScreenRefocus.test.tsx's business.
jest.mock('@react-navigation/native', () => {
  const react = jest.requireActual('react') as {
    useEffect: (_cb: () => undefined | (() => void), _deps: unknown[]) => void;
  };
  return {
    useNavigation: () => ({ navigate: mockNavigate }),
    useFocusEffect: (cb: () => undefined | (() => void)) => {
      react.useEffect(() => cb(), [cb]);
    },
  };
});

const JournalPrimaryInvitation = require('../JournalPrimaryInvitation').default;

function due(overrides: Partial<ReflectionDue> = {}): ReflectionDue {
  return {
    level: 'week',
    scope_key: 'c1:w1',
    window_start: '2026-07-01T00:00:00Z',
    window_end: '2026-07-08T00:00:00Z',
    existing_entry_id: null,
    ...overrides,
  };
}

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

function renderInvitation() {
  return render(<JournalPrimaryInvitation onBeginPage={mockOnBeginPage} />);
}

/** Let the due lookup, its dismissal read and the tip's own read all settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  for (const mock of [
    mockDue,
    mockCurrent,
    mockStagesListAll,
    mockLoadDismissed,
    mockSaveDismissed,
    mockLoadTipDismissed,
    mockSaveTipDismissed,
    mockNavigate,
    mockOnBeginPage,
  ]) {
    mock.mockReset();
  }
  mockDue.mockResolvedValue({ due: due() });
  mockCurrent.mockResolvedValue({ scopes: [] });
  mockStagesListAll.mockResolvedValue([SURVIVAL]);
  mockLoadDismissed.mockResolvedValue(false);
  mockSaveDismissed.mockResolvedValue(undefined);
  mockLoadTipDismissed.mockResolvedValue(false);
  mockSaveTipDismissed.mockResolvedValue(undefined);
});

describe('JournalPrimaryInvitation on a review day', () => {
  const levels: [ReflectionLevel, string, string, string][] = [
    ['week', 'c1:w14', 'Write your Weekly Review', 'Weekly Review — Week 14'],
    ['stage', 'c1:s1', 'Write your Stage Review', 'Stage Review — Survival'],
    ['section', 'c1:x2', 'Write your Section Review', 'Section Review — Green'],
    ['course', 'c1:course', 'Write your Course Review', 'Course Review'],
  ];
  it.each(levels)(
    'a due %s review is the call to write, and opens a fresh titled page',
    async (level, scopeKey, cta, title) => {
      mockDue.mockResolvedValue({ due: due({ level, scope_key: scopeKey }) });
      const { findByText, getByTestId, queryByTestId } = renderInvitation();

      expect(await findByText(cta)).toBeTruthy();
      expect(await findByText(title)).toBeTruthy();
      // One primary invitation: the daily page steps aside for the review.
      expect(queryByTestId('journal-morning-pages-tip')).toBeNull();
      expect(getByTestId('journal-reflection-band').props.accessibilityLabel).toBe(
        `${cta}, begin your ${title}`,
      );

      fireEvent.press(getByTestId('journal-reflection-band'));

      expect(mockNavigate).toHaveBeenCalledWith('JournalEntry', {
        reflectionLevel: level,
        reflectionScopeKey: scopeKey,
        prefillTitle: title,
      });
    },
  );

  it('continues a review already begun rather than starting a second one', async () => {
    mockDue.mockResolvedValue({ due: due({ existing_entry_id: 99 }) });
    const { findByTestId, getByTestId, getByText } = renderInvitation();
    await findByTestId('journal-reflection-band');
    expect(getByTestId('journal-reflection-band').props.accessibilityLabel).toBe(
      'Write your Weekly Review, continue your Weekly Review — Week 1',
    );
    expect(getByText('Pick up where you left off.')).toBeTruthy();

    fireEvent.press(getByTestId('journal-reflection-band'));
    expect(mockNavigate).toHaveBeenCalledWith('JournalEntry', { entryId: 99 });
  });

  it('shows the review even when the morning-pages tip was set aside', async () => {
    mockLoadTipDismissed.mockResolvedValue(true);
    const { findByText } = renderInvitation();
    expect(await findByText('Write your Weekly Review')).toBeTruthy();
  });

  it('falls back to the daily page, dated in the writer’s zone, when the review was set aside', async () => {
    mockLoadDismissed.mockImplementation((key: string) => Promise.resolve(key === 'c1:w1'));
    const { findByTestId, getByTestId, getByText, queryByTestId } = renderInvitation();
    await findByTestId('journal-morning-pages-tip');
    expect(queryByTestId('journal-reflection-band')).toBeNull();
    expect(getByText('Begin a page')).toBeTruthy();

    fireEvent.press(getByTestId('journal-morning-pages-tip'));

    const expected = morningPageTitle(todayInUserTZ(USER_TIMEZONE));
    expect(expected).toMatch(/^\d{4}-\d{2}-\d{2} Daily Journal$/);
    expect(mockOnBeginPage).toHaveBeenCalledWith(expected);
  });

  it('“Not now” sets aside this review’s scope only — never the morning-pages tip', async () => {
    const { findByTestId, getByTestId } = renderInvitation();
    await findByTestId('journal-reflection-band');

    await act(async () => {
      fireEvent.press(getByTestId('journal-reflection-dismiss'));
    });

    expect(mockSaveDismissed).toHaveBeenCalledWith('c1:w1', true);
    expect(mockSaveTipDismissed).not.toHaveBeenCalled();
    // Setting the review aside hands the primary slot back to the daily page.
    expect(await findByTestId('journal-morning-pages-tip')).toBeTruthy();
  });

  it('resurfaces for a new scope even after an earlier scope was set aside', async () => {
    mockLoadDismissed.mockImplementation((key: string) => Promise.resolve(key === 'c1:w1'));
    mockDue.mockResolvedValue({ due: due({ scope_key: 'c1:w2' }) });
    const { findByText } = renderInvitation();
    expect(await findByText('Write your Weekly Review')).toBeTruthy();
  });

  it('carries no streak or nag copy', async () => {
    const { findByTestId, queryByText } = renderInvitation();
    await findByTestId('journal-reflection-band');
    expect(queryByText(/streak/i)).toBeNull();
    expect(queryByText(/don't break/i)).toBeNull();
  });
});

describe('JournalPrimaryInvitation on any other day', () => {
  it('offers the daily page, with the early-review link beneath it', async () => {
    mockDue.mockResolvedValue({ due: null });
    const { findByTestId, getByText, getByTestId, queryByTestId } = renderInvitation();
    await findByTestId('journal-morning-pages-tip');
    expect(getByText('Begin a page')).toBeTruthy();
    expect(queryByTestId('journal-reflection-band')).toBeNull();
    expect(getByTestId('journal-review-early').props.accessibilityLabel).toBe(
      'Start a review early, choose one to begin before it comes round',
    );
  });

  it('still shows the daily page when the due lookup fails, and never throws', async () => {
    mockDue.mockRejectedValue(new Error('network down'));
    const { findByTestId, queryByTestId } = renderInvitation();
    expect(await findByTestId('journal-morning-pages-tip')).toBeTruthy();
    expect(queryByTestId('journal-reflection-band')).toBeNull();
  });
});

describe('the early-review link', () => {
  it('sits on the section edge in the button face, level with the set-aside count', async () => {
    mockDue.mockResolvedValue({ due: null });
    const { findByTestId, getByTestId } = renderInvitation();
    await findByTestId('journal-morning-pages-tip');
    const link = getByTestId('journal-review-early');

    // No self-indent and no side padding: the label starts where the eyebrow
    // above it starts. Button.base centres its label, so the row must be told
    // to lead from the left or the link would float mid-column.
    const control = StyleSheet.flatten(link.props.style);
    expect(control.alignSelf).toBeUndefined();
    expect(control.paddingHorizontal).toBe(0);
    expect(control.justifyContent).toBe('flex-start');

    const label = StyleSheet.flatten(within(link).getByText('Start a review early').props.style);
    expect(label.fontSize).toBe(uiType.button.fontSize);
    expect(label.fontWeight).toBe(uiType.button.fontWeight);
  });

  it('is present on a review day', async () => {
    const { findByTestId, getByTestId } = renderInvitation();
    await findByTestId('journal-reflection-band');
    expect(getByTestId('journal-review-early')).toBeTruthy();
  });

  it('is present when both the review and the tip have been set aside', async () => {
    mockLoadDismissed.mockResolvedValue(true);
    mockLoadTipDismissed.mockResolvedValue(true);
    const { getByTestId, queryByTestId } = renderInvitation();
    await settle();
    expect(queryByTestId('journal-reflection-band')).toBeNull();
    expect(queryByTestId('journal-morning-pages-tip')).toBeNull();
    expect(getByTestId('journal-review-early')).toBeTruthy();
  });

  it('shows no card at all while the due lookup is still out — so a tap cannot land on the wrong page', async () => {
    mockDue.mockReturnValue(new Promise(() => undefined));
    const { getByTestId, queryByTestId } = renderInvitation();
    await settle();
    expect(queryByTestId('journal-morning-pages-tip')).toBeNull();
    expect(queryByTestId('journal-reflection-band')).toBeNull();
    expect(getByTestId('journal-review-early')).toBeTruthy();
  });

  it('opens the picker and begins the chosen review early', async () => {
    mockDue.mockResolvedValue({ due: null });
    mockCurrent.mockResolvedValue({
      scopes: [
        { ...due({ scope_key: 'c1:w2' }) },
        { ...due({ level: 'course', scope_key: 'c1:course' }) },
      ],
    });
    const { findByTestId, getByTestId, queryByTestId } = renderInvitation();
    await findByTestId('journal-morning-pages-tip');
    expect(queryByTestId('journal-review-scope-week')).toBeNull();
    expect(mockCurrent).not.toHaveBeenCalled();

    fireEvent.press(getByTestId('journal-review-early'));
    await findByTestId('journal-review-scope-week');
    expect(getByTestId('journal-review-early').props.accessibilityLabel).toBe(
      'Fold the reviews away, close the list of reviews you could begin early',
    );

    fireEvent.press(getByTestId('journal-review-scope-week'));

    expect(mockNavigate).toHaveBeenCalledWith('JournalEntry', {
      reflectionLevel: 'week',
      reflectionScopeKey: 'c1:w2',
      prefillTitle: 'Weekly Review — Week 2',
    });
    // Choosing folds the list away, so a return to the shelf finds it closed.
    await waitFor(() => expect(queryByTestId('journal-review-scope-week')).toBeNull());
  });
});

/** A rendered host node, as RNTL's queries hand it back. */
type RenderedNode = ReturnType<ReturnType<typeof render>['getByTestId']>;

/** Every string a sighted reader sees inside a pressable, in render order. */
function visibleText(node: RenderedNode): string[] {
  return node
    .findAll((child: RenderedNode) => child.type === 'Text')
    .flatMap((text: RenderedNode) =>
      text.children.filter((c: RenderedNode | string): c is string => typeof c === 'string'),
    );
}

describe('every invitation control is named by the words it shows (WCAG 2.5.3)', () => {
  it.each([
    ['a fresh review', null],
    ['a review already begun', 99],
  ])(
    'names %s by its visible CTA, and every other control by its own label',
    async (_case, entryId) => {
      mockDue.mockResolvedValue({ due: due({ existing_entry_id: entryId }) });
      mockCurrent.mockResolvedValue({
        scopes: [
          due({ scope_key: 'c1:w2' }),
          due({ level: 'course', scope_key: 'c1:course', existing_entry_id: 5 }),
        ],
      });
      const { findByTestId, getByTestId, getAllByRole } = renderInvitation();
      await findByTestId('journal-reflection-band');
      fireEvent.press(getByTestId('journal-review-early'));
      await findByTestId('journal-review-scope-course');

      const band = getByTestId('journal-reflection-band');
      expect(band.props.accessibilityLabel).toContain('Write your Weekly Review');
      const buttons = getAllByRole('button').filter((b) => b !== band);
      expect(buttons.length).toBeGreaterThanOrEqual(4);
      for (const button of buttons) {
        const [label] = visibleText(button);
        expect(label).toBeDefined();
        expect(button.props.accessibilityLabel).toContain(label);
      }
    },
  );

  it('keeps the folded link named by its visible words too', async () => {
    mockDue.mockResolvedValue({ due: null });
    const { findByTestId, getByTestId } = renderInvitation();
    await findByTestId('journal-morning-pages-tip');
    const link = getByTestId('journal-review-early');
    expect(link.props.accessibilityLabel).toContain(visibleText(link)[0]);
    fireEvent.press(link);
    const folded = getByTestId('journal-review-early');
    expect(visibleText(folded)[0]).toBe('Fold the reviews away');
    expect(folded.props.accessibilityLabel).toContain('Fold the reviews away');
  });
});
