import { describe, expect, it, jest } from '@jest/globals';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { act, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import RootStack, { type RootStackParamList } from '../RootStack';

/**
 * RootStack registers the operator inbox as a real route.
 *
 * Every screen is replaced by a named placeholder, so what is under test is the
 * navigator's route table rather than any screen: navigating to
 * ``AdminFeedback`` must land on the inbox screen module, and a route that was
 * dropped from the stack (while its param type stayed) is an error here rather
 * than a Settings row that opens nothing.
 */

function mockPlaceholder(name: string): () => React.JSX.Element {
  return () => <Text testID={`screen-${name}`}>{name}</Text>;
}

jest.mock('../BottomTabs', () => ({ __esModule: true, default: mockPlaceholder('Tabs') }));
jest.mock('@/features/AdminFeedback/AdminFeedbackScreen', () => ({
  __esModule: true,
  default: mockPlaceholder('AdminFeedback'),
}));
jest.mock('@/features/Journal/JournalEntryScreen', () => ({
  __esModule: true,
  default: mockPlaceholder('x'),
}));
jest.mock('@/features/Journal/JournalPhotographScreen', () => ({
  __esModule: true,
  default: mockPlaceholder('x'),
}));
jest.mock('@/features/Journal/VoiceDraftsShelfScreen', () => ({
  __esModule: true,
  default: mockPlaceholder('x'),
}));
jest.mock('@/features/Practice/screens/CreatePracticeWizard', () => ({
  CreatePracticeWizard: mockPlaceholder('x'),
}));
jest.mock('@/features/Practice/screens/PracticeCatalogScreen', () => ({
  PracticeCatalogScreen: mockPlaceholder('x'),
}));
jest.mock('@/features/Practice/screens/PracticeDetailScreen', () => ({
  PracticeDetailScreen: mockPlaceholder('x'),
}));
jest.mock('@/features/Practice/screens/SharePreviewScreen', () => ({
  __esModule: true,
  default: mockPlaceholder('x'),
}));
jest.mock('@/features/Seed/SeedCorpusScreen', () => ({
  __esModule: true,
  default: mockPlaceholder('x'),
}));
jest.mock('@/features/Settings/ApiKeySettingsScreen', () => ({
  __esModule: true,
  default: mockPlaceholder('x'),
}));
jest.mock('@/features/Settings/CorpusConsentScreen', () => ({
  __esModule: true,
  default: mockPlaceholder('x'),
}));
jest.mock('@/features/Settings/DeleteAccountScreen', () => ({
  __esModule: true,
  default: mockPlaceholder('x'),
}));
jest.mock('@/features/Settings/ExportDataScreen', () => ({
  __esModule: true,
  default: mockPlaceholder('x'),
}));
jest.mock('@/features/Settings/PrivateVaultActivationScreen', () => ({
  __esModule: true,
  default: mockPlaceholder('x'),
}));
jest.mock('@/features/Settings/SettingsHubScreen', () => ({
  __esModule: true,
  default: mockPlaceholder('x'),
}));
jest.mock('@/features/Settings/SupportCareScreen', () => ({
  __esModule: true,
  default: mockPlaceholder('x'),
}));
jest.mock('@/features/Settings/TimezoneSettingsScreen', () => ({
  __esModule: true,
  default: mockPlaceholder('x'),
}));
jest.mock('@/features/Settings/VaultSettingsScreen', () => ({
  __esModule: true,
  default: mockPlaceholder('x'),
}));

describe('RootStack', () => {
  it('routes AdminFeedback to the operator inbox screen', async () => {
    const ref = createNavigationContainerRef<RootStackParamList>();
    const screen = render(
      <NavigationContainer ref={ref}>
        <RootStack />
      </NavigationContainer>,
    );
    expect(screen.getByTestId('screen-Tabs')).toBeTruthy();

    await act(async () => {
      ref.navigate('AdminFeedback');
    });

    expect(screen.getByTestId('screen-AdminFeedback')).toBeTruthy();
    expect(ref.getCurrentRoute()?.name).toBe('AdminFeedback');
  });
});
