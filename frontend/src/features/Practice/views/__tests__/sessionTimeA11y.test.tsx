/**
 * Every live session time readout is exposed to assistive tech as a timer
 * with a minute-granular spoken label in a polite live region, and the
 * session controls carry button roles and names (#3072 AC6).
 */
import { describe, expect, it } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import React from 'react';

import { cardForDayIndex } from '../../data/tarot';
import type { EngineStatus, RitualState } from '../../engine/types';
import CountUpTimerView from '../CountUpTimerView';
import type { SpokenTimeDirection } from '../formatTime';
import { spokenTime } from '../formatTime';
import IntervalBellView from '../IntervalBellView';
import MeditationTimerView from '../MeditationTimerView';
import MetronomeView from '../MetronomeView';
import MindfulAnchorView from '../MindfulAnchorView';
import RandomIntervalBellView from '../RandomIntervalBellView';
import RepCounterView from '../RepCounterView';
import RitualControlsBar from '../RitualControlsBar';
import TarotMeditationView from '../TarotMeditationView';

import { fakeControls, fakeState } from './fixtures';

const MIN = 60_000;
const SPOKEN =
  /^(Less than a minute|Under a minute|\d+ minutes?) (remaining|elapsed|until the next bell)$/;

const running: RitualState = fakeState({
  status: 'running',
  // Half-minutes, so a readout spoken in the wrong direction (or rounded the
  // wrong way) names a different number than the right one.
  elapsedMs: 3.5 * MIN,
  remainingMs: 7.5 * MIN,
  nextCueAtMs: 5 * MIN,
});

const noop = (): void => undefined;

/**
 * What each readout must say for {@link running}: a countdown rounds up, a
 * count-up rounds down, the next bell is 5 - 3.5 = 1.5 min away, and the rep
 * time cap has 10 - 3.5 = 6.5 min left.
 */
const EXPECTED_LABELS: Record<string, string> = {
  'meditation-time-remaining': '8 minutes remaining',
  'count-up-elapsed': '3 minutes elapsed',
  'metronome-mini-timer': '3 minutes elapsed',
  'random-interval-bell-elapsed': '3 minutes elapsed',
  'interval-bell-next': '2 minutes until the next bell',
  'rep-counter-time-cap': '7 minutes remaining',
  'mindful-anchor-elapsed-time': '3 minutes elapsed',
  'tarot-time-remaining': '8 minutes remaining',
};

const READOUTS: readonly (readonly [string, string, () => React.JSX.Element])[] = [
  [
    'meditation timer',
    'meditation-time-remaining',
    () => <MeditationTimerView state={running} controls={fakeControls()} />,
  ],
  [
    'count-up',
    'count-up-elapsed',
    () => <CountUpTimerView state={running} controls={fakeControls()} />,
  ],
  [
    'metronome',
    'metronome-mini-timer',
    () => (
      <MetronomeView
        config={{
          mode: 'metronome',
          bpm: 60,
          timer: { mode: 'meditation_timer', duration_minutes: 10 },
        }}
        state={running}
        controls={fakeControls()}
      />
    ),
  ],
  [
    'random interval bell',
    'random-interval-bell-elapsed',
    () => (
      <RandomIntervalBellView
        config={{
          mode: 'random_interval_bell',
          duration_minutes: 10,
          min_interval_seconds: 30,
          max_interval_seconds: 60,
          bell_tone: 'bowl',
        }}
        state={running}
        controls={fakeControls()}
        random={() => 0.5}
        audio={{ play: noop }}
      />
    ),
  ],
  [
    'interval bell',
    'interval-bell-next',
    () => (
      <IntervalBellView
        config={{
          mode: 'interval_bell',
          duration_minutes: 10,
          interval_minutes: 5,
          bell_tone: 'bowl',
        }}
        state={running}
        controls={fakeControls()}
      />
    ),
  ],
  [
    'rep counter time cap',
    'rep-counter-time-cap',
    () => (
      <RepCounterView
        config={{ mode: 'rep_counter', target_reps: 10, unit_label: 'reps', time_cap_minutes: 10 }}
        state={running}
        controls={fakeControls()}
      />
    ),
  ],
  [
    'mindful anchor',
    'mindful-anchor-elapsed-time',
    () => (
      <MindfulAnchorView
        config={{
          mode: 'mindful_anchor',
          instruction: 'Rest a palm on the grass.',
          min_duration_seconds: 0,
          options: [],
          require_option_choice: false,
        }}
        state={running}
        controls={fakeControls()}
        onComplete={noop}
      />
    ),
  ],
  [
    'card timer (shared SessionTimerLabel)',
    'tarot-time-remaining',
    () => (
      <TarotMeditationView
        state={running}
        controls={fakeControls()}
        card={cardForDayIndex(0)}
        hideTimer={false}
      />
    ),
  ],
];

describe('session time readouts are accessible timers', () => {
  it.each(READOUTS)('%s readout is a polite, spoken timer', (_name, testID, element) => {
    render(element());
    const readout = screen.getByTestId(testID);
    expect(readout.props.accessibilityRole).toBe('timer');
    expect(readout.props.accessibilityLabel).toMatch(SPOKEN);
    expect(readout.props.accessibilityLabel).toBe(EXPECTED_LABELS[testID]);
    expect(screen.getAllByRole('timer').length).toBeGreaterThan(0);
  });

  it.each(READOUTS.filter(([name]) => name !== 'mindful anchor'))(
    '%s readout announces through a polite live region',
    (_name, testID, element) => {
      render(element());
      expect(screen.getByTestId(testID).props.accessibilityLiveRegion).toBe('polite');
    },
  );

  it('mindful anchor announces through its polite elapsed block', () => {
    render(READOUTS.find(([name]) => name === 'mindful anchor')?.[2]() ?? <></>);
    expect(screen.getByTestId('mindful-anchor-elapsed').props.accessibilityLiveRegion).toBe(
      'polite',
    );
  });

  it('a countdown just under twelve minutes is spoken as twelve minutes remaining', () => {
    render(
      <MeditationTimerView
        state={fakeState({ status: 'running', remainingMs: 12 * MIN - 1 })}
        controls={fakeControls()}
      />,
    );
    expect(screen.getByRole('timer').props.accessibilityLabel).toBe('12 minutes remaining');
  });
});

describe('spokenTime', () => {
  const cases: [number, SpokenTimeDirection, string][] = [
    [0, 'remaining', 'Less than a minute remaining'],
    [59_999, 'remaining', 'Less than a minute remaining'],
    [MIN, 'remaining', '1 minute remaining'],
    [MIN + 1, 'remaining', '2 minutes remaining'],
    [59_999, 'elapsed', 'Under a minute elapsed'],
    [2 * MIN - 1, 'elapsed', '1 minute elapsed'],
    [45 * MIN, 'elapsed', '45 minutes elapsed'],
    [90_000, 'next', '2 minutes until the next bell'],
    [-5000, 'remaining', 'Less than a minute remaining'],
  ];
  it.each(cases)('%d ms %s → %s', (ms, direction, expected) => {
    expect(spokenTime(ms, direction)).toBe(expected);
  });
});

describe('session controls are named buttons', () => {
  const cases: [EngineStatus, string[]][] = [
    ['idle', ['Start']],
    ['running', ['Pause', 'Cancel']],
    ['paused', ['Resume', 'Cancel']],
  ];
  it.each(cases)('%s exposes %j', (status, names) => {
    render(<RitualControlsBar status={status} controls={fakeControls()} />);
    for (const name of names) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });
});
