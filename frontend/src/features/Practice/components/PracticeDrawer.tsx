/**
 * The Practice header-drawer body, rendered as ScreenDrawer children. Offers the
 * catalog/customize/details/create actions in the active state and a pared-down
 * browse/create pair when no practice is set for the stage.
 */
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Compass, Info, Plus, RefreshCw, SlidersHorizontal } from 'lucide-react-native';
import React from 'react';
import { View } from 'react-native';

import { DrawerItem } from '@/components/drawer';
import { accent } from '@/design/tokens';
import type { RootStackParamList } from '@/navigation/RootStack';

/** Lucide glyph size in dp for the drawer's row icons. */
const ICON_SIZE = 20;

export interface PracticeDrawerProps {
  hasActivePractice: boolean;
  practiceId?: number;
  onCustomize: () => void;
  /** Flip the Practice player to its embedded Catalog tab (no push nav). */
  onBrowseCatalog: () => void;
  /**
   * True while the ritual engine is running or paused. The in-place catalog
   * rows unmount that engine, so they are withheld until the session ends.
   */
  sessionActive: boolean;
  onClose: () => void;
}

interface DrawerRow {
  testID: string;
  label: string;
  Icon: typeof RefreshCw;
  run: () => void;
}

/**
 * Builds the ordered rows for the current state. The active state exposes the
 * full set (change/browse/customize/details/create); the empty state offers only
 * browse and create. "Practice details" appears only when a practiceId resolves.
 * Catalog rows flip the player's embedded Catalog tab in place; details/create
 * remain pushed routes. While a session is running or paused the in-place
 * catalog rows are withheld — flipping the tab would unmount the live engine.
 */
function usePracticeRows({
  hasActivePractice,
  practiceId,
  onCustomize,
  onBrowseCatalog,
  sessionActive,
}: Omit<PracticeDrawerProps, 'onClose'>): DrawerRow[] {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const browse: DrawerRow = {
    testID: 'practice-drawer-browse',
    label: 'Browse all practices',
    Icon: Compass,
    run: onBrowseCatalog,
  };
  const create: DrawerRow = {
    testID: 'practice-drawer-create',
    label: 'Create a practice',
    Icon: Plus,
    run: () => navigation.navigate('CreatePractice'),
  };
  if (!hasActivePractice) return [browse, create];
  const change: DrawerRow = {
    testID: 'practice-drawer-change',
    label: 'Change practice',
    Icon: RefreshCw,
    run: onBrowseCatalog,
  };
  const customize: DrawerRow = {
    testID: 'practice-drawer-customize',
    label: 'Customize this practice',
    Icon: SlidersHorizontal,
    run: onCustomize,
  };
  // Withhold the tab-flip rows mid-session; keep the modal/push-based rows.
  const rows: DrawerRow[] = sessionActive ? [customize] : [change, browse, customize];
  if (practiceId !== undefined) {
    rows.push({
      testID: 'practice-drawer-details',
      label: 'Practice details',
      Icon: Info,
      run: () => navigation.navigate('PracticeDetail', { practiceId }),
    });
  }
  rows.push(create);
  return rows;
}

/** The Practice header-drawer body: state-conditioned action rows. */
export default function PracticeDrawer(props: PracticeDrawerProps): React.JSX.Element {
  const { onClose } = props;
  const rows = usePracticeRows(props);
  return (
    <View>
      {rows.map((row) => (
        <DrawerItem
          key={row.testID}
          testID={row.testID}
          label={row.label}
          icon={<row.Icon size={ICON_SIZE} color={accent.primary} />}
          onPress={() => {
            row.run();
            onClose();
          }}
        />
      ))}
    </View>
  );
}
