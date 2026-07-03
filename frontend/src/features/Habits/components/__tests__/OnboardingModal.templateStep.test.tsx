import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { render, fireEvent, act } from '@testing-library/react-native';
import type { ReactElement, ReactNode } from 'react';

const OnboardingModal = require('../OnboardingModal').default;

jest.mock('../../constants', () => ({
  ...(jest.requireActual('../../constants') as Record<string, unknown>),
  DEFAULT_ICONS: ['⭐'],
}));
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children: ReactNode }) => children,
  Gesture: {
    LongPress: () => ({ minDuration: () => ({ onStart: () => ({}) }) }),
    Pan: () => ({ onBegin: () => ({}) }),
    Race: () => ({}),
  },
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  View: require('react-native').View,
}));
jest.mock('react-native-draggable-flatlist', () => {
  const React = require('react');
  const { View } = require('react-native');
  return ({
    data,
    renderItem,
    onDragEnd,
    testID,
    contentContainerStyle,
    ListHeaderComponent,
    ListFooterComponent,
  }: {
    data: { id: string }[];
    renderItem: (info: {
      item: { id: string };
      index: number;
      drag: () => void;
      isActive: boolean;
      getIndex: () => number;
    }) => ReactElement;
    onDragEnd?: (info: unknown) => void;
    testID?: string;
    contentContainerStyle?: unknown;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => (
    <View testID={testID} onDragEnd={onDragEnd} data={data} style={contentContainerStyle}>
      {ListHeaderComponent}
      {data.map((item, index) =>
        React.cloneElement(
          renderItem({ item, index, drag: jest.fn(), isActive: false, getIndex: () => index }),
          { key: item.id },
        ),
      )}
      {ListFooterComponent}
    </View>
  );
});
jest.mock('../../../../api', () => ({
  goalGroups: {
    list: jest.fn(() =>
      Promise.resolve([
        { id: 1, name: 'Meditation Goals', icon: '🧘', shared_template: true, goals: [] },
        { id: 2, name: 'Private Goals', icon: '🔒', shared_template: false, goals: [] },
        { id: 3, name: 'Unlabeled Goals', shared_template: true, goals: [] },
      ]),
    ),
  },
}));

const STAGGER_DELAY_MS = 150;
const SORT_PAUSE_MS = 500;

const advanceToTemplatesGate = (result: ReturnType<typeof render>) => {
  const input = result.getByPlaceholderText('Enter habit name');
  fireEvent.changeText(input, 'Habit A');
  fireEvent(input, 'onKeyPress', { nativeEvent: { key: 'Enter' } });

  fireEvent.press(result.getByTestId('continue-button'));
  const warn = result.queryByTestId('count-warning-continue');
  if (warn) fireEvent.press(warn);
  fireEvent.press(result.getByTestId('continue-button'));

  act(() => {
    fireEvent.press(result.getByTestId('continue-button'));
  });
  act(() => {
    jest.advanceTimersByTime(STAGGER_DELAY_MS + SORT_PAUSE_MS + 100);
  });
};

describe('OnboardingModal template step (success path)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('lists only shared templates and hides private ones', async () => {
    const result = render(<OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />);
    advanceToTemplatesGate(result);

    await act(async () => {
      fireEvent.press(result.getByTestId('continue-to-templates'));
      await jest.advanceTimersByTimeAsync(10);
    });

    expect(result.getByText(/Meditation Goals/)).toBeTruthy();
    expect(result.queryByText(/Private Goals/)).toBeNull();
  });

  it('renders a template missing an icon without crashing', async () => {
    const result = render(<OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />);
    advanceToTemplatesGate(result);

    await act(async () => {
      fireEvent.press(result.getByTestId('continue-to-templates'));
      await jest.advanceTimersByTimeAsync(10);
    });

    expect(result.getByText(/Unlabeled Goals/)).toBeTruthy();
  });

  it('assigns a selected template to the habit and includes it when saving', async () => {
    const onSave = jest.fn();
    const result = render(<OnboardingModal visible onClose={jest.fn()} onSaveHabits={onSave} />);
    advanceToTemplatesGate(result);

    await act(async () => {
      fireEvent.press(result.getByTestId('continue-to-templates'));
      await jest.advanceTimersByTimeAsync(10);
    });

    fireEvent.press(result.getByTestId('template-1-0'));
    fireEvent.press(result.getByTestId('finish-setup'));

    const saved = (
      onSave.mock.calls[0]?.[0] as { goal_group_id: number | null }[] | undefined
    )?.[0];
    expect(saved?.goal_group_id).toBe(1);
  });

  it('reassigning None after selecting a template clears the goal_group_id', async () => {
    const onSave = jest.fn();
    const result = render(<OnboardingModal visible onClose={jest.fn()} onSaveHabits={onSave} />);
    advanceToTemplatesGate(result);

    await act(async () => {
      fireEvent.press(result.getByTestId('continue-to-templates'));
      await jest.advanceTimersByTimeAsync(10);
    });

    fireEvent.press(result.getByTestId('template-1-0'));
    fireEvent.press(result.getByTestId('template-none-0'));
    fireEvent.press(result.getByTestId('finish-setup'));

    const saved = (
      onSave.mock.calls[0]?.[0] as { goal_group_id: number | null }[] | undefined
    )?.[0];
    expect(saved?.goal_group_id).toBeNull();
  });

  it('returns to the reorder step via the Back button', async () => {
    const result = render(<OnboardingModal visible onClose={jest.fn()} onSaveHabits={jest.fn()} />);
    advanceToTemplatesGate(result);

    await act(async () => {
      fireEvent.press(result.getByTestId('continue-to-templates'));
      await jest.advanceTimersByTimeAsync(10);
    });

    fireEvent.press(result.getByText('Back'));
    // Back returns to step 4; the reveal phase reset to idle on the way out, so
    // the reorder step re-renders with its pre-reveal header and the templates CTA.
    expect(result.getByText('Reorder Your Habits')).toBeTruthy();
    expect(result.getByTestId('continue-to-templates')).toBeTruthy();
  });
});
