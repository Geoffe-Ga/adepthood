import React, { useEffect } from 'react';
import { StyleSheet, Switch, Text, useWindowDimensions, View } from 'react-native';

import type { DepthPreferencesUpdate } from '@/api';
import { EditorialSection } from '@/components/layout/EditorialSection';
import { useAuth } from '@/context/AuthContext';
import { accent, ink, rhythm, surface, touchTarget, type as typeRamp } from '@/design/tokens';
import {
  load,
  selectEnableCourse,
  selectEnableHabits,
  selectEnablePractices,
  selectEnableSangha,
  update,
  useDepthPreferencesStore,
} from '@/store/useDepthPreferencesStore';

/**
 * "Choose your depths" — the Settings surface for the you-choose-your-depth ring
 * toggles. The journal floor is always on and is stated as text, never a switch:
 * turning any of the four optional depths off is a valid choice, not a loss, so
 * the copy stays invitational and free of streak-shame or pressure.
 *
 * State is read straight from the depth-preferences store (no local mirror) and
 * loaded once on mount; each toggle dispatches a single-key partial update.
 */

const SECTION_TITLE = 'Choose your depths';

/** The always-on journal floor — stated, never toggled (em dash U+2014). */
const FLOOR_STATEMENT =
  'Your journal is always here — the floor beneath everything. Nothing below is required.';

/** Framing caption: turning a depth off is a choice, not a loss. */
const FRAMING_CAPTION =
  'Turn any depth on or off whenever it fits your life. Turning one off is a choice, not a loss.';

/** One optional depth: its label, store key, and stable testID slug. */
interface DepthDefinition {
  key: 'habits' | 'practices' | 'course' | 'sangha';
  label: string;
  enableKey: keyof DepthPreferencesUpdate;
}

const DEPTHS: readonly DepthDefinition[] = [
  { key: 'habits', label: 'Habits', enableKey: 'enable_habits' },
  { key: 'practices', label: 'Practices', enableKey: 'enable_practices' },
  { key: 'course', label: 'Course', enableKey: 'enable_course' },
  { key: 'sangha', label: 'Sangha', enableKey: 'enable_sangha' },
] as const;

interface DepthToggleRowProps {
  label: string;
  value: boolean;
  testID: string;
  rowTestID: string;
  onValueChange: (_value: boolean) => void;
}

/** A single ring row: a labelled switch on a >=44dp touch target. */
const DepthToggleRow = ({
  label,
  value,
  testID,
  rowTestID,
  onValueChange,
}: DepthToggleRowProps): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return (
    <View style={styles.row} testID={rowTestID}>
      <Text style={[t.body, styles.rowLabel]}>{label}</Text>
      <Switch
        testID={testID}
        accessibilityRole="switch"
        accessibilityLabel={label}
        accessibilityState={{ checked: value }}
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: surface.hairline, true: accent.primary }}
        thumbColor={surface.raised}
      />
    </View>
  );
};

const ChooseDepthsSection = (): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const { token } = useAuth();

  const enabled = {
    habits: useDepthPreferencesStore(selectEnableHabits),
    practices: useDepthPreferencesStore(selectEnablePractices),
    course: useDepthPreferencesStore(selectEnableCourse),
    sangha: useDepthPreferencesStore(selectEnableSangha),
  };

  useEffect(() => {
    if (token) void load(token);
  }, [token]);

  return (
    <EditorialSection title={SECTION_TITLE} testID="settings-group-depths">
      <Text
        style={[t.body, styles.floorLine]}
        accessibilityRole="text"
        testID="depths-floor-statement"
      >
        {FLOOR_STATEMENT}
      </Text>
      <Text style={[t.caption, styles.caption]}>{FRAMING_CAPTION}</Text>
      {DEPTHS.map((depth) => (
        <DepthToggleRow
          key={depth.key}
          label={depth.label}
          value={enabled[depth.key]}
          testID={`depth-toggle-${depth.key}`}
          rowTestID={`depth-row-${depth.key}`}
          onValueChange={(value) => void update({ [depth.enableKey]: value }, token ?? undefined)}
        />
      ))}
    </EditorialSection>
  );
};

const styles = StyleSheet.create({
  floorLine: {
    color: ink.primary,
  },
  caption: {
    color: ink.soft,
    marginTop: rhythm.blockGap / 3,
    marginBottom: rhythm.blockGap,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: touchTarget.minimum,
    paddingVertical: rhythm.blockGap,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: surface.hairline,
  },
  rowLabel: {
    color: ink.primary,
  },
});

export default ChooseDepthsSection;
