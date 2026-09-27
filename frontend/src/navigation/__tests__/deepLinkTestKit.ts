/**
 * Resolve a screen's route params through the **real** ``linking`` config
 * (#2958), so a screen spec receives exactly what a deep link delivers.
 *
 * A spec that hand-writes ``{ stageNumber: 1 }`` proves nothing about deep
 * links: React Navigation hands path segments to screens as strings, and only
 * the ``parse`` step in ``navigation/linking`` turns them back into numbers.
 * Routing the params through {@link tabParamsFromPath} means deleting that
 * ``parse`` step turns the screen spec red.
 *
 * ``getStateFromPath`` is taken via ``jest.requireActual`` because several
 * screen specs mock ``@react-navigation/native`` wholesale without spreading
 * the real module.
 */
import { jest } from '@jest/globals';
import type * as NativeModule from '@react-navigation/native';

import type { RootTabParamList } from '@/navigation/BottomTabs';
import { linking } from '@/navigation/linking';

interface ResolvedRoute {
  name: string;
  params?: object;
  state?: { routes: ResolvedRoute[] };
}

/** The route ``path`` lands on: the focused tab inside ``Tabs``, else the top route. */
function resolveRoute(path: string): ResolvedRoute | undefined {
  const { getStateFromPath } = jest.requireActual<typeof NativeModule>('@react-navigation/native');
  const top: ResolvedRoute | undefined = getStateFromPath(path, linking.config)?.routes[0];
  return top?.name === 'Tabs' ? top.state?.routes[0] : top;
}

/**
 * Parse ``path`` with the app's linking config and return the params that
 * land on the ``tab`` screen inside ``Tabs``.
 *
 * Throws when the path resolves anywhere else, so a typo in a spec's path
 * fails loudly rather than rendering the screen with no params.
 */
export function tabParamsFromPath<T extends keyof RootTabParamList>(
  path: string,
  tab: T,
): RootTabParamList[T] {
  const route = resolveRoute(path);
  if (route?.name !== tab) {
    throw new Error(
      `deep link '${path}' resolved to '${route?.name ?? 'nothing'}', not the ${tab} tab`,
    );
  }
  return route.params as RootTabParamList[T];
}
