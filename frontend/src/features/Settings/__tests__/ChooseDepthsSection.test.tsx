/* eslint-env jest */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

// ---------------------------------------------------------------------------
// Store mock — returns selector values from a mutable state object.
// All four rings default to true; individual tests override via setMockState.
// ---------------------------------------------------------------------------

const mockLoad = jest.fn<() => Promise<void>>(() => Promise.resolve());
const mockUpdate = jest.fn<(partial: Record<string, boolean>, token?: string) => Promise<void>>(
  () => Promise.resolve(),
);

type MockState = {
  enable_habits: boolean;
  enable_practices: boolean;
  enable_course: boolean;
  enable_sangha: boolean;
};

let mockStoreState: MockState = {
  enable_habits: true,
  enable_practices: true,
  enable_course: true,
  enable_sangha: true,
};

const setMockState = (patch: Partial<MockState>): void => {
  mockStoreState = { ...mockStoreState, ...patch };
};

jest.mock('@/store/useDepthPreferencesStore', () => ({
  useDepthPreferencesStore: jest.fn((selector: (_s: MockState) => unknown) =>
    selector(mockStoreState),
  ),
  selectEnableHabits: (s: MockState): boolean => s.enable_habits,
  selectEnablePractices: (s: MockState): boolean => s.enable_practices,
  selectEnableCourse: (s: MockState): boolean => s.enable_course,
  selectEnableSangha: (s: MockState): boolean => s.enable_sangha,
  // Expose actions on the store mock so the component can call them
  get load() {
    return mockLoad;
  },
  get update() {
    return mockUpdate;
  },
}));

// ---------------------------------------------------------------------------
// Auth mock — exposes token alongside the existing logout.
// ---------------------------------------------------------------------------

const mockToken = 'test-token-abc';
const mockLogout = jest.fn<() => Promise<void>>(() => Promise.resolve());

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ logout: mockLogout, token: mockToken }),
}));

import ChooseDepthsSection from '../ChooseDepthsSection';

import { touchTarget } from '@/design/tokens';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the flattened minHeight from a node's style prop. */
function flatMinHeight(node: { props: { style: unknown } }): number {
  const flat = StyleSheet.flatten(node.props.style) as { minHeight?: number };
  return flat.minHeight ?? 0;
}

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockStoreState = {
    enable_habits: true,
    enable_practices: true,
    enable_course: true,
    enable_sangha: true,
  };
});

// ---------------------------------------------------------------------------
// Section presence and copy
// ---------------------------------------------------------------------------

describe('ChooseDepthsSection — section-level copy', () => {
  it('renders the section with testID "settings-group-depths"', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    expect(getByTestId('settings-group-depths')).toBeTruthy();
  });

  it('renders the section title "Choose your depths"', () => {
    const { getByText } = render(<ChooseDepthsSection />);
    expect(getByText('Choose your depths')).toBeTruthy();
  });

  it('renders the rings framing caption verbatim', () => {
    const { getByText } = render(<ChooseDepthsSection />);
    expect(
      getByText(
        'Turn any depth on or off whenever it fits your life. Turning one off is a choice, not a loss.',
      ),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Floor statement
// ---------------------------------------------------------------------------

describe('ChooseDepthsSection — journal floor statement', () => {
  it('renders testID "depths-floor-statement"', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    expect(getByTestId('depths-floor-statement')).toBeTruthy();
  });

  it('the floor element carries accessibilityRole="text"', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    expect(getByTestId('depths-floor-statement').props.accessibilityRole).toBe('text');
  });

  it('renders the floor line verbatim (em dash U+2014)', () => {
    const { getByText } = render(<ChooseDepthsSection />);
    expect(
      getByText(
        'Your journal is always here — the floor beneath everything. Nothing below is required.',
      ),
    ).toBeTruthy();
  });

  it('the floor statement is contained within the section', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    const section = getByTestId('settings-group-depths');
    expect(within(section).getByTestId('depths-floor-statement')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Ring row labels
// ---------------------------------------------------------------------------

describe('ChooseDepthsSection — ring row labels', () => {
  it('renders the label "Habits"', () => {
    const { getByText } = render(<ChooseDepthsSection />);
    expect(getByText('Habits')).toBeTruthy();
  });

  it('renders the label "Practices"', () => {
    const { getByText } = render(<ChooseDepthsSection />);
    expect(getByText('Practices')).toBeTruthy();
  });

  it('renders the label "Course"', () => {
    const { getByText } = render(<ChooseDepthsSection />);
    expect(getByText('Course')).toBeTruthy();
  });

  it('renders the label "Sangha"', () => {
    const { getByText } = render(<ChooseDepthsSection />);
    expect(getByText('Sangha')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Exactly four switch elements; no floor switch
// ---------------------------------------------------------------------------

describe('ChooseDepthsSection — switch count (journal floor is NOT a toggle)', () => {
  it('renders exactly four elements with accessibilityRole="switch"', () => {
    const { getAllByRole } = render(<ChooseDepthsSection />);
    const switches = getAllByRole('switch');
    expect(switches).toHaveLength(4);
  });

  it('does NOT render a switch with testID "depth-toggle-floor" or any floor-related switch', () => {
    const { queryByTestId } = render(<ChooseDepthsSection />);
    expect(queryByTestId('depth-toggle-floor')).toBeNull();
  });

  it('does NOT render a disabled switch (floor is text, not a greyed-out toggle)', () => {
    const { getAllByRole } = render(<ChooseDepthsSection />);
    const switches = getAllByRole('switch');
    for (const sw of switches) {
      expect(sw.props.accessibilityState?.disabled).not.toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Switch testIDs
// ---------------------------------------------------------------------------

describe('ChooseDepthsSection — switch testIDs', () => {
  it('renders testID "depth-toggle-habits"', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    expect(getByTestId('depth-toggle-habits')).toBeTruthy();
  });

  it('renders testID "depth-toggle-practices"', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    expect(getByTestId('depth-toggle-practices')).toBeTruthy();
  });

  it('renders testID "depth-toggle-course"', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    expect(getByTestId('depth-toggle-course')).toBeTruthy();
  });

  it('renders testID "depth-toggle-sangha"', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    expect(getByTestId('depth-toggle-sangha')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// UI reflects persisted store state (no local mirror)
// ---------------------------------------------------------------------------

describe('ChooseDepthsSection — renders store state, not local state', () => {
  it('course switch is false when store reports enable_course: false', () => {
    setMockState({ enable_course: false });
    const { getByTestId } = render(<ChooseDepthsSection />);
    const courseSwitch = getByTestId('depth-toggle-course');
    expect(courseSwitch.props.value).toBe(false);
    expect(courseSwitch.props.accessibilityState.checked).toBe(false);
  });

  it('the other three switches remain true when only enable_course is false', () => {
    setMockState({ enable_course: false });
    const { getByTestId } = render(<ChooseDepthsSection />);
    expect(getByTestId('depth-toggle-habits').props.value).toBe(true);
    expect(getByTestId('depth-toggle-practices').props.value).toBe(true);
    expect(getByTestId('depth-toggle-sangha').props.value).toBe(true);
  });

  it('habits switch reflects enable_habits: false from store', () => {
    setMockState({ enable_habits: false });
    const { getByTestId } = render(<ChooseDepthsSection />);
    expect(getByTestId('depth-toggle-habits').props.value).toBe(false);
    expect(getByTestId('depth-toggle-habits').props.accessibilityState.checked).toBe(false);
  });

  it('practices switch reflects enable_practices: false from store', () => {
    setMockState({ enable_practices: false });
    const { getByTestId } = render(<ChooseDepthsSection />);
    expect(getByTestId('depth-toggle-practices').props.value).toBe(false);
    expect(getByTestId('depth-toggle-practices').props.accessibilityState.checked).toBe(false);
  });

  it('sangha switch reflects enable_sangha: false from store', () => {
    setMockState({ enable_sangha: false });
    const { getByTestId } = render(<ChooseDepthsSection />);
    expect(getByTestId('depth-toggle-sangha').props.value).toBe(false);
    expect(getByTestId('depth-toggle-sangha').props.accessibilityState.checked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Load on mount
// ---------------------------------------------------------------------------

describe('ChooseDepthsSection — load on mount', () => {
  it('calls store load(token) exactly once on mount', () => {
    render(<ChooseDepthsSection />);
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockLoad).toHaveBeenCalledWith(mockToken);
  });
});

// ---------------------------------------------------------------------------
// Per-ring toggle dispatch
// ---------------------------------------------------------------------------

describe('ChooseDepthsSection — toggle dispatch: Habits', () => {
  it('firing onValueChange(false) on the Habits switch calls update({ enable_habits: false }, token)', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    fireEvent(getByTestId('depth-toggle-habits'), 'valueChange', false);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({ enable_habits: false }, mockToken);
  });

  it('firing onValueChange(true) on the Habits switch calls update({ enable_habits: true }, token)', () => {
    setMockState({ enable_habits: false });
    const { getByTestId } = render(<ChooseDepthsSection />);
    fireEvent(getByTestId('depth-toggle-habits'), 'valueChange', true);
    expect(mockUpdate).toHaveBeenCalledWith({ enable_habits: true }, mockToken);
  });
});

describe('ChooseDepthsSection — toggle dispatch: Practices', () => {
  it('firing onValueChange(false) on the Practices switch calls update({ enable_practices: false }, token)', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    fireEvent(getByTestId('depth-toggle-practices'), 'valueChange', false);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({ enable_practices: false }, mockToken);
  });
});

describe('ChooseDepthsSection — toggle dispatch: Course', () => {
  it('firing onValueChange(false) on the Course switch calls update({ enable_course: false }, token)', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    fireEvent(getByTestId('depth-toggle-course'), 'valueChange', false);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({ enable_course: false }, mockToken);
  });
});

describe('ChooseDepthsSection — toggle dispatch: Sangha', () => {
  it('firing onValueChange(false) on the Sangha switch calls update({ enable_sangha: false }, token)', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    fireEvent(getByTestId('depth-toggle-sangha'), 'valueChange', false);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({ enable_sangha: false }, mockToken);
  });
});

describe('ChooseDepthsSection — toggle dispatch: key isolation', () => {
  it('toggling Habits does NOT pass enable_practices key', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    fireEvent(getByTestId('depth-toggle-habits'), 'valueChange', false);
    const calledWith = mockUpdate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(calledWith)).not.toContain('enable_practices');
    expect(Object.keys(calledWith)).not.toContain('enable_course');
    expect(Object.keys(calledWith)).not.toContain('enable_sangha');
  });

  it('toggling Sangha does NOT pass enable_habits key', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    fireEvent(getByTestId('depth-toggle-sangha'), 'valueChange', false);
    const calledWith = mockUpdate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(calledWith)).not.toContain('enable_habits');
    expect(Object.keys(calledWith)).not.toContain('enable_practices');
    expect(Object.keys(calledWith)).not.toContain('enable_course');
  });
});

// ---------------------------------------------------------------------------
// Accessibility — roles, labels, accessibilityState.checked, touch targets
// ---------------------------------------------------------------------------

describe('ChooseDepthsSection — accessibility: roles and labels', () => {
  it('depth-toggle-habits has accessibilityRole="switch"', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    expect(getByTestId('depth-toggle-habits').props.accessibilityRole).toBe('switch');
  });

  it('depth-toggle-practices has accessibilityRole="switch"', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    expect(getByTestId('depth-toggle-practices').props.accessibilityRole).toBe('switch');
  });

  it('depth-toggle-course has accessibilityRole="switch"', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    expect(getByTestId('depth-toggle-course').props.accessibilityRole).toBe('switch');
  });

  it('depth-toggle-sangha has accessibilityRole="switch"', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    expect(getByTestId('depth-toggle-sangha').props.accessibilityRole).toBe('switch');
  });

  it('depth-toggle-habits has a non-empty accessibilityLabel containing "Habits"', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    const label: string = getByTestId('depth-toggle-habits').props.accessibilityLabel;
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
    expect(label).toMatch(/Habits/);
  });

  it('depth-toggle-practices has a non-empty accessibilityLabel containing "Practices"', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    const label: string = getByTestId('depth-toggle-practices').props.accessibilityLabel;
    expect(label.length).toBeGreaterThan(0);
    expect(label).toMatch(/Practices/);
  });

  it('depth-toggle-course has a non-empty accessibilityLabel containing "Course"', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    const label: string = getByTestId('depth-toggle-course').props.accessibilityLabel;
    expect(label.length).toBeGreaterThan(0);
    expect(label).toMatch(/Course/);
  });

  it('depth-toggle-sangha has a non-empty accessibilityLabel containing "Sangha"', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    const label: string = getByTestId('depth-toggle-sangha').props.accessibilityLabel;
    expect(label.length).toBeGreaterThan(0);
    expect(label).toMatch(/Sangha/);
  });
});

describe('ChooseDepthsSection — accessibility: accessibilityState.checked tracks value', () => {
  it('checked is true for all four switches when all rings are on', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    expect(getByTestId('depth-toggle-habits').props.accessibilityState.checked).toBe(true);
    expect(getByTestId('depth-toggle-practices').props.accessibilityState.checked).toBe(true);
    expect(getByTestId('depth-toggle-course').props.accessibilityState.checked).toBe(true);
    expect(getByTestId('depth-toggle-sangha').props.accessibilityState.checked).toBe(true);
  });

  it('checked matches value when all rings are off', () => {
    setMockState({
      enable_habits: false,
      enable_practices: false,
      enable_course: false,
      enable_sangha: false,
    });
    const { getByTestId } = render(<ChooseDepthsSection />);
    expect(getByTestId('depth-toggle-habits').props.accessibilityState.checked).toBe(false);
    expect(getByTestId('depth-toggle-practices').props.accessibilityState.checked).toBe(false);
    expect(getByTestId('depth-toggle-course').props.accessibilityState.checked).toBe(false);
    expect(getByTestId('depth-toggle-sangha').props.accessibilityState.checked).toBe(false);
  });
});

describe('ChooseDepthsSection — accessibility: touch targets ≥44dp', () => {
  it('the Habits switch row meets the 44dp minimum touch target via minHeight', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    expect(flatMinHeight(getByTestId('depth-row-habits'))).toBeGreaterThanOrEqual(
      touchTarget.minimum,
    );
  });

  it('the Practices switch row meets the 44dp minimum touch target via minHeight', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    expect(flatMinHeight(getByTestId('depth-row-practices'))).toBeGreaterThanOrEqual(
      touchTarget.minimum,
    );
  });

  it('the Course switch row meets the 44dp minimum touch target via minHeight', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    expect(flatMinHeight(getByTestId('depth-row-course'))).toBeGreaterThanOrEqual(
      touchTarget.minimum,
    );
  });

  it('the Sangha switch row meets the 44dp minimum touch target via minHeight', () => {
    const { getByTestId } = render(<ChooseDepthsSection />);
    expect(flatMinHeight(getByTestId('depth-row-sangha'))).toBeGreaterThanOrEqual(
      touchTarget.minimum,
    );
  });
});
