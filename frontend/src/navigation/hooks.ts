import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { RouteProp } from '@react-navigation/native';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import type { RootTabParamList } from './BottomTabs';
import type { RootStackParamList } from './RootStack';

/**
 * Typed wrapper around useNavigation for the bottom tab navigator.
 * Provides compile-time checking of route names and parameters.
 */
export function useAppNavigation(): BottomTabNavigationProp<RootTabParamList> {
  return useNavigation<BottomTabNavigationProp<RootTabParamList>>();
}

/**
 * Typed wrapper around useRoute for a specific screen in the bottom tab navigator.
 * Usage: const route = useAppRoute<'Practice'>()
 */
export function useAppRoute<T extends keyof RootTabParamList>(): RouteProp<RootTabParamList, T> {
  return useRoute<RouteProp<RootTabParamList, T>>();
}

/**
 * Typed wrapper around useNavigation for the root stack, for a component deep
 * inside a screen that has no ``navigation`` prop of its own to hand.
 */
export function useRootNavigation(): NativeStackNavigationProp<RootStackParamList> {
  return useNavigation<NativeStackNavigationProp<RootStackParamList>>();
}
