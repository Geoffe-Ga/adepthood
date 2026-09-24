import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Inbox } from 'lucide-react-native';
import React from 'react';

import * as copy from './copy';
import { useAdminCapability } from './useAdminCapability';

import { EditorialSection } from '@/components/layout/EditorialSection';
import { SettingsRow } from '@/features/Settings/shared/SettingsRow';
import type { RootStackParamList } from '@/navigation/RootStack';

/**
 * The Settings entry to the feedback inbox, drawn only for a confirmed operator.
 *
 * Renders nothing while the capability is unknown, unavailable or refused, so a
 * non-operator never sees that the inbox exists -- and the row cannot flash in
 * and out, because it waits for the server's answer rather than guessing.
 */
export function AdminInboxSettingsSection(): React.JSX.Element | null {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { capability } = useAdminCapability();
  if (capability !== 'admin') return null;
  return (
    <EditorialSection title={copy.SETTINGS_SECTION_TITLE} testID="settings-group-beta-operations">
      <SettingsRow
        icon={Inbox}
        label={copy.SETTINGS_ROW_LABEL}
        description={copy.SETTINGS_ROW_DESCRIPTION}
        onPress={() => navigation.navigate('AdminFeedback')}
        testID="settings-row-feedback-inbox"
      />
    </EditorialSection>
  );
}
