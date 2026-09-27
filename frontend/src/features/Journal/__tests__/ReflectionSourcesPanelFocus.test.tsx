/**
 * The wide pane's Escape / back handling, proved against a real navigator.
 *
 * native-stack keeps a covered screen mounted. A pane opened after the
 * NavigationContainer mounted registers its back listener AFTER React
 * Navigation's, so -- BackHandler calling the newest listener first -- an armed
 * pane on a covered entry would swallow the back press meant to pop the pushed
 * route (#2883). The pane must only listen while its screen is focused.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { act, fireEvent, render } from '@testing-library/react-native';
import React, { useState } from 'react';
import { BackHandler, Text, TouchableOpacity, View } from 'react-native';
import type { NativeEventSubscription } from 'react-native';

import type { ReflectionSourceItem } from '@/api';

const ReflectionSourcesPanel = require('../ReflectionSourcesPanel').default;
const Platform = require('react-native').Platform as { OS: string };

type StackList = { Entry: undefined; Photograph: undefined };
const Stack = createNativeStackNavigator<StackList>();
const navigationRef = createNavigationContainerRef<StackList>();

const SOURCE: ReflectionSourceItem = {
  kind: 'entry',
  id: 1,
  title: 'Walk',
  timestamp: '2026-06-01T00:00:00Z',
  body: 'By the river.',
  reflection_level: null,
  promoted_quotes: [],
};

let onClose: jest.Mock;

/** An entry screen whose pane is opened by a tap, i.e. after the container mounted. */
function EntryScreen(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <TouchableOpacity testID="open-sources" onPress={() => setOpen(true)}>
        <Text>Sources</Text>
      </TouchableOpacity>
      {open ? (
        <ReflectionSourcesPanel
          items={[SOURCE]}
          onInsertQuote={jest.fn()}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        />
      ) : null}
    </View>
  );
}

function PhotographScreen(): React.JSX.Element {
  return <Text testID="photograph">Photograph</Text>;
}

/** BackHandler as Android runs it: newest listener first, stop at the first `true`. */
function fakeBackHandler(): () => void {
  const handlers: Array<() => boolean | null | undefined> = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    const entry = handler as () => boolean;
    handlers.push(entry);
    return {
      remove: () => {
        const at = handlers.indexOf(entry);
        if (at !== -1) handlers.splice(at, 1);
      },
    } as unknown as NativeEventSubscription;
  });
  return () => {
    act(() => {
      for (let index = handlers.length - 1; index >= 0; index -= 1) {
        if (handlers[index]?.()) return;
      }
    });
  };
}

function mountStack() {
  const rn = require('react-native');
  jest
    .spyOn(rn, 'useWindowDimensions')
    .mockReturnValue({ width: 1280, height: 900, scale: 1, fontScale: 1 });
  return render(
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Entry" component={EntryScreen} />
        <Stack.Screen name="Photograph" component={PhotographScreen} />
      </Stack.Navigator>
    </NavigationContainer>,
  );
}

describe('ReflectionSourcesPanel -- dismiss keys follow screen focus (#2883)', () => {
  beforeEach(() => {
    onClose = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('closes the pane on back while its screen is focused', () => {
    const pressBack = fakeBackHandler();
    const screen = mountStack();
    fireEvent.press(screen.getByTestId('open-sources'));
    expect(screen.getByTestId('reflection-sources-pane')).toBeTruthy();
    pressBack();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(navigationRef.getCurrentRoute()?.name).toBe('Entry');
  });

  it('lets back pop a pushed screen instead of closing the covered pane', () => {
    const pressBack = fakeBackHandler();
    const screen = mountStack();
    fireEvent.press(screen.getByTestId('open-sources'));
    act(() => {
      navigationRef.navigate('Photograph');
    });
    expect(navigationRef.getCurrentRoute()?.name).toBe('Photograph');
    pressBack();
    expect(onClose).not.toHaveBeenCalled();
    expect(navigationRef.getCurrentRoute()?.name).toBe('Entry');
    // Back on the entry, the pane is still open and owns back again.
    expect(screen.getByTestId('reflection-sources-pane')).toBeTruthy();
    pressBack();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape on web while the entry is covered by a pushed screen', () => {
    const globalRef = globalThis as { document?: Document };
    const original = Platform.OS;
    const target = new EventTarget();
    globalRef.document = Object.assign(target, {
      querySelector: () => null,
    }) as unknown as Document;
    const escape = () => {
      const event = new Event('keydown');
      Object.defineProperty(event, 'key', { value: 'Escape' });
      act(() => {
        target.dispatchEvent(event);
      });
    };
    try {
      const screen = mountStack();
      Platform.OS = 'web';
      fireEvent.press(screen.getByTestId('open-sources'));
      act(() => {
        navigationRef.navigate('Photograph');
      });
      escape();
      expect(onClose).not.toHaveBeenCalled();
      act(() => {
        navigationRef.goBack();
      });
      escape();
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      Platform.OS = original;
      delete globalRef.document;
    }
  });
});
