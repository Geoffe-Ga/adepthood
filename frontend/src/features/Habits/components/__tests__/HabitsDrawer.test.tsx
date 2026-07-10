// RED: HabitsDrawer does not exist yet -- this import fails until the
// implementation-specialist adds the component. Specifies the header-drawer
// replacement for the removed in-body overflow menu and pagination bar:
// action rows, unlock-all confirm gating, pagination controls, and the
// pagination-visibility toggle.
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
  it('shows the stage range as the visible label with the page position folded into its accessibility label', () => {
    const { getByText } = render(
      <HabitsDrawer {...baseProps} page={0} pageCount={2} stageStart={1} stageEnd={10} />,
    );
    const label = getByText('Stages 1–10');
    expect(label.props.accessibilityLabel).toBe('Stages 1 to 10, page 1 of 2');
  });

  it('shows the second-lap stage range and position', () => {
    const { getByText } = render(
      <HabitsDrawer {...baseProps} page={1} pageCount={2} stageStart={11} stageEnd={20} />,
    );
    const label = getByText('Stages 11–20');
    expect(label.props.accessibilityLabel).toBe('Stages 11 to 20, page 2 of 2');
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
  it('labels the toggle "Hide page controls" when the bar is visible', () => {
    const { getByRole } = render(<HabitsDrawer {...baseProps} barVisible />);
    expect(getByRole('button', { name: 'Hide page controls' })).toBeTruthy();
  });

  it('labels the toggle "Show page controls" when the bar is hidden', () => {
    const { getByRole } = render(<HabitsDrawer {...baseProps} barVisible={false} />);
    expect(getByRole('button', { name: 'Show page controls' })).toBeTruthy();
  });

  it('fires onToggleBarVisible without closing the drawer', () => {
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
    fireEvent.press(getByRole('button', { name: 'Hide page controls' }));
    expect(onToggleBarVisible).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
