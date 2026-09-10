/**
 * `PracticeIdentityHeader` — the player identity block at the top of the dark
 * Practice screen: a tappable stage chip (`COLOR · aspect`) over the ritual's
 * own name as the display title, with a pencil that opens the ritual
 * configurator riding the trailing edge of that same row. The title is the
 * effective name — the one the practitioner gave their copy ("Metta - 30"),
 * not the catalog base name it was copied from. That base name stays
 * discoverable in the Catalog (`PracticeCatalogList` renders `practice.name`)
 * and nowhere else on this path -- the configurator the pencil opens is seeded
 * with the effective name, so it shows the practitioner their own name back.
 * While a session holds the engine (`collapsed`) the block quiets down to that
 * title alone.
 *
 * The chip's identity comes from the server frequency payload
 * (`useFrequency`), falling back to the stage store when the fetch fails;
 * with neither source the chip is simply omitted — never a crash, never a
 * dead control. Tapping the chip opens a light stage-picker card over the
 * dark ground; picking a stage reports it upward and the parent re-drives
 * the load, while a tap on the dimmed ground outside the card backs out of the
 * invitation exactly as Cancel does. All text on the umber ground uses
 * `onShowcase.*` ink so every label clears WCAG AA contrast.
 */
import { Pencil } from 'lucide-react-native';
import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

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
  /** The effective ritual name: the user's own name for their copy. */
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

/**
 * Stable no-op that swallows taps landing on the card, so choosing a stage
 * never bubbles out to the backdrop and dismisses the picker underfoot.
 */
const SWALLOW_PRESS = (): void => {};

// A light picker card floating over the dark player: StageSelector's own
// light-surface tokens are correct here because the card provides the light
// ground the chips were designed for. Every way out of the card — the backdrop,
// Cancel, and the Android back button / iOS dismissal via `onRequestClose` —
// runs the same `onCancel`, so backing out can never commit a stage.
const StagePickerModal = ({
  visible,
  onPick,
  onCancel,
}: StagePickerModalProps): React.JSX.Element => (
  <Modal
    animationType="fade"
    onRequestClose={onCancel}
    transparent
    visible={visible}
    testID="practice-stage-pick-modal"
  >
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Close the stage picker without changing stage"
      onPress={onCancel}
      style={styles.pickerBackdrop}
      testID="practice-stage-pick-backdrop"
    >
      <Pressable
        // `accessible={false}` keeps the card a plain container for screen
        // readers: the chips and Cancel stay individually reachable rather than
        // collapsing into one giant button.
        accessible={false}
        onPress={SWALLOW_PRESS}
        style={styles.pickerCard}
        testID="practice-stage-pick-card"
      >
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
      </Pressable>
    </Pressable>
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
      <View style={styles.titleRow} testID="practice-identity-title-row">
        <Text style={styles.title} testID="practice-identity-title">
          {ritualName}
        </Text>
        {!collapsed && <PencilButton onPress={onCustomize} />}
      </View>
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
  titleRow: { alignItems: 'center', flexDirection: 'row' },
  // The title claims the row's free space, so the pencil rides the trailing
  // edge rather than butting against the last glyph of the name, and a long
  // name wraps inside the row instead of pushing the pencil off the screen.
  title: { ...editorialType.display, color: onShowcase.primary, flex: 1 },
  pencilButton: {
    alignItems: 'center',
    justifyContent: 'center',
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
