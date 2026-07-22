/**
 * `PracticeIdentityHeader` — the player identity block at the top of the dark
 * Practice screen: the practice title, a tappable stage chip
 * (`COLOR · aspect`), the user's effective ritual name when it differs from
 * the title, and a pencil that opens the ritual configurator. While a session
 * holds the engine (`collapsed`) it quiets down to the title alone.
 *
 * The chip's identity comes from the server frequency payload
 * (`useFrequency`), falling back to the stage store when the fetch fails;
 * with neither source the chip is simply omitted — never a crash, never a
 * dead control. Tapping the chip opens a light stage-picker card over the
 * dark ground; picking a stage reports it upward and the parent re-drives
 * the load. All text on the umber ground uses `onShowcase.*` ink so every
 * label clears WCAG AA contrast.
 */
import { Pencil } from 'lucide-react-native';
import React, { useState } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import {
  BORDER_RADIUS,
  SPACING,
  accent,
  colors,
  editorialType,
  ink,
  onShowcase,
  surface,
  surfaceShadow,
  touchTarget,
} from '@/design/tokens';
import StageSelector from '@/features/Practice/components/StageSelector';
import { useFrequency } from '@/features/Practice/hooks/useFrequency';
import { useStageStore } from '@/store/useStageStore';

/** Icon glyph size inside the (44pt-minimum) pencil touch target. */
const PENCIL_ICON_SIZE = 18;

export interface PracticeIdentityHeaderProps {
  stageNumber: number;
  practiceName: string;
  ritualName: string;
  collapsed: boolean;
  onCustomize: () => void;
  onStageChange: (_stage: number) => void;
}

/** The color/aspect pairing the stage chip displays. */
interface StageIdentity {
  color: string;
  aspect: string;
}

/** Server frequency first; the stage store as the offline fallback. */
function useStageIdentity(stageNumber: number): StageIdentity | null {
  const { data } = useFrequency(stageNumber);
  const storeStage = useStageStore((s) => s.stagesByNumber[stageNumber]);
  if (data) return { color: data.color, aspect: data.aspect };
  if (storeStage) return { color: storeStage.spiralDynamicsColor, aspect: storeStage.aspect };
  return null;
}

interface StageChipProps {
  identity: StageIdentity;
  onPress: () => void;
}

const StageChip = ({ identity, onPress }: StageChipProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={`Change stage. Current: ${identity.color}, ${identity.aspect}`}
    onPress={onPress}
    style={styles.stageChip}
    testID="practice-stage-chip"
  >
    <Text style={styles.stageChipText}>
      {`${identity.color.toUpperCase()} · ${identity.aspect}`}
    </Text>
  </TouchableOpacity>
);

interface StagePickerModalProps {
  visible: boolean;
  onPick: (_stage: number) => void;
  onCancel: () => void;
}

// A light picker card floating over the dark player: StageSelector's own
// light-surface tokens are correct here because the card provides the light
// ground the chips were designed for.
const StagePickerModal = ({
  visible,
  onPick,
  onCancel,
}: StagePickerModalProps): React.JSX.Element => (
  <Modal animationType="fade" onRequestClose={onCancel} transparent visible={visible}>
    <View style={styles.pickerBackdrop}>
      <View style={styles.pickerCard}>
        <Text style={styles.pickerHeading} accessibilityRole="header">
          Pick a stage
        </Text>
        <StageSelector variant="picker" onSelect={onPick} testIDPrefix="practice-stage-pick" />
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={onCancel}
          style={styles.pickerCancel}
          testID="practice-stage-pick-cancel"
        >
          <Text style={styles.pickerCancelText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
  </Modal>
);

const PencilButton = ({ onPress }: { onPress: () => void }): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel="Customize this ritual"
    onPress={onPress}
    style={styles.pencilButton}
    testID="practice-customize-pencil"
  >
    <Pencil color={onShowcase.soft} size={PENCIL_ICON_SIZE} />
  </TouchableOpacity>
);

const PracticeIdentityHeader = ({
  stageNumber,
  practiceName,
  ritualName,
  collapsed,
  onCustomize,
  onStageChange,
}: PracticeIdentityHeaderProps): React.JSX.Element => {
  const identity = useStageIdentity(stageNumber);
  const [pickerOpen, setPickerOpen] = useState(false);
  const handlePick = (stage: number): void => {
    onStageChange(stage);
    setPickerOpen(false);
  };
  return (
    <View style={styles.header} testID="practice-identity-header">
      {!collapsed && identity !== null && (
        <StageChip identity={identity} onPress={() => setPickerOpen(true)} />
      )}
      <Text style={styles.title} testID="practice-identity-title">
        {practiceName}
      </Text>
      {!collapsed && (
        <View style={styles.ritualRow}>
          {ritualName !== practiceName && (
            <Text style={styles.ritualName} testID="practice-identity-ritual-name">
              {ritualName}
            </Text>
          )}
          <PencilButton onPress={onCustomize} />
        </View>
      )}
      {!collapsed && (
        <StagePickerModal
          visible={pickerOpen}
          onPick={handlePick}
          onCancel={() => setPickerOpen(false)}
        />
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  header: { marginBottom: SPACING.md },
  stageChip: {
    alignSelf: 'flex-start',
    borderColor: onShowcase.muted,
    borderRadius: BORDER_RADIUS.circle,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    marginBottom: SPACING.sm,
    minHeight: touchTarget.minimum,
    paddingHorizontal: SPACING.md,
  },
  stageChipText: { ...editorialType.action, color: onShowcase.soft, letterSpacing: 1 },
  title: { ...editorialType.display, color: onShowcase.primary },
  ritualRow: { alignItems: 'center', flexDirection: 'row', marginTop: SPACING.xs },
  ritualName: { ...editorialType.note, color: onShowcase.soft, flex: 1 },
  pencilButton: {
    alignItems: 'center',
    justifyContent: 'center',
    // Auto margin keeps the pencil pinned to the trailing edge even when the
    // ritual name is deduped away.
    marginLeft: 'auto',
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
  },
  pickerBackdrop: {
    backgroundColor: colors.mystical.overlay,
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
  },
  pickerCard: {
    backgroundColor: surface.raised,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
    ...surfaceShadow.card,
  },
  pickerHeading: {
    color: ink.primary,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: SPACING.sm,
  },
  pickerCancel: {
    alignSelf: 'flex-end',
    justifyContent: 'center',
    marginTop: SPACING.sm,
    minHeight: touchTarget.minimum,
    paddingHorizontal: SPACING.sm,
  },
  pickerCancelText: { ...editorialType.action, color: accent.primary },
});

export default PracticeIdentityHeader;
