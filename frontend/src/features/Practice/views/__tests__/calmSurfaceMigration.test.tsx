/**
 * Gate 1 RED — pins the calm-surface migration contract for the Practice tab.
 *
 * Direction 2: only BeginHero stays on showcase.canvas; the session header band
 * and all in-session mode views move to a new calm surface built from existing
 * surface.raised / ink.* / accent.primary tokens.
 *
 * RED tests (fail until implementation lands):
 *   A — mode view background is surface.raised in the live session wiring
 *   A — mode view primary text is ink.primary in the live session wiring
 *   B — header band background is surface.raised (requires testID on the band)
 *   B — session name text is ink.primary (not onShowcase.primary)
 *
 * Characterization tests (GREEN today — lock regressions):
 *   C — BeginHero stays on showcase.canvas
 *   D — ink / accent tokens clear WCAG AA on surface.raised
 */
import { describe, expect, it, jest } from '@jest/globals';
import { render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { fakeControls, fakeState } from './fixtures';

import { ShowcaseCard } from '@/components/layout/ShowcaseCard';
import { accent, ink, onShowcase, showcase, surface } from '@/design/tokens';
import MeditationTimerView from '@/features/Practice/views/MeditationTimerView';
import { SessionSurfaceProvider } from '@/features/Practice/views/sessionSurface';

// ---------------------------------------------------------------------------
// Helpers — verbatim from sessionSurfaceMigration.test.tsx
// ---------------------------------------------------------------------------

const AA_NORMAL = 4.5;

/** WCAG relative luminance of a #rrggbb colour. */
const luminance = (hex: string): number => {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`not a 6-digit hex: ${hex}`);
  const channels = [match[1], match[2], match[3]].map((pair) => {
    const c = Number.parseInt(pair!, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
};

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const flatColor = (style: unknown): string | undefined =>
  (StyleSheet.flatten(style as never) as { color?: string }).color;

const flatBackground = (style: unknown): string | undefined =>
  (StyleSheet.flatten(style as never) as { backgroundColor?: string }).backgroundColor;

// ---------------------------------------------------------------------------
// Module-level mocks — required by the PracticeScreen render path in A, B, C.
// jest.mock calls are hoisted; factory closures run lazily on first import.
// ---------------------------------------------------------------------------

jest.mock('react-native-safe-area-context', () => {
  const ReactMod = require('react') as typeof React;
  const passthrough = ({ children }: { children: React.ReactNode }) =>
    ReactMod.createElement(ReactMod.Fragment, null, children);
  return {
    SafeAreaProvider: passthrough,
    SafeAreaView: passthrough,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('@react-navigation/native', () => {
  const reactMod = jest.requireActual('react') as {
    useEffect: (_cb: () => undefined | (() => void), _deps: unknown[]) => void;
  };
  return {
    ...(jest.requireActual('@react-navigation/native') as object),
    useNavigation: () => ({ navigate: jest.fn() }),
    useFocusEffect: (cb: () => void | (() => void)) => {
      reactMod.useEffect(() => {
        const cleanup = cb();
        return () => {
          if (typeof cleanup === 'function') cleanup();
        };
      }, [cb]);
    },
  };
});

jest.mock('../../../../navigation/hooks', () => ({
  useAppNavigation: () => ({ navigate: jest.fn() }),
  useAppRoute: () => ({ key: 'Practice-test', name: 'Practice', params: {} }),
}));

jest.mock('../../../../context/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', userTimezone: 'UTC' }),
}));

jest.mock('../../../../api', () => ({
  practices: {
    listAll: jest.fn<() => Promise<unknown>>().mockResolvedValue([
      {
        id: 1,
        stage_number: 1,
        name: 'Breath Awareness',
        description: 'Focus on the breath.',
        instructions: 'Sit comfortably.',
        default_duration_minutes: 10,
        submitted_by_user_id: null,
        approved: true,
        mode: 'meditation_timer',
        mode_config: { mode: 'meditation_timer', duration_minutes: 10 },
      },
    ]),
  },
  userPractices: {
    create: jest.fn(),
    list: jest.fn<() => Promise<unknown>>().mockResolvedValue([
      {
        id: 10,
        user_id: 1,
        practice_id: 1,
        stage_number: 1,
        start_date: '2026-04-12',
        end_date: null,
      },
    ]),
    customize: jest.fn(),
  },
  practiceSessions: {
    create: jest.fn(),
    weekCount: jest.fn<() => Promise<unknown>>().mockResolvedValue({ count: 0 }),
    insights: jest.fn<() => Promise<unknown>>().mockRejectedValue(new Error('unavailable')),
  },
  frequency: {
    current: jest.fn<() => Promise<unknown>>().mockResolvedValue({
      stage_number: 1,
      color: 'Beige',
      aspect: 'Body',
      practice_name: 'Breath Awareness',
      practice_id: 1,
      user_practice_id: 10,
      banner_text: 'You are in the Beige frequency.',
    }),
  },
}));

jest.mock('../../../../store/useProgramProgression', () => ({
  useDerivedCurrentStage: (s: number) => s,
}));

jest.mock('../../../../store/useStageStore', () => ({
  selectCurrentStage: (s: { currentStage: number }) => s.currentStage,
  useStageStore: (sel: (_s: { currentStage: number; stages: unknown[] }) => unknown) =>
    sel({ currentStage: 1, stages: [] }),
}));

jest.mock('../../../../features/Map/services/stageService', () => ({
  stageService: { loadStages: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Test A — mode view re-skins off umber (real wiring via PracticeScreen)
// RED: ActiveRitualSession currently passes SHOWCASE_SURFACE to the provider,
// so meditation-timer-view gets backgroundColor=showcase.canvas (#2a211a), not
// surface.raised (#ffffff). Both assertions below fail today.
// ---------------------------------------------------------------------------

describe('A: mode view re-skins off umber (real ActiveRitualSession wiring)', () => {
  it('meditation-timer-view ground resolves to surface.raised, not showcase.canvas', async () => {
    const PracticeScreen = require('../../../../features/Practice/PracticeScreen')
      .default as React.ComponentType;
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('meditation-timer-view')).toBeTruthy());
    expect(flatBackground(getByTestId('meditation-timer-view').props.style)).toBe(surface.raised);
    expect(flatBackground(getByTestId('meditation-timer-view').props.style)).not.toBe(
      showcase.canvas,
    );
  });

  it('meditation-time-remaining resolves to ink.primary, not onShowcase.primary', async () => {
    const PracticeScreen = require('../../../../features/Practice/PracticeScreen')
      .default as React.ComponentType;
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('meditation-time-remaining')).toBeTruthy());
    expect(flatColor(getByTestId('meditation-time-remaining').props.style)).toBe(ink.primary);
    expect(flatColor(getByTestId('meditation-time-remaining').props.style)).not.toBe(
      onShowcase.primary,
    );
  });
});

// ---------------------------------------------------------------------------
// Test A-seam — standalone SessionSurfaceProvider seam (characterization)
// GREEN today: confirms the seam itself works when provided a calm surface.
// The real wiring (which surface ActiveRitualSession provides) is what A tests.
// ---------------------------------------------------------------------------

describe('A-seam: SessionSurfaceProvider forwards calm surface to mode views', () => {
  const calmSurface = {
    ground: surface.raised,
    raised: surface.sunken,
    text: ink.primary,
    textSoft: ink.soft,
    textMuted: ink.muted,
    accent: accent.primary,
  };

  it('meditation-timer-view uses provided ground', () => {
    const { getByTestId } = render(
      <SessionSurfaceProvider value={calmSurface}>
        <MeditationTimerView state={fakeState({ remainingMs: 0 })} controls={fakeControls()} />
      </SessionSurfaceProvider>,
    );
    expect(flatBackground(getByTestId('meditation-timer-view').props.style)).toBe(surface.raised);
  });

  it('meditation-time-remaining uses provided text', () => {
    const { getByTestId } = render(
      <SessionSurfaceProvider value={calmSurface}>
        <MeditationTimerView state={fakeState({ remainingMs: 0 })} controls={fakeControls()} />
      </SessionSurfaceProvider>,
    );
    expect(flatColor(getByTestId('meditation-time-remaining').props.style)).toBe(ink.primary);
  });
});

// ---------------------------------------------------------------------------
// Test B — session header band leaves umber (ActiveRitualSession)
// RED:
//   - active-practice-header-band testID does not exist on the headerBand View
//     (element not found until the impl adds it).
//   - active-practice-name static style sets color: onShowcase.primary today.
// ---------------------------------------------------------------------------

describe('B: session header band leaves umber (ActiveRitualSession)', () => {
  it('header band background resolves to surface.raised', async () => {
    // Implementation must add testID="active-practice-header-band" to the
    // headerBand View and set its backgroundColor from the calm surface ground.
    // RED today: element not found.
    const PracticeScreen = require('../../../../features/Practice/PracticeScreen')
      .default as React.ComponentType;
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('active-practice-card')).toBeTruthy());
    const band = getByTestId('active-practice-header-band');
    expect(flatBackground(band.props.style)).toBe(surface.raised);
    expect(flatBackground(band.props.style)).not.toBe(showcase.canvas);
  });

  it('session name text resolves to ink.primary', async () => {
    // active-practice-name static style uses onShowcase.primary today.
    // RED: the assertion toBe(ink.primary) fails.
    const PracticeScreen = require('../../../../features/Practice/PracticeScreen')
      .default as React.ComponentType;
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('active-practice-name')).toBeTruthy());
    expect(flatColor(getByTestId('active-practice-name').props.style)).toBe(ink.primary);
    expect(flatColor(getByTestId('active-practice-name').props.style)).not.toBe(onShowcase.primary);
  });
});

// ---------------------------------------------------------------------------
// Test C — BeginHero regression guard (characterization — GREEN today)
// Locks the single retained showcase accent so the impl cannot over-flatten.
// ---------------------------------------------------------------------------

describe('C: BeginHero stays on showcase.canvas (regression guard)', () => {
  it('ShowcaseCard renders with showcase.canvas background', () => {
    // ShowcaseCard is what BeginHero uses; asserting on it directly avoids
    // the full PracticeScreen mock stack while still pinning the contract.
    const { getByTestId } = render(
      <ShowcaseCard testID="hero-probe">
        <></>
      </ShowcaseCard>,
    );
    expect(flatBackground(getByTestId('hero-probe').props.style)).toBe(showcase.canvas);
  });

  it('practice-begin-hero in PracticeScreen renders on showcase.canvas', async () => {
    // Belt-and-suspenders: verify the live wiring inside PracticeScreen too.
    const PracticeScreen = require('../../../../features/Practice/PracticeScreen')
      .default as React.ComponentType;
    const { getByTestId } = render(<PracticeScreen />);
    await waitFor(() => expect(getByTestId('practice-begin-hero')).toBeTruthy());
    expect(flatBackground(getByTestId('practice-begin-hero').props.style)).toBe(showcase.canvas);
  });
});

// ---------------------------------------------------------------------------
// Test D — token AA guard for calm surface (characterization — GREEN today)
// Asserts every ink / accent role used by the calm surface clears WCAG AA on
// surface.raised. If any assertion FAILS here, stop — the chosen token fails
// AA on the calm surface, which is a real design defect.
// ---------------------------------------------------------------------------

describe('D: calm surface tokens clear WCAG AA on surface.raised', () => {
  it('ink.primary (text) clears AA on surface.raised', () => {
    expect(contrast(ink.primary, surface.raised)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('ink.soft (textSoft) clears AA on surface.raised', () => {
    expect(contrast(ink.soft, surface.raised)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('ink.muted (textMuted) clears AA on surface.raised', () => {
    expect(contrast(ink.muted, surface.raised)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('accent.primary clears AA on surface.raised', () => {
    expect(contrast(accent.primary, surface.raised)).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});
