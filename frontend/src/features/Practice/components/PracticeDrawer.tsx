/**
 * The Practice header-drawer body, rendered as ScreenDrawer children. Offers the
 * catalog/customize/log/details/create actions in the active state and a
 * pared-down browse/create pair when no practice is set for the stage.
 */
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  CalendarClock,
  Compass,
  Info,
  Plus,
  RefreshCw,
  SlidersHorizontal,
} from 'lucide-react-native';
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
  /**
   * Opens the sheet for logging a sitting done away from the timer. Modal-based,
   * so it never unmounts the engine — but still withheld mid-session, because
   * recording a second sitting while one is running is not a coherent action.
   */
  onLogSession: () => void;
  onClose: () => void;
}

interface DrawerRow {
  testID: string;
  label: string;
  Icon: typeof RefreshCw;
  run: () => void;
}

/** Assemble one row; keeps `usePracticeRows` a readable list of its rows. */
const row = (
  testID: string,
  label: string,
  Icon: DrawerRow['Icon'],
  run: () => void,
): DrawerRow => ({ testID, label, Icon, run });

/**
 * Builds the ordered rows for the current state. The active state exposes the
 * full set (change/browse/customize/log/details/create); the empty state offers
 * only browse and create — there is nothing to log a session against until a
 * practice is set. "Practice details" appears only when a practiceId resolves.
 * Catalog rows flip the player's embedded Catalog tab in place; details/create
 * remain pushed routes. While a session is running or paused the in-place
 * catalog rows are withheld — flipping the tab would unmount the live engine —
 * and so is the manual log row.
 */
function usePracticeRows({
  hasActivePractice,
  practiceId,
  onCustomize,
  onBrowseCatalog,
  sessionActive,
  onLogSession,
}: Omit<PracticeDrawerProps, 'onClose'>): DrawerRow[] {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const browse = row('practice-drawer-browse', 'Browse all practices', Compass, onBrowseCatalog);
  const create = row('practice-drawer-create', 'Create a practice', Plus, () =>
    navigation.navigate('CreatePractice'),
  );
  if (!hasActivePractice) return [browse, create];
  const change = row('practice-drawer-change', 'Change practice', RefreshCw, onBrowseCatalog);
  const customize = row(
    'practice-drawer-customize',
    'Customize this practice',
    SlidersHorizontal,
    onCustomize,
  );
  const log = row('practice-drawer-log', 'Log a practice', CalendarClock, onLogSession);
  // Withhold the tab-flip rows mid-session; keep the modal/push-based rows.
  const rows: DrawerRow[] = sessionActive ? [customize] : [change, browse, customize, log];
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
