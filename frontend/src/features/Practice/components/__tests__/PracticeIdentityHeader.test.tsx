/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { FrequencyResponse } from '@/api';
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

interface HeaderProps {
  stageNumber: number;
  practiceName: string;
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
      practiceName="Breath Awareness"
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

  it('renders the title, ritual name, and stage chip from the frequency payload', () => {
    const { getByTestId, getByText } = renderHeader();
    expect(getByTestId('practice-identity-header')).toBeTruthy();
    expect(getByTestId('practice-identity-title')).toHaveTextContent('Breath Awareness');
    expect(getByTestId('practice-identity-ritual-name')).toHaveTextContent('Morning Sit');
    expect(getByText('BEIGE · Body')).toBeTruthy();
    const chip = getByTestId('practice-stage-chip');
    expect(chip.props.accessibilityRole).toBe('button');
    expect(chip.props.accessibilityLabel).toBe('Change stage. Current: Beige, Body');
    const pencil = getByTestId('practice-customize-pencil');
    expect(pencil.props.accessibilityRole).toBe('button');
    expect(pencil.props.accessibilityLabel).toBe('Customize this ritual');
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
    expect(getByTestId('practice-identity-title')).toHaveTextContent('Breath Awareness');
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

  it('collapsed hides the chip, ritual name, and pencil but keeps the title', () => {
    const { getByTestId, queryByTestId } = renderHeader({ collapsed: true });
    expect(getByTestId('practice-identity-title')).toHaveTextContent('Breath Awareness');
    expect(queryByTestId('practice-stage-chip')).toBeNull();
    expect(queryByTestId('practice-customize-pencil')).toBeNull();
    expect(queryByTestId('practice-identity-ritual-name')).toBeNull();
  });
});
