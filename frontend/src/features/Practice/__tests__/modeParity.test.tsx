/**
 * Every backend `PracticeMode` is fully usable on the client (#3072 AC9).
 *
 * The backend's `PracticeMode` enum is the closed list of modes a catalog row
 * or custom practice may carry. A mode the server accepts but the client can
 * not pick, configure, validate or run is a practice the user can create and
 * never perform. This reads the enum from the Python (through
 * `@/testing/backendSource`, so backend CI runs it on the change that would
 * break it) and checks each member against the picker, the configurator form
 * table, the validator's defaults and the session view dispatch.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';

import ActiveRitualSession from '../components/ActiveRitualSession';
import { MODE_FORMS } from '../components/ConfiguratorBody';
import { MODE_CATEGORIES } from '../components/ModePicker';
import { defaultConfigFor } from '../configurator/defaults';
import type { AudioAdapter, ModeConfig } from '../engine/types';
import { validateModeConfig } from '../engine/validation';

import { SESSION_VIEW_TEST_IDS } from './sessionViewTestIds';

import type { UserPractice } from '@/api';
import { readBackendSource } from '@/testing/backendSource';

const ENUM_MEMBER = /^\s+[A-Z_]+ = "([a-z_]+)"$/gm;

/** The wire values of `PracticeMode`, parsed from `practice_modes.py`. */
function parsePracticeModes(source: string): string[] {
  const body = source.slice(source.indexOf('class PracticeMode'), source.indexOf('ALL_MODES'));
  return [...body.matchAll(ENUM_MEMBER)].map((match) => match[1] ?? '');
}

const BACKEND_MODES = parsePracticeModes(
  readBackendSource('src', 'domain', 'practice_modes.py'),
).sort();

const PICKABLE_MODES = MODE_CATEGORIES.flatMap((category) => category.modes.map((m) => m.mode));

const userPractice: UserPractice = {
  id: 10,
  practice_id: 1,
  stage_number: 1,
  start_date: '2026-04-12',
  end_date: null,
};

const silentAudio: AudioAdapter = { play: () => undefined };

describe('backend PracticeMode parity', () => {
  it('parses a non-empty mode list from the backend enum', () => {
    expect(BACKEND_MODES.length).toBeGreaterThanOrEqual(11);
    expect(BACKEND_MODES).toContain('meditation_timer');
  });

  it('the parser sees a member added to the enum', () => {
    const source = readBackendSource('src', 'domain', 'practice_modes.py');
    const grown = source.replace(
      '    MEDITATION_TIMER = "meditation_timer"\n',
      '    MEDITATION_TIMER = "meditation_timer"\n    FOO = "foo"\n',
    );
    expect(parsePracticeModes(grown)).toContain('foo');
  });

  it('every backend mode is pickable, and the picker offers nothing else', () => {
    expect([...PICKABLE_MODES].sort()).toEqual(BACKEND_MODES);
  });

  it('every backend mode has a configurator form and a session view', () => {
    expect(Object.keys(MODE_FORMS).sort()).toEqual(BACKEND_MODES);
    expect(Object.keys(SESSION_VIEW_TEST_IDS).sort()).toEqual(BACKEND_MODES);
  });

  it.each(BACKEND_MODES)('%s defaults validate and mount its session view', (mode) => {
    const config = defaultConfigFor(mode as ModeConfig['mode']);
    expect(validateModeConfig(config)).toEqual([]);
    const view = render(
      <ActiveRitualSession
        userPractice={userPractice}
        effectiveName="Custom"
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
    expect(view.getByTestId(SESSION_VIEW_TEST_IDS[config.mode])).toBeTruthy();
  });
});
