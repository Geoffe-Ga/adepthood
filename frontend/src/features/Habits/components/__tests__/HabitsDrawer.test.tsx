// Specifies the Habits header drawer: action rows, unlock-all confirm gating,
// row ordering, the page-controls switch, and the "Show Habits" pager row.
import { describe, expect, it, jest, afterEach } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import HabitsDrawer from '../HabitsDrawer';

const noop = (..._args: unknown[]): void => {};

const baseProps = {
  onSelectMode: noop,
  onOpenOnboarding: noop,
  onOpenAddHabit: noop,
  allRevealed: false,
  onToggleReveal: noop,
  page: 0,
  pageCount: 3,
  onPrev: noop,
  onNext: noop,
  stageStart: 1,
  stageEnd: 10,
  barVisible: true,
  onToggleBarVisible: noop,
  onClose: noop,
};

const ROW_ORDER_LABELS: readonly string[] = [
  'Quick Log',
  'Edit',
  'Add Habit',
  'Energy Scaffolding',
  'Stats',
  'Unlock All Habits',
  'Show Habits',
];

interface JsonNode {
  type?: unknown;
  props?: { accessibilityRole?: unknown };
  children?: unknown;
}

// True when a rendered node represents the RN Switch control.
const isSwitchNode = (json: JsonNode): boolean => {
  const role = json.props ? json.props.accessibilityRole : undefined;
  if (role === 'switch') {
    return true;
  }
  return typeof json.type === 'string' && json.type.includes('Switch');
};

// Flattens the rendered tree into row markers: known labels plus the switch.
const collectRowMarkers = (node: unknown, out: string[]): void => {
  if (typeof node === 'string') {
    if (ROW_ORDER_LABELS.includes(node)) {
      out.push(node);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node as unknown[]) {
      collectRowMarkers(child, out);
    }
    return;
  }
  if (node === null || typeof node !== 'object') {
    return;
  }
  const json = node as JsonNode;
  if (isSwitchNode(json)) {
    out.push('switch');
  }
  collectRowMarkers(json.children, out);
};

afterEach(() => {
  jest.clearAllMocks();
});

describe('HabitsDrawer action rows', () => {
  it('fires onSelectMode("quickLog") and closes the drawer', () => {
    const onSelectMode = jest.fn();
    const onClose = jest.fn();
    const { getByRole } = render(
      <HabitsDrawer {...baseProps} onSelectMode={onSelectMode} onClose={onClose} />,
    );
    fireEvent.press(getByRole('button', { name: 'Quick Log' }));
    expect(onSelectMode).toHaveBeenCalledWith('quickLog');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires onSelectMode("stats") and closes the drawer', () => {
    const onSelectMode = jest.fn();
    const onClose = jest.fn();
    const { getByRole } = render(
      <HabitsDrawer {...baseProps} onSelectMode={onSelectMode} onClose={onClose} />,
    );
    fireEvent.press(getByRole('button', { name: 'Stats' }));
    expect(onSelectMode).toHaveBeenCalledWith('stats');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires onSelectMode("edit") and closes the drawer', () => {
    const onSelectMode = jest.fn();
    const onClose = jest.fn();
    const { getByRole } = render(
      <HabitsDrawer {...baseProps} onSelectMode={onSelectMode} onClose={onClose} />,
    );
    fireEvent.press(getByRole('button', { name: 'Edit' }));
    expect(onSelectMode).toHaveBeenCalledWith('edit');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires onOpenAddHabit and closes the drawer', () => {
    const onOpenAddHabit = jest.fn();
    const onClose = jest.fn();
    const { getByRole } = render(
      <HabitsDrawer {...baseProps} onOpenAddHabit={onOpenAddHabit} onClose={onClose} />,
    );
    fireEvent.press(getByRole('button', { name: 'Add Habit' }));
    expect(onOpenAddHabit).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires onOpenOnboarding and closes the drawer', () => {
    const onOpenOnboarding = jest.fn();
    const onClose = jest.fn();
    const { getByRole } = render(
      <HabitsDrawer {...baseProps} onOpenOnboarding={onOpenOnboarding} onClose={onClose} />,
    );
    fireEvent.press(getByRole('button', { name: 'Energy Scaffolding' }));
    expect(onOpenOnboarding).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('HabitsDrawer unlock-all confirm gating', () => {
  it('labels the reveal row "Unlock All Habits" when nothing is unlocked', () => {
    const { getByRole } = render(<HabitsDrawer {...baseProps} allRevealed={false} />);
    expect(getByRole('button', { name: 'Unlock All Habits' })).toBeTruthy();
  });

  it('pressing "Unlock All Habits" opens a confirm dialog instead of firing the toggle', () => {
    const onToggleReveal = jest.fn();
    const onClose = jest.fn();
    const { getByRole, getByTestId } = render(
      <HabitsDrawer
        {...baseProps}
        allRevealed={false}
        onToggleReveal={onToggleReveal}
        onClose={onClose}
      />,
    );
    fireEvent.press(getByRole('button', { name: 'Unlock All Habits' }));
    expect(getByTestId('unlock-all-confirm')).toBeTruthy();
    expect(onToggleReveal).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('confirming the dialog fires onToggleReveal once and closes the drawer', () => {
    const onToggleReveal = jest.fn();
    const onClose = jest.fn();
    const { getByRole, getByTestId } = render(
      <HabitsDrawer
        {...baseProps}
        allRevealed={false}
        onToggleReveal={onToggleReveal}
        onClose={onClose}
      />,
    );
    fireEvent.press(getByRole('button', { name: 'Unlock All Habits' }));
    fireEvent.press(getByTestId('unlock-all-confirm-button'));
    expect(onToggleReveal).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cancelling does not fire onToggleReveal or close the drawer', () => {
    const onToggleReveal = jest.fn();
    const onClose = jest.fn();
    const { getByRole, getByTestId, queryByTestId } = render(
      <HabitsDrawer
        {...baseProps}
        allRevealed={false}
        onToggleReveal={onToggleReveal}
        onClose={onClose}
      />,
    );
    fireEvent.press(getByRole('button', { name: 'Unlock All Habits' }));
    fireEvent.press(getByTestId('unlock-all-cancel'));
    expect(onToggleReveal).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(queryByTestId('unlock-all-confirm')).toBeNull();
  });

  it('locking (allRevealed true) fires onToggleReveal directly with no dialog', () => {
    const onToggleReveal = jest.fn();
    const onClose = jest.fn();
    const { getByRole, queryByTestId } = render(
      <HabitsDrawer {...baseProps} allRevealed onToggleReveal={onToggleReveal} onClose={onClose} />,
    );
    fireEvent.press(getByRole('button', { name: 'Lock Unstarted Habits' }));
    expect(onToggleReveal).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(queryByTestId('unlock-all-confirm')).toBeNull();
  });
});

describe('HabitsDrawer pagination section', () => {
  it('renders the static "Show Habits" label on the pager row', () => {
    const { getByText } = render(<HabitsDrawer {...baseProps} />);
    expect(getByText('Show Habits')).toBeTruthy();
  });

  it('shows the bare stage range with the page position folded into its accessibility label', () => {
    const { getByText } = render(
      <HabitsDrawer {...baseProps} page={0} pageCount={2} stageStart={1} stageEnd={10} />,
    );
    const label = getByText('1–10');
    expect(label.props.accessibilityLabel).toBe('Show habits 1 to 10, page 1 of 2');
  });

  it('shows the second-lap stage range and position', () => {
    const { getByText } = render(
      <HabitsDrawer {...baseProps} page={1} pageCount={2} stageStart={11} stageEnd={20} />,
    );
    const label = getByText('11–20');
    expect(label.props.accessibilityLabel).toBe('Show habits 11 to 20, page 2 of 2');
  });

  it('disables Prev on the first page and enables Next', () => {
    const { getByLabelText } = render(<HabitsDrawer {...baseProps} page={0} pageCount={3} />);
    expect(getByLabelText('Previous page').props.accessibilityState).toEqual({ disabled: true });
    expect(getByLabelText('Next page').props.accessibilityState).toEqual({ disabled: false });
  });

  it('disables Next on the last page and enables Prev', () => {
    const { getByLabelText } = render(<HabitsDrawer {...baseProps} page={2} pageCount={3} />);
    expect(getByLabelText('Previous page').props.accessibilityState).toEqual({ disabled: false });
    expect(getByLabelText('Next page').props.accessibilityState).toEqual({ disabled: true });
  });

  it('disables both Prev and Next when there is only one page', () => {
    const { getByLabelText } = render(<HabitsDrawer {...baseProps} page={0} pageCount={1} />);
    expect(getByLabelText('Previous page').props.accessibilityState).toEqual({ disabled: true });
    expect(getByLabelText('Next page').props.accessibilityState).toEqual({ disabled: true });
  });

  it('Prev fires onPrev without closing the drawer', () => {
    const onPrev = jest.fn();
    const onClose = jest.fn();
    const { getByLabelText } = render(
      <HabitsDrawer {...baseProps} page={1} pageCount={3} onPrev={onPrev} onClose={onClose} />,
    );
    fireEvent.press(getByLabelText('Previous page'));
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Next fires onNext without closing the drawer', () => {
    const onNext = jest.fn();
    const onClose = jest.fn();
    const { getByLabelText } = render(
      <HabitsDrawer {...baseProps} page={0} pageCount={3} onNext={onNext} onClose={onClose} />,
    );
    fireEvent.press(getByLabelText('Next page'));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('HabitsDrawer pagination-bar visibility toggle', () => {
  it('renders a switch that is on and announces "Hide page controls" when the bar is visible', () => {
    const { getByRole } = render(<HabitsDrawer {...baseProps} barVisible />);
    const toggle = getByRole('switch');
    expect(toggle.props.value).toBe(true);
    expect(toggle.props.accessibilityLabel).toBe('Hide page controls');
    expect(toggle.props.accessibilityState.checked).toBe(true);
  });

  it('renders the switch off and announces "Show page controls" when the bar is hidden', () => {
    const { getByRole } = render(<HabitsDrawer {...baseProps} barVisible={false} />);
    const toggle = getByRole('switch');
    expect(toggle.props.value).toBe(false);
    expect(toggle.props.accessibilityLabel).toBe('Show page controls');
    expect(toggle.props.accessibilityState.checked).toBe(false);
  });

  it('toggling the switch fires onToggleBarVisible without closing the drawer', () => {
    const onToggleBarVisible = jest.fn();
    const onClose = jest.fn();
    const { getByRole } = render(
      <HabitsDrawer
        {...baseProps}
        barVisible
        onToggleBarVisible={onToggleBarVisible}
        onClose={onClose}
      />,
    );
    fireEvent(getByRole('switch'), 'valueChange', false);
    expect(onToggleBarVisible).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('HabitsDrawer row order', () => {
  it('renders actions, reveal, the visibility switch, then the pager top-to-bottom', () => {
    const tree = render(<HabitsDrawer {...baseProps} />).toJSON();
    const markers: string[] = [];
    collectRowMarkers(tree, markers);
    expect(markers).toEqual([
      'Quick Log',
      'Edit',
      'Add Habit',
      'Energy Scaffolding',
      'Stats',
      'Unlock All Habits',
      'switch',
      'Show Habits',
    ]);
  });
});
