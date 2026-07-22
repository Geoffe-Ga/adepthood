/**
 * ``PracticeCatalogScreen`` — the pushed RootStack catalog route: a light
 * safe-area shell around the shared ``PracticeCatalogList`` body. The list
 * itself (sections, filters, Use/copy flows) lives in ``PracticeCatalogList``
 * so the Practice player can embed the same catalog in place; this wrapper
 * keeps the pushed route's light canvas and pop-on-activate defaults.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { surface } from '@/design/tokens';
import PracticeCatalogList, {
  type CatalogProps,
} from '@/features/Practice/screens/PracticeCatalogList';

export type { CatalogProps } from '@/features/Practice/screens/PracticeCatalogList';

/** Light, safe-area-padded catalog screen for the pushed ``Catalog`` route. */
export function PracticeCatalogScreen(props: CatalogProps = {}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const containerStyle = [styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }];

  return (
    <View style={containerStyle} testID="practice-catalog-safe-area">
      <PracticeCatalogList {...props} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: surface.canvas },
});

export default PracticeCatalogScreen;
