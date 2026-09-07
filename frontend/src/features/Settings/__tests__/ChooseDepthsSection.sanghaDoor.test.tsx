/* eslint-env jest */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

/**
 * The Sangha switch under "Choose your depths" is offered only where there is
 * a door for it to close.
 *
 * The Digital Sangha's one destination is the row ``SanghaSection`` renders,
 * and that row exists only in a build with an ``https`` invite configured. In
 * every other build a Sangha switch would persist a choice that changes
 * nothing visible — a control that looks like a depth and is not one. These
 * tests pin that the switch and the door read the same gate, and that an
 * unconfigured app says nothing about the Sangha here either: no disabled
 * switch, no caption, no label. An absent invitation, not a broken one.
 */

// ---------------------------------------------------------------------------
// Config mock — a mutable getter, read at render. Safe as a bare object here:
// ChooseDepthsSection's runtime import tree reads no other config key (its
// ``@/api`` import is type-only and erased).
// ---------------------------------------------------------------------------

const CONFIGURED_URL = 'https://discord.gg/example-sangha';

let mockInviteUrl = '';

jest.mock('@/config', () => ({
  get SANGHA_INVITE_URL(): string {
    return mockInviteUrl;
  },
}));

// ---------------------------------------------------------------------------
// Store mock — selector values from a mutable state object, all rings on.
// ---------------------------------------------------------------------------

const mockLoad = jest.fn<() => Promise<void>>(() => Promise.resolve());
const mockUpdate = jest.fn<(partial: Record<string, boolean>, token?: string) => Promise<void>>(
  () => Promise.resolve(),
);

interface MockState {
  enable_habits: boolean;
  enable_practices: boolean;
  enable_course: boolean;
  enable_sangha: boolean;
}

let mockStoreState: MockState = {
  enable_habits: true,
  enable_practices: true,
  enable_course: true,
  enable_sangha: true,
};

jest.mock('@/store/useDepthPreferencesStore', () => ({
  useDepthPreferencesStore: jest.fn((selector: (_s: MockState) => unknown) =>
    selector(mockStoreState),
  ),
  selectEnableHabits: (s: MockState): boolean => s.enable_habits,
  selectEnablePractices: (s: MockState): boolean => s.enable_practices,
  selectEnableCourse: (s: MockState): boolean => s.enable_course,
  selectEnableSangha: (s: MockState): boolean => s.enable_sangha,
  get load() {
    return mockLoad;
  },
  get update() {
    return mockUpdate;
  },
}));

// ---------------------------------------------------------------------------
// Auth mock — exposes a token so the toggle dispatch carries it.
// ---------------------------------------------------------------------------

const mockToken = 'test-token-abc';

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ logout: jest.fn(), token: mockToken }),
}));

import ChooseDepthsSection from '../ChooseDepthsSection';

/** The three depths whose destinations ship in every build. */
const ALWAYS_OFFERED_SWITCHES = 3;
/** Those three plus the Sangha, once its door exists. */
const ALL_SWITCHES = ALWAYS_OFFERED_SWITCHES + 1;

beforeEach(() => {
  jest.clearAllMocks();
  mockInviteUrl = '';
  mockStoreState = {
    enable_habits: true,
    enable_practices: true,
    enable_course: true,
    enable_sangha: true,
  };
});

describe('ChooseDepthsSection when no Sangha invite is configured', () => {
  it('offers no Sangha switch, because there is no door for it to close', () => {
    const { queryByTestId, queryByText, getAllByRole } = render(<ChooseDepthsSection />);

    expect(queryByTestId('depth-toggle-sangha')).toBeNull();
    expect(queryByTestId('depth-row-sangha')).toBeNull();
    expect(queryByText('Sangha')).toBeNull();
    expect(getAllByRole('switch')).toHaveLength(ALWAYS_OFFERED_SWITCHES);
  });

  it('still offers the three depths whose destinations always ship', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);

    expect(getByTestId('depth-toggle-habits')).toBeTruthy();
    expect(getByTestId('depth-toggle-practices')).toBeTruthy();
    expect(getByTestId('depth-toggle-course')).toBeTruthy();
  });

  it.each(['http://discord.gg/x', '   '])(
    'hides the switch for a non-https or blank invite (%j), mirroring SanghaSection',
    (invite) => {
      mockInviteUrl = invite;

      const { queryByTestId, getAllByRole } = render(<ChooseDepthsSection />);

      expect(queryByTestId('depth-toggle-sangha')).toBeNull();
      expect(getAllByRole('switch')).toHaveLength(ALWAYS_OFFERED_SWITCHES);
    },
  );

  it("renders nothing in the Sangha row's place — no disabled switch, no caption", () => {
    const { getAllByRole, queryByText } = render(<ChooseDepthsSection />);

    for (const sw of getAllByRole('switch')) {
      const state = sw.props.accessibilityState as { disabled?: boolean } | undefined;
      expect(state?.disabled).not.toBe(true);
    }
    expect(queryByText(/sangha/iu)).toBeNull();
  });
});

describe('ChooseDepthsSection once an https Sangha invite is configured', () => {
  it('keeps the Sangha switch and dispatches exactly the one key it owns', () => {
    mockInviteUrl = CONFIGURED_URL;

    const { getByTestId, getAllByRole } = render(<ChooseDepthsSection />);

    expect(getAllByRole('switch')).toHaveLength(ALL_SWITCHES);
    fireEvent(getByTestId('depth-toggle-sangha'), 'valueChange', false);

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({ enable_sangha: false }, mockToken);
    const [partial] = mockUpdate.mock.calls[0] ?? [];
    expect(Object.keys(partial ?? {})).toEqual(['enable_sangha']);
  });

  it('reads the invite at render, not at import', () => {
    const { queryByTestId, rerender } = render(<ChooseDepthsSection />);
    expect(queryByTestId('depth-toggle-sangha')).toBeNull();

    mockInviteUrl = CONFIGURED_URL;
    rerender(<ChooseDepthsSection />);

    expect(queryByTestId('depth-toggle-sangha')).toBeTruthy();
  });
});
