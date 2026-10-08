/**
 * Every seeded preset — canonical and alternative — launches end to end
 * (#3072 AC8).
 *
 * The rows come from `fixtures/seededPresets.json`, a projection of the
 * backend's `PRESET_PRACTICES` that `backend/tests/test_seeded_presets_frontend_fixture.py`
 * holds equal to the seed (regenerate with
 * `cd backend && PYTHONPATH=src python -m scripts.dump_seeded_presets --write`).
 * For each row the client validator accepts the config, the session mounts
 * the mode's view, and the sitting can start, pause and resume (where the
 * view offers it), complete, and save — with the saved window equal to the
 * time actually practised.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { RenderResult } from '@testing-library/react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import ActiveRitualSession from '../components/ActiveRitualSession';
import { getTotalMs } from '../engine/reducer';
import type { AudioAdapter, MindfulAnchorConfig, ModeConfig } from '../engine/types';
import { validateModeConfig } from '../engine/validation';

import seededPresets from './fixtures/seededPresets.json';
import { SESSION_VIEW_TEST_IDS } from './sessionViewTestIds';

import type { PracticeSessionCreate, PracticeSessionResponse, UserPractice } from '@/api';

const mockCreate = jest.fn<(payload: PracticeSessionCreate) => Promise<PracticeSessionResponse>>();

jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/api');
  return {
    ...actual,
    practiceSessions: {
      create: (payload: PracticeSessionCreate) => mockCreate(payload),
    },
  };
});

interface SeededPreset {
  name: string;
  stage_number: number;
  mode: ModeConfig['mode'];
  mode_config: ModeConfig;
  canonical: boolean;
}

const PRESETS = seededPresets as unknown as readonly SeededPreset[];

const MIN = 60_000;
const SEC = 1000;
const T0 = Date.UTC(2026, 9, 7, 6, 0, 0);
const TICK_MS = 100;
/** Slack for a clock observed one engine tick late. */
const TICK_SLACK_MS = 2 * TICK_MS;
/** How long each paused stretch lasts; never counted as practice. */
const PAUSE_MS = 2 * MIN;
/** An open-ended sitting's practised length before it is ended. */
const OPEN_ENDED_MS = 5 * MIN;
const MAX_STEPS = 200;

/** The control that begins a session, where it is not the shared Start. */
const START_TEST_IDS: Partial<Record<ModeConfig['mode'], string>> = {
  tarot: 'tarot-begin',
  card_meditation: 'card-meditation-begin',
  mindful_anchor: 'mindful-anchor-begin',
};

/** The tap target that advances a step-driven session. */
const ADVANCE_TEST_IDS: Partial<Record<ModeConfig['mode'], string>> = {
  sense_grounding: 'sense-grounding-advance',
  tallied_grounding: 'tallied-grounding-advance',
};

const userPractice: UserPractice = {
  id: 10,
  practice_id: 1,
  stage_number: 1,
  start_date: '2026-04-12',
  end_date: null,
};

const silentAudio: AudioAdapter = { play: () => undefined };

type View = RenderResult;

function clockTo(ms: number): void {
  act(() => {
    jest.setSystemTime(ms);
    jest.advanceTimersByTime(TICK_MS);
  });
}

function press(view: View, testID: string): void {
  act(() => {
    fireEvent.press(view.getByTestId(testID));
  });
}

/** Pause and resume once, if the view offers a pause; returns the paused span. */
function pauseAndResume(view: View): number {
  if (view.queryByTestId('ritual-pause') === null) return 0;
  press(view, 'ritual-pause');
  act(() => {
    jest.setSystemTime(Date.now() + PAUSE_MS);
  });
  press(view, 'ritual-resume');
  return PAUSE_MS;
}

/** Drive a timed sitting past its end; the practised span is exactly the plan. */
function driveTimed(view: View, totalMs: number): number {
  clockTo(T0 + totalMs / 2);
  const paused = pauseAndResume(view);
  clockTo(T0 + totalMs + paused + MIN);
  return totalMs;
}

function driveOpenEnded(view: View): number {
  clockTo(T0 + OPEN_ENDED_MS / 2);
  const paused = pauseAndResume(view);
  clockTo(T0 + OPEN_ENDED_MS + paused);
  press(view, 'count-up-end');
  return OPEN_ENDED_MS;
}

function driveSteps(view: View, advanceTestID: string): number {
  clockTo(T0 + MIN);
  for (let i = 0; i < MAX_STEPS && view.queryByTestId(advanceTestID) !== null; i++) {
    press(view, advanceTestID);
  }
  return MIN;
}

function driveAnchor(view: View, config: MindfulAnchorConfig): number {
  const practisedMs = config.min_duration_seconds * SEC + MIN;
  clockTo(T0 + practisedMs);
  press(view, 'mindful-anchor-save');
  return practisedMs;
}

function startSession(view: View, config: ModeConfig): void {
  if (config.mode === 'mindful_anchor' && config.options[0] !== undefined) {
    press(view, `mindful-anchor-option-${config.options[0].key}`);
  }
  press(view, START_TEST_IDS[config.mode] ?? 'ritual-start');
}

/** Run the sitting to completion; returns the practised (pause-free) span. */
function driveToCompletion(view: View, config: ModeConfig): number {
  if (config.mode === 'mindful_anchor') return driveAnchor(view, config);
  const advance = ADVANCE_TEST_IDS[config.mode];
  if (advance !== undefined) return driveSteps(view, advance);
  const totalMs = getTotalMs(config);
  return totalMs === null ? driveOpenEnded(view) : driveTimed(view, totalMs);
}

function renderPreset(config: ModeConfig): View {
  return render(
    <ActiveRitualSession
      userPractice={userPractice}
      effectiveName="Preset"
      effectiveConfig={config}
      userTimezone="UTC"
      onSessionApply={jest.fn()}
      onSessionRollback={jest.fn()}
      onSessionCommitted={jest.fn()}
      onUserPracticeUpdated={jest.fn()}
      onWriteReflection={jest.fn()}
      audio={silentAudio}
    />,
  );
}

describe('seeded preset launch matrix', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({ id: 1 } as PracticeSessionResponse);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('covers every stage and a canonical preset for each', () => {
    const stages = new Set(PRESETS.map((p) => p.stage_number));
    expect([...stages].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(PRESETS.filter((p) => p.canonical)).toHaveLength(stages.size);
  });

  it.each(PRESETS.map((p) => [`stage ${p.stage_number} ${p.name} (${p.mode})`, p] as const))(
    '%s launches, completes and saves',
    async (_label, preset) => {
      const config = preset.mode_config;
      expect(config.mode).toBe(preset.mode);
      expect(validateModeConfig(config)).toEqual([]);

      const view = renderPreset(config);
      expect(view.getByTestId(SESSION_VIEW_TEST_IDS[preset.mode])).toBeTruthy();

      startSession(view, config);
      const practisedMs = driveToCompletion(view, config);

      await act(async () => {
        fireEvent.press(view.getByTestId('insight-skip'));
      });

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const payload = mockCreate.mock.calls[0]?.[0];
      if (payload === undefined) throw new Error('no session posted');
      const started = Date.parse(payload.started_at);
      const ended = Date.parse(payload.ended_at);
      expect(started).toBe(T0);
      expect(Math.abs(ended - started - practisedMs)).toBeLessThanOrEqual(TICK_SLACK_MS);
      expect(ended).toBeLessThanOrEqual(Date.now());
      expect(payload.mode_metadata?.mode).toBe(preset.mode);
    },
  );
});
