/* eslint-env jest */
// Candle & Ink token guards for the Habit edit modals: settings card + reorder card shadows, CTA/pill colors, and header/label type, pinned to their semantic token values against the legacy values.

import { describe, expect, it, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import type { Habit, HabitSettingsModalProps } from '../../Habits.types';
import { HabitSettingsModal } from '../HabitSettingsModal';
import ReorderHabitsModal from '../ReorderHabitsModal';

import { accent, colors, fonts, ink, shadows, surface, surfaceShadow } from '@/design/tokens';

jest.mock('react-native-draggable-flatlist', () => 'DraggableFlatList');
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
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
jest.mock('react-native-modal-datetime-picker', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
  removeItem: jest.fn(() => Promise.resolve()),
}));

const baseHabit: Habit = {
  id: 42,
  stage: 'Beige',
  name: 'Morning walk',
  icon: '🚶',
  streak: 3,
  energy_cost: 3,
  energy_return: 5,
  start_date: new Date('2026-01-01T00:00:00.000Z'),
  goals: [],
  notificationFrequency: 'daily',
  notificationTimes: [],
  notificationDays: [],
  milestoneNotifications: false,
};

const renderSettingsModal = (overrides: Partial<HabitSettingsModalProps> = {}) =>
  render(
    <HabitSettingsModal
      visible
      habit={baseHabit}
      onClose={jest.fn()}
      onUpdate={jest.fn()}
      onDelete={jest.fn()}
      onOpenReorderModal={jest.fn()}
      allHabits={[baseHabit]}
      {...overrides}
    />,
  );

const makeHabit = (id: number, stage: string, name: string): Habit => ({
  id,
  stage,
  name,
  icon: '⭐',
  streak: 0,
  energy_cost: 1,
  energy_return: 1,
  start_date: new Date('2026-01-01'),
  goals: [],
});

const HABITS: Habit[] = [makeHabit(1, 'Beige', 'A'), makeHabit(2, 'Purple', 'B')];

const renderReorderModal = () =>
  render(
    <ReorderHabitsModal visible habits={HABITS} onClose={jest.fn()} onSaveOrder={jest.fn()} />,
  );

// Shared flatten helper (same pattern as CreatePracticeWizardTokens.test.tsx).
const flatten = (style: unknown): Record<string, unknown> =>
  StyleSheet.flatten(style as never) as Record<string, unknown>;

// Guard 1: settings card shadowRadius resolves to surfaceShadow.raised (18), not legacy shadows.large (4).
describe('Candle & Ink token guard — settings card shadow (habit-settings-card)', () => {
  it('settings card shadowRadius resolves to surfaceShadow.raised', () => {
    const { getByTestId } = renderSettingsModal();
    const card = getByTestId('habit-settings-card');
    expect(flatten(card.props.style).shadowRadius).toBe(surfaceShadow.raised.shadowRadius);
  });

  it('settings card shadowRadius does NOT use the legacy shadows.large value', () => {
    const { getByTestId } = renderSettingsModal();
    const card = getByTestId('habit-settings-card');
    expect(flatten(card.props.style).shadowRadius).not.toBe(shadows.large.shadowRadius);
  });
});

// Guard 2: reorder card shadowRadius resolves to surfaceShadow.raised (18), not legacy shadows.large (4).
describe('Candle & Ink token guard — reorder card shadow (reorder-modal-card)', () => {
  it('reorder card shadowRadius resolves to surfaceShadow.raised', () => {
    const { getByTestId } = renderReorderModal();
    const card = getByTestId('reorder-modal-card');
    expect(flatten(card.props.style).shadowRadius).toBe(surfaceShadow.raised.shadowRadius);
  });

  it('reorder card shadowRadius does NOT use the legacy shadows.large value', () => {
    const { getByTestId } = renderReorderModal();
    const card = getByTestId('reorder-modal-card');
    expect(flatten(card.props.style).shadowRadius).not.toBe(shadows.large.shadowRadius);
  });
});

// Guard 3: Save Changes background resolves to accent.primary, not legacy colors.success.
describe('Candle & Ink token guard — settings save CTA (habit-settings-save)', () => {
  it('save button background resolves to accent.primary', () => {
    const { getByTestId } = renderSettingsModal();
    const save = getByTestId('habit-settings-save');
    expect(flatten(save.props.style).backgroundColor).toBe(accent.primary);
  });

  it('save button does NOT use the legacy colors.success', () => {
    const { getByTestId } = renderSettingsModal();
    const save = getByTestId('habit-settings-save');
    expect(flatten(save.props.style).backgroundColor).not.toBe(colors.success);
  });
});

// Guard 4: Save Order background resolves to accent.primary, not legacy colors.success.
describe('Candle & Ink token guard — reorder save CTA (reorder-save-order)', () => {
  it('save order button background resolves to accent.primary', () => {
    const { getByTestId } = renderReorderModal();
    const save = getByTestId('reorder-save-order');
    expect(flatten(save.props.style).backgroundColor).toBe(accent.primary);
  });

  it('save order button does NOT use the legacy colors.success', () => {
    const { getByTestId } = renderReorderModal();
    const save = getByTestId('reorder-save-order');
    expect(flatten(save.props.style).backgroundColor).not.toBe(colors.success);
  });
});

// Guard 5: Reorder Habits pill border resolves to accent.primary, not legacy colors.primary solid fill.
describe('Candle & Ink token guard — reorder-habits action (habit-settings-reorder)', () => {
  it('reorder button border resolves to accent.primary', () => {
    const { getByTestId } = renderSettingsModal();
    const reorder = getByTestId('habit-settings-reorder');
    expect(flatten(reorder.props.style).borderColor).toBe(accent.primary);
  });

  it('reorder button does NOT use the legacy colors.primary solid fill', () => {
    const { getByTestId } = renderSettingsModal();
    const reorder = getByTestId('habit-settings-reorder');
    expect(flatten(reorder.props.style).backgroundColor).not.toBe(colors.primary);
  });
});

// Guard 6: Delete Habit pill border resolves to colors.destructive.border, not legacy colors.danger solid fill.
describe('Candle & Ink token guard — delete-habit action (habit-settings-delete)', () => {
  it('delete button border resolves to colors.destructive.border', () => {
    const { getByTestId } = renderSettingsModal();
    const del = getByTestId('habit-settings-delete');
    expect(flatten(del.props.style).borderColor).toBe(colors.destructive.border);
  });

  it('delete button does NOT use the legacy colors.danger solid fill', () => {
    const { getByTestId } = renderSettingsModal();
    const del = getByTestId('habit-settings-delete');
    expect(flatten(del.props.style).backgroundColor).not.toBe(colors.danger);
  });
});

// Guard 7: frequency pill background resolves to surface.sunken, not legacy colors.secondary.
describe('Candle & Ink token guard — frequency pill (habit-settings-frequency)', () => {
  it('frequency pill background resolves to surface.sunken', () => {
    const { getByTestId } = renderSettingsModal();
    const pill = getByTestId('habit-settings-frequency');
    expect(flatten(pill.props.style).backgroundColor).toBe(surface.sunken);
  });

  it('frequency pill does NOT use the legacy colors.secondary', () => {
    const { getByTestId } = renderSettingsModal();
    const pill = getByTestId('habit-settings-frequency');
    expect(flatten(pill.props.style).backgroundColor).not.toBe(colors.secondary);
  });
});

// Guard 8: settings header resolves to fonts.serif, not fonts.sans.
describe('Candle & Ink token guard — settings header serif (Edit Habit)', () => {
  it('header resolves to fonts.serif', () => {
    const { getByText } = renderSettingsModal();
    const header = getByText('Edit Habit');
    expect(flatten(header.props.style).fontFamily).toBe(fonts.serif);
  });

  it('header does NOT use fonts.sans', () => {
    const { getByText } = renderSettingsModal();
    const header = getByText('Edit Habit');
    expect(flatten(header.props.style).fontFamily).not.toBe(fonts.sans);
  });
});

// Guard 9: reorder header resolves to fonts.serif, not fonts.sans.
describe('Candle & Ink token guard — reorder header serif (Reorder Habits)', () => {
  it('header resolves to fonts.serif', () => {
    const { getByText } = renderReorderModal();
    const header = getByText('Reorder Habits');
    expect(flatten(header.props.style).fontFamily).toBe(fonts.serif);
  });

  it('header does NOT use fonts.sans', () => {
    const { getByText } = renderReorderModal();
    const header = getByText('Reorder Habits');
    expect(flatten(header.props.style).fontFamily).not.toBe(fonts.sans);
  });
});

// Guard 10: the "Name:" field label resolves to ink.primary, not legacy colors.text.primary.
describe('Candle & Ink token guard — Name label ink (Name:)', () => {
  it('label color resolves to ink.primary', () => {
    const { getByText } = renderSettingsModal();
    const label = getByText('Name:');
    expect(flatten(label.props.style).color).toBe(ink.primary);
  });

  it('label does NOT use the legacy colors.text.primary', () => {
    const { getByText } = renderSettingsModal();
    const label = getByText('Name:');
    expect(flatten(label.props.style).color).not.toBe(colors.text.primary);
  });
});
