/* eslint-disable import/order */
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import renderer from 'react-test-renderer';
import { OnboardingModal } from '../components/OnboardingModal';

void React;

jest.mock('react-native-emoji-selector', () => 'EmojiSelector');
jest.mock('react-native-draggable-flatlist', () => 'DraggableFlatList');
jest.mock('../HabitsScreen', () => ({ DEFAULT_ICONS: ['😀'] }));

jest.mock('@react-native-community/datetimepicker', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return ({ testID }: { testID?: string }) => <Text testID={testID}>picker</Text>;
});

describe('OnboardingModal date picker', () => {
  it('shows a date picker when start date button is pressed', () => {
    const testRenderer = renderer.create(
      <OnboardingModal visible initialStep={4} onClose={() => null} onSaveHabits={() => null} />,
    );
    const root = testRenderer.root;
    expect(root.findAllByProps({ testID: 'start-date-picker' }).length).toBe(0);
    renderer.act(() => {
      root.findByProps({ testID: 'start-date-button' }).props.onPress();
    });
    expect(root.findAllByProps({ testID: 'start-date-picker' }).length).toBeGreaterThan(0);
  });
});
