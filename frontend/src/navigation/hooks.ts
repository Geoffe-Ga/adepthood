import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { RouteProp } from '@react-navigation/native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useMemo } from 'react';

import type { RootTabParamList } from './BottomTabs';

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
 * BUG-FRONTEND-INFRA-023 — a single helper that always returns a narrowed
 * object with the shape callers expect, replacing the scattered
 * ``route.params?.field ?? fallback`` chains. Callers get defaulted values
 * out of the box and don't have to re-audit every path when a new param is
 * added upstream.
 *
 * The ``defaults`` object is merged on top of the current params so:
 *
 *   - Missing params fall back to the default value.
 *   - Explicit ``undefined`` in params is treated as "not set" and uses the
 *     default.
 *   - ``null`` is preserved (so "user deliberately cleared this") is
 *     distinguishable from "not set".
 */
export function useRouteParams<T extends keyof RootTabParamList, Defaults extends object>(
  screen: T,
  defaults: Defaults,
): Defaults & NonNullable<RootTabParamList[T]> {
  void screen; // only used for the phantom type constraint
  const route = useAppRoute<T>();
  return useMemo(() => {
    const params = (route.params ?? {}) as Record<string, unknown>;
    const merged = { ...defaults } as Record<string, unknown>;
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) merged[k] = v;
    }
    return merged as Defaults & NonNullable<RootTabParamList[T]>;
  }, [route.params, defaults]);
}
