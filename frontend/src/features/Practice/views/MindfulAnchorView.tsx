/**
 * `MindfulAnchorView` — single-action ritual UX for Touch Grass / Mindful
 * Eating and similar `mindful_anchor` practices.
 *
 * Unlike the step-based modes there is no `currentStepIndex`: the flow is
 * "Begin → Save", which maps onto the engine `status` transitions
 * `idle → running → complete`. The view owns its option selection and a
 * 1-Hz local elapsed counter (display only — it never mutates engine
 * state); on save it emits a `MindfulAnchorMetadata` payload upward.
 *
 * The `min_duration_seconds` floor is a *soft* gate: saving below it pops a
 * confirmation rather than blocking, so a user with a real reason to cut
 * the session short can still record it.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type {
  MindfulAnchorConfig,
  MindfulAnchorMetadata,
  MindfulAnchorOption,
  RitualControls,
  RitualState,
} from '../engine/types';
import { MS_PER_SECOND } from '../engine/types';

import { formatTime } from './formatTime';
import RitualControlsBar from './RitualControlsBar';
import type { SessionSurface } from './sessionSurface';
import { useSessionSurface } from './sessionSurface';
import {
  PRIMARY_FILL,
  SESSION_BUTTON_BASE,
  SESSION_BUTTON_TEXT,
  SESSION_CAPTION_LABEL,
  SESSION_LIST_MAX_HEIGHT,
  SessionContainer,
  SessionCtaButton,
} from './shared';

import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';

/** Caps the instruction card so long copy stays readable on wide screens. */
const INSTRUCTION_CARD_MAX_WIDTH = 340;

interface Props {
  config: MindfulAnchorConfig;
  state: RitualState;
  controls: RitualControls;
  /**
   * Receives the session payload the instant the user confirms Save.
   * Required: `ActiveRitualSession` always wires this so the dispatcher
   * can harvest `MindfulAnchorMetadata`.
   */
  onComplete: (_metadata: MindfulAnchorMetadata) => void;
}

interface AnchorState {
  selectedOptionKey: string | null;
  setSelectedOptionKey: (_key: string) => void;
  elapsedSeconds: number;
  confirmVisible: boolean;
  hideConfirm: () => void;
  commit: () => void;
  handleSave: () => void;
}

/**
 * Owns the view-local session state: the chosen option, a 1-Hz elapsed
 * counter (display + gate only — it never touches the engine), and the
 * soft-gate confirmation visibility.
 */
function useAnchorState(
  config: MindfulAnchorConfig,
  controls: RitualControls,
  status: RitualState['status'],
  onComplete: Props['onComplete'],
): AnchorState {
  const [selectedOptionKey, setSelectedOptionKey] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [confirmVisible, setConfirmVisible] = useState(false);

  const tick = useCallback(() => setElapsedSeconds((seconds) => seconds + 1), []);

  useEffect(() => {
    if (status !== 'running') return undefined;
    const handle = setInterval(tick, MS_PER_SECOND);
    return () => clearInterval(handle);
  }, [status, tick]);

  // A return to `idle` means cancel (or a fresh session): wipe local state.
  useEffect(() => {
    if (status !== 'idle') return;
    setSelectedOptionKey(null);
    setElapsedSeconds(0);
    setConfirmVisible(false);
  }, [status]);

  // `elapsedSeconds` is in the dep array, so `commit` always re-binds to the
  // latest tick — including the seconds that pass while the soft-gate confirm
  // dialog sits open. The saved `duration_seconds` reflects the moment the
  // user actually confirms, not the moment they first tapped Save.
  const commit = useCallback(() => {
    setConfirmVisible(false);
    onComplete({
      mode: 'mindful_anchor',
      chosen_option_key: selectedOptionKey,
      duration_seconds: elapsedSeconds,
      met_min_duration: elapsedSeconds >= config.min_duration_seconds,
    });
    controls.complete();
  }, [config.min_duration_seconds, controls, elapsedSeconds, onComplete, selectedOptionKey]);

  const handleSave = useCallback(() => {
    if (elapsedSeconds >= config.min_duration_seconds) commit();
    else setConfirmVisible(true);
  }, [commit, config.min_duration_seconds, elapsedSeconds]);

  const hideConfirm = useCallback(() => setConfirmVisible(false), []);

  return {
    selectedOptionKey,
    setSelectedOptionKey,
    elapsedSeconds,
    confirmVisible,
    hideConfirm,
    commit,
    handleSave,
  };
}

const MindfulAnchorView = ({ config, state, controls, onComplete }: Props): React.JSX.Element => {
  const { status } = state;
  const surface = useSessionSurface();
  const anchor = useAnchorState(config, controls, status, onComplete);
  const beginDisabled = config.require_option_choice && anchor.selectedOptionKey === null;
  return (
    <SessionContainer testID="mindful-anchor-view">
      <InstructionCard instruction={config.instruction} surface={surface} />
      {status === 'idle' && config.options.length > 0 && (
        <ScrollView style={styles.chooserScroll}>
          <OptionChooser
            options={config.options}
            selectedKey={anchor.selectedOptionKey}
            onSelect={anchor.setSelectedOptionKey}
            surface={surface}
          />
        </ScrollView>
      )}
      {status === 'running' && <ElapsedDisplay seconds={anchor.elapsedSeconds} surface={surface} />}
      {status === 'idle' ? (
        <BeginButton disabled={beginDisabled} onPress={controls.start} />
      ) : (
        <RitualControlsBar status={status} controls={controls} startLabel="Begin" />
      )}
      {status === 'running' && (
        <SessionCtaButton
          variant="success"
          label="Save session"
          accessibilityLabel="Save session"
          onPress={anchor.handleSave}
          testID="mindful-anchor-save"
          style={{ marginTop: SPACING.lg }}
        />
      )}
      <ConfirmDialog
        visible={anchor.confirmVisible}
        seconds={anchor.elapsedSeconds}
        onCancel={anchor.hideConfirm}
        onConfirm={anchor.commit}
      />
    </SessionContainer>
  );
};

interface InstructionCardProps {
  instruction: string;
  surface: SessionSurface;
}

const InstructionCard = ({ instruction, surface }: InstructionCardProps): React.JSX.Element => (
  <View
    style={[styles.instructionCard, { backgroundColor: surface.raised }]}
    testID="mindful-anchor-instruction"
  >
    <Text style={[styles.instructionText, { color: surface.text }]}>{instruction}</Text>
  </View>
);

interface OptionChooserProps {
  options: readonly MindfulAnchorOption[];
  selectedKey: string | null;
  onSelect: (_key: string) => void;
  surface: SessionSurface;
}

const OptionChooser = ({
  options,
  selectedKey,
  onSelect,
  surface,
}: OptionChooserProps): React.JSX.Element => (
  <View
    style={styles.chooser}
    testID="mindful-anchor-options"
    accessibilityRole="radiogroup"
    accessibilityLabel="Choose an anchor"
  >
    {options.map((option) => (
      <OptionRow
        key={option.key}
        option={option}
        selected={option.key === selectedKey}
        onSelect={onSelect}
        surface={surface}
      />
    ))}
  </View>
);

interface OptionRowProps {
  option: MindfulAnchorOption;
  selected: boolean;
  onSelect: (_key: string) => void;
  surface: SessionSurface;
}

const OptionRow = ({ option, selected, onSelect, surface }: OptionRowProps): React.JSX.Element => (
  <Pressable
    style={[
      styles.option,
      { borderColor: surface.textMuted },
      selected && [styles.optionSelected, { backgroundColor: surface.raised }],
    ]}
    onPress={() => onSelect(option.key)}
    testID={`mindful-anchor-option-${option.key}`}
    accessibilityRole="radio"
    accessibilityLabel={option.label}
    accessibilityState={{ selected }}
  >
    <Text style={[styles.optionLabel, { color: surface.text }]}>{option.label}</Text>
    {option.description && (
      <Text style={[styles.optionDescription, { color: surface.textSoft }]}>
        {option.description}
      </Text>
    )}
  </Pressable>
);

interface ElapsedDisplayProps {
  seconds: number;
  surface: SessionSurface;
}

const ElapsedDisplay = ({ seconds, surface }: ElapsedDisplayProps): React.JSX.Element => (
  <View
    style={styles.elapsedBlock}
    testID="mindful-anchor-elapsed"
    accessibilityLiveRegion="polite"
  >
    <Text
      style={[styles.elapsedTime, { color: surface.text }]}
      testID="mindful-anchor-elapsed-time"
    >
      {formatTime(seconds * MS_PER_SECOND)}
    </Text>
    <Text style={[styles.elapsedLabel, { color: surface.textSoft }]}>elapsed</Text>
  </View>
);

interface BeginButtonProps {
  disabled: boolean;
  onPress: () => void;
}

const BeginButton = ({ disabled, onPress }: BeginButtonProps): React.JSX.Element => (
  <Pressable
    style={[styles.begin, disabled && styles.disabled]}
    onPress={disabled ? undefined : onPress}
    disabled={disabled}
    testID="mindful-anchor-begin"
    accessibilityRole="button"
    accessibilityLabel="Begin"
    accessibilityState={{ disabled }}
  >
    <Text style={styles.beginText}>Begin</Text>
  </Pressable>
);

interface ConfirmDialogProps {
  visible: boolean;
  seconds: number;
  onCancel: () => void;
  onConfirm: () => void;
}

const ConfirmDialog = ({
  visible,
  seconds,
  onCancel,
  onConfirm,
}: ConfirmDialogProps): React.JSX.Element | null => {
  // Null-render while hidden (matching `InsightCaptureModal`) so the
  // confirm content is absent from the tree, not merely visually hidden.
  if (!visible) return null;
  const spent = `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      testID="mindful-anchor-confirm"
    >
      <View style={styles.backdrop}>
        <View style={styles.dialog}>
          <Text style={styles.dialogTitle}>Take another moment?</Text>
          <Text style={styles.dialogBody} testID="mindful-anchor-confirm-message">
            {`It looks like you only spent ${spent} here. Take another moment, or save anyway?`}
          </Text>
          <Pressable
            style={styles.dialogPrimary}
            onPress={onCancel}
            testID="mindful-anchor-confirm-cancel"
            accessibilityRole="button"
            accessibilityLabel="Keep going"
          >
            <Text style={styles.dialogPrimaryText}>Keep going</Text>
          </Pressable>
          <Pressable
            style={styles.dialogSecondary}
            onPress={onConfirm}
            testID="mindful-anchor-confirm-save"
            accessibilityRole="button"
            accessibilityLabel="Save anyway"
          >
            <Text style={styles.dialogSecondaryText}>Save anyway</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  instructionCard: {
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.xl,
    marginBottom: SPACING.xl,
    maxWidth: INSTRUCTION_CARD_MAX_WIDTH,
    ...shadows.small,
  },
  instructionText: {
    fontSize: 20,
    fontWeight: '500',
    textAlign: 'center',
    lineHeight: 28,
  },
  // The wrapper owns the outer margin so long option lists scroll inside the cap.
  chooserScroll: {
    alignSelf: 'stretch',
    maxHeight: SESSION_LIST_MAX_HEIGHT,
    marginBottom: SPACING.xl,
  },
  chooser: { alignSelf: 'stretch', gap: SPACING.sm },
  option: {
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
  },
  // Selection highlight: brand border reads as the active cue on either ground.
  optionSelected: {
    borderColor: colors.primary,
  },
  optionLabel: { fontSize: 16, fontWeight: '600' },
  optionDescription: {
    fontSize: 13,
    marginTop: SPACING.xs,
  },
  elapsedBlock: { alignItems: 'center', marginBottom: SPACING.xl },
  elapsedTime: {
    fontSize: 56,
    fontWeight: '200',
    fontVariant: ['tabular-nums'],
  },
  elapsedLabel: {
    ...SESSION_CAPTION_LABEL,
    marginTop: SPACING.xs,
  },
  begin: { ...SESSION_BUTTON_BASE, ...PRIMARY_FILL, marginBottom: SPACING.xl },
  beginText: { ...SESSION_BUTTON_TEXT },
  disabled: { opacity: 0.5 },
  backdrop: {
    flex: 1,
    backgroundColor: colors.mystical.overlay,
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
  },
  dialog: {
    backgroundColor: colors.background.card,
    borderRadius: BORDER_RADIUS.xl,
    padding: SPACING.xl,
    gap: SPACING.sm,
    ...shadows.large,
  },
  dialogTitle: { fontSize: 20, fontWeight: '700', color: colors.text.primary },
  dialogBody: {
    fontSize: 14,
    color: colors.text.secondaryAccessible,
    marginBottom: SPACING.sm,
    lineHeight: 20,
  },
  dialogPrimary: {
    backgroundColor: colors.primary,
    paddingVertical: SPACING.buttonV,
    borderRadius: BORDER_RADIUS.lg,
    alignItems: 'center',
  },
  dialogPrimaryText: { color: colors.text.light, fontSize: 16, fontWeight: '600' },
  dialogSecondary: { paddingVertical: SPACING.md, alignItems: 'center' },
  dialogSecondaryText: { color: colors.text.tertiaryAccessible, fontSize: 15 },
});

export default MindfulAnchorView;
