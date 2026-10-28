import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { TrendingUp } from 'lucide-react-native';
import React from 'react';

import { DrawerItem } from '@/components/drawer';
import { accent } from '@/design/tokens';
import type { RootStackParamList } from '@/navigation/RootStack';
import {
  selectEnableHabits,
  selectEnablePractices,
  useDepthPreferencesStore,
} from '@/store/useDepthPreferencesStore';

/** Lucide glyph size for the door's row, matching the drawer's other rows. */
const DOOR_ICON_SIZE = 20;

/**
 * The Map's "Your progress" door (#3528). Hidden when neither the habits nor
 * the practice ring is on: with both off there is no rhythm, arc birth or
 * energy to show, and the door would open onto nothing chosen.
 */
export function ProgressDoor({ onOpen }: { onOpen?: () => void }): React.JSX.Element | null {
  const habits = useDepthPreferencesStore(selectEnableHabits);
  const practices = useDepthPreferencesStore(selectEnablePractices);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  if (!habits && !practices) return null;
  return (
    <DrawerItem
      testID="map-progress-door"
      label="Your progress"
      icon={<TrendingUp size={DOOR_ICON_SIZE} color={accent.primary} />}
      onPress={() => {
        onOpen?.();
        navigation.navigate('Progress');
      }}
    />
  );
}
