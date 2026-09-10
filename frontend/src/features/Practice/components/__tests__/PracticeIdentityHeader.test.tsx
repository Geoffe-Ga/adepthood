/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import type { TextStyle, ViewStyle } from 'react-native';

import type { FrequencyResponse } from '@/api';
import { touchTarget } from '@/design/tokens';
import type { StageData } from '@/features/Map/stageData';

// The shape the header consumes from the restored useFrequency hook.
interface FrequencyHookState {
  data: FrequencyResponse | null;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
}

const mockUseFrequency = jest.fn() as jest.MockedFunction<
  (...args: unknown[]) => FrequencyHookState
>;

// Mutable store slice consumed through the useStageStore selector mock below.
const mockStageState: { stagesByNumber: Record<number, StageData> } = { stagesByNumber: {} };

jest.mock('@/features/Practice/hooks/useFrequency', () => {
  const hook = (...args: unknown[]): FrequencyHookState => mockUseFrequency(...args);
  return { __esModule: true, useFrequency: hook, default: hook };
});

jest.mock('@/store/useStageStore', () => ({
  __esModule: true,
  useStageStore: (selector?: (_state: unknown) => unknown) =>
    selector === undefined ? mockStageState : selector(mockStageState),
}));

// Required after the mocks so the factories are registered before the module loads.
const PracticeIdentityHeader = require('../PracticeIdentityHeader').default;

const beigeFrequency: FrequencyResponse = {
  stage_number: 1,
  color: 'Beige',
  aspect: 'Body',
  practice_name: 'Breath Awareness',
  practice_id: 1,
  user_practice_id: 10,
  banner_text: 'You are in the Beige frequency of APTITUDE.',
};

const stageFixture = (
  stageNumber: number,
  spiralDynamicsColor: string,
  aspect: string,
): StageData => ({
  id: stageNumber,
  title: `Stage ${stageNumber}`,
  subtitle: 'A stage of the arc',
  stageNumber,
  progress: 0,
  color: '#CDBA88',
  isUnlocked: true,
  category: 'Foundation',
  aspect,
  spiralDynamicsColor,
  growingUpStage: 'Egocentric',
  divineGenderPolarity: 'Feminine',
  relationshipToFreeWill: 'Emerging',
  freeWillDescription: 'Free will is emerging.',
  overviewUrl: 'https://example.com/stage',
  manifestations: [],
});

/** Minimal shape of a rendered node, for tree walks over `findAll`. */
type TestNode = { props: Record<string, unknown> };

interface HeaderProps {
  stageNumber: number;
  ritualName: string;
  collapsed: boolean;
  onCustomize: () => void;
  onStageChange: (_stage: number) => void;
}

const onCustomize = jest.fn();
const onStageChange = jest.fn();

const renderHeader = (overrides: Partial<HeaderProps> = {}) =>
  render(
    <PracticeIdentityHeader
      stageNumber={1}
      ritualName="Morning Sit"
      collapsed={false}
      onCustomize={onCustomize}
      onStageChange={onStageChange}
      {...overrides}
    />,
  );

describe('PracticeIdentityHeader', () => {
  beforeEach(() => {
    mockStageState.stagesByNumber = {};
    mockUseFrequency.mockReturnValue({
      data: beigeFrequency,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
  });

  it('titles the header with the effective ritual name, rendered once', () => {
    const { getAllByText, getByTestId, queryByTestId } = renderHeader({ ritualName: 'Metta - 30' });
    expect(getByTestId('practice-identity-header')).toBeTruthy();
    // The headline is the user's own name for the ritual, exactly: not the
    // catalog base name, and not that name with anything appended to it.
    expect(getByTestId('practice-identity-title')).toHaveTextContent(/^Metta - 30$/);
    // Once, not twice — the small subline row that used to repeat it is gone.
    expect(getAllByText('Metta - 30')).toHaveLength(1);
    expect(queryByTestId('practice-identity-ritual-name')).toBeNull();
  });

  it('renders the stage chip and pencil with their accessible names', () => {
    const { getByTestId, getByText } = renderHeader();
    expect(getByText('BEIGE · Body')).toBeTruthy();
    const chip = getByTestId('practice-stage-chip');
    expect(chip.props.accessibilityRole).toBe('button');
    expect(chip.props.accessibilityLabel).toBe('Change stage. Current: Beige, Body');
    const pencil = getByTestId('practice-customize-pencil');
    expect(pencil.props.accessibilityRole).toBe('button');
    expect(pencil.props.accessibilityLabel).toBe('Customize this ritual');
  });

  it('sits the pencil on the title row itself, trailing the name', () => {
    const { getByTestId } = renderHeader({ ritualName: 'Metta - 30' });
    const row = getByTestId('practice-identity-title-row');
    const rowStyle = StyleSheet.flatten(row.props.style) as ViewStyle;
    // One row, vertically centred: the pencil is beside the headline, never
    // stacked under it on a line of its own.
    expect(rowStyle.flexDirection).toBe('row');
    expect(rowStyle.alignItems).toBe('center');

    // Both live inside that row, and the title comes first, so the pencil is
    // the trailing element rather than a leading one.
    const ids = row
      .findAll((node: TestNode) => typeof node.props.testID === 'string')
      .map((node: TestNode) => node.props.testID as string);
    const titleAt = ids.indexOf('practice-identity-title');
    const pencilAt = ids.indexOf('practice-customize-pencil');
    expect(titleAt).toBeGreaterThanOrEqual(0);
    expect(pencilAt).toBeGreaterThan(titleAt);

    // The title claims the row's free space, so the pencil is pinned to the
    // trailing edge instead of butting against the last glyph of the name.
    const titleStyle = StyleSheet.flatten(
      getByTestId('practice-identity-title').props.style,
    ) as TextStyle;
    expect(titleStyle.flex).toBe(1);

    // Moving the pencil up a row must not shrink its target.
    const pencilStyle = StyleSheet.flatten(
      getByTestId('practice-customize-pencil').props.style,
    ) as ViewStyle;
    expect(pencilStyle.minWidth).toBe(touchTarget.minimum);
    expect(pencilStyle.minHeight).toBe(touchTarget.minimum);
  });

  it('falls back to the stage store for the chip label when the frequency fetch fails', () => {
    mockUseFrequency.mockReturnValue({
      data: null,
      isLoading: false,
      error: new Error('offline'),
      refetch: jest.fn(),
    });
    mockStageState.stagesByNumber = { 3: stageFixture(3, 'Red', 'Power') };
    const { getByTestId, getByText } = renderHeader({ stageNumber: 3 });
    expect(getByText('RED · Power')).toBeTruthy();
    expect(getByTestId('practice-stage-chip').props.accessibilityLabel).toBe(
      'Change stage. Current: Red, Power',
    );
  });

  it('renders the title without a chip when neither source has stage data', () => {
    mockUseFrequency.mockReturnValue({
      data: null,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    const { getByTestId, queryByTestId } = renderHeader();
    expect(getByTestId('practice-identity-title')).toHaveTextContent(/^Morning Sit$/);
    expect(queryByTestId('practice-stage-chip')).toBeNull();
  });

  it('invokes onCustomize when the pencil is pressed', () => {
    const { getByTestId } = renderHeader();
    fireEvent.press(getByTestId('practice-customize-pencil'));
    expect(onCustomize).toHaveBeenCalledTimes(1);
  });

  it('opens the stage picker from the chip and reports the picked stage', () => {
    const { getByTestId, queryByTestId } = renderHeader();
    expect(queryByTestId('practice-stage-pick-1')).toBeNull();
    fireEvent.press(getByTestId('practice-stage-chip'));
    expect(getByTestId('practice-stage-pick-1')).toBeTruthy();
    expect(getByTestId('practice-stage-pick-10')).toBeTruthy();
    fireEvent.press(getByTestId('practice-stage-pick-3'));
    expect(onStageChange).toHaveBeenCalledWith(3);
  });

  it('cancel dismisses the picker without changing the stage', () => {
    const { getByTestId, queryByTestId } = renderHeader();
    fireEvent.press(getByTestId('practice-stage-chip'));
    fireEvent.press(getByTestId('practice-stage-pick-cancel'));
    expect(queryByTestId('practice-stage-pick-1')).toBeNull();
    expect(onStageChange).not.toHaveBeenCalled();
  });

  it('the backdrop outside the card is a labeled dismiss control', () => {
    const { getByTestId } = renderHeader();
    fireEvent.press(getByTestId('practice-stage-chip'));
    const backdrop = getByTestId('practice-stage-pick-backdrop');
    expect(backdrop.props.accessibilityRole).toBe('button');
    expect(backdrop.props.accessibilityLabel).toBe('Close the stage picker without changing stage');
  });

  it('tapping the backdrop dismisses the picker without picking a stage', () => {
    const { getByTestId, queryByTestId } = renderHeader();
    fireEvent.press(getByTestId('practice-stage-chip'));
    // A dismissal proves nothing unless the picker was open to begin with.
    expect(getByTestId('practice-stage-pick-1')).toBeTruthy();
    expect(getByTestId('practice-stage-pick-cancel')).toBeTruthy();

    fireEvent.press(getByTestId('practice-stage-pick-backdrop'));

    expect(queryByTestId('practice-stage-pick-1')).toBeNull();
    expect(queryByTestId('practice-stage-pick-cancel')).toBeNull();
    // Backing out must never commit the choice the user was backing out of.
    expect(onStageChange).not.toHaveBeenCalled();
  });

  it('tapping the card or its contents does not dismiss the picker', () => {
    const { getByTestId, getByText, queryByTestId } = renderHeader();
    fireEvent.press(getByTestId('practice-stage-chip'));
    expect(getByTestId('practice-stage-pick-1')).toBeTruthy();

    // The card swallows the tap instead of letting it bubble to the backdrop —
    // both for the card itself and for inert content inside it.
    fireEvent.press(getByTestId('practice-stage-pick-card'));
    expect(getByTestId('practice-stage-pick-1')).toBeTruthy();
    fireEvent.press(getByText('Pick a stage'));

    expect(getByTestId('practice-stage-pick-1')).toBeTruthy();
    expect(getByTestId('practice-stage-pick-cancel')).toBeTruthy();
    expect(queryByTestId('practice-stage-pick-backdrop')).not.toBeNull();
    expect(onStageChange).not.toHaveBeenCalled();
  });

  it('the hardware back request dismisses the picker without picking a stage', () => {
    const { getByTestId, queryByTestId } = renderHeader();
    fireEvent.press(getByTestId('practice-stage-chip'));
    expect(getByTestId('practice-stage-pick-1')).toBeTruthy();

    act(() => {
      getByTestId('practice-stage-pick-modal').props.onRequestClose();
    });

    expect(queryByTestId('practice-stage-pick-1')).toBeNull();
    expect(onStageChange).not.toHaveBeenCalled();
  });

  it('collapsed keeps the ritual-name title alone, without chip or pencil', () => {
    const { getByTestId, queryByTestId } = renderHeader({
      collapsed: true,
      ritualName: 'Metta - 30',
    });
    expect(getByTestId('practice-identity-title')).toHaveTextContent(/^Metta - 30$/);
    expect(queryByTestId('practice-stage-chip')).toBeNull();
    expect(queryByTestId('practice-customize-pencil')).toBeNull();
    expect(queryByTestId('practice-identity-ritual-name')).toBeNull();
  });
});
