/**
 * ``ResonanceExplainerDialog`` — the one beat between "Get Resonance" and a
 * charged pass.
 *
 * Presentational only, and deliberately so: it never reaches the resonance API
 * itself. It reports which arm was taken and the host runs (or does not run) the
 * single existing ``requestResonance``. A dialog that could start a pass of its
 * own would be a second charge path beside the button's, and the two would
 * eventually disagree about whether one had already been spent.
 *
 * The two arms are the same shape and the same distance from the thumb, and the
 * scrim dismisses to the same place as "Not now": backing out of a charge must
 * never be the harder gesture. The "don’t show this again" box starts unticked
 * and is a plain checkbox to assistive tech, so a reader who wants the note to
 * keep appearing does nothing to keep it.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import JournalModalShell from './JournalModalShell';
import {
  RESONANCE_EXPLAINER_CANCEL,
  RESONANCE_EXPLAINER_CANCEL_A11Y,
  RESONANCE_EXPLAINER_CHOICE,
  RESONANCE_EXPLAINER_CONTINUE,
  RESONANCE_EXPLAINER_CONTINUE_A11Y,
  RESONANCE_EXPLAINER_DONT_SHOW,
  RESONANCE_EXPLAINER_DONT_SHOW_A11Y,
  RESONANCE_EXPLAINER_SCRIM_A11Y,
  RESONANCE_EXPLAINER_TITLE,
  RESONANCE_EXPLAINER_WHAT,
} from './resonanceExplainerCopy';

import {
  BORDER_RADIUS,
  colors,
  editorialType,
  journalLayout,
  spacing,
  touchTarget,
} from '@/design/tokens';

export interface ResonanceExplainerDialogProps {
  visible: boolean;
  /** Truthful price copy resolved from key presence and the served allowance. */
  cost: string;
  /** Prevent a pass while the payer is unknown or its wallet is exhausted. */
  continueDisabled: boolean;
  /** Whether the reader has ticked "don’t show this again" on this showing. */
  dontShowAgain: boolean;
  onToggleDontShowAgain: () => void;
  /** Take the charged arm — the host runs the pass. */
  onContinue: () => void;
  /** Leave without a pass. Also what the scrim and the hardware back do. */
  onCancel: () => void;
}

/** The tick box, as a real checkbox rather than a pressable label. */
function DontShowAgain({
  checked,
  onToggle,
}: {
  checked: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.checkboxRow}
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={RESONANCE_EXPLAINER_DONT_SHOW_A11Y}
      testID="resonance-explainer-dont-show"
    >
      <Text style={styles.checkboxMark}>{checked ? '✓' : ' '}</Text>
      <Text style={styles.checkboxLabel}>{RESONANCE_EXPLAINER_DONT_SHOW}</Text>
    </TouchableOpacity>
  );
}

/**
 * The two arms, side by side and the same size.
 *
 * Extracted as its own component so the fact that they are one row of equal
 * halves is stated once, in one place, rather than being a property of how the
 * card happens to be laid out. Only the fill differs, and it names which arm
 * spends money — not which one we would rather the reader took.
 */
function ExplainerActions({
  continueDisabled,
  onContinue,
  onCancel,
}: {
  continueDisabled: boolean;
  onContinue: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.actions}>
      <TouchableOpacity
        style={styles.action}
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel={RESONANCE_EXPLAINER_CANCEL_A11Y}
        testID="resonance-explainer-cancel"
      >
        <Text style={styles.cancelLabel}>{RESONANCE_EXPLAINER_CANCEL}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.action, styles.continue, continueDisabled && styles.continueDisabled]}
        onPress={onContinue}
        disabled={continueDisabled}
        accessibilityRole="button"
        accessibilityState={{ disabled: continueDisabled }}
        accessibilityLabel={RESONANCE_EXPLAINER_CONTINUE_A11Y}
        testID="resonance-explainer-continue"
      >
        <Text style={styles.continueLabel}>{RESONANCE_EXPLAINER_CONTINUE}</Text>
      </TouchableOpacity>
    </View>
  );
}

function ResonanceExplainerDialog({
  visible,
  cost,
  continueDisabled,
  dontShowAgain,
  onToggleDontShowAgain,
  onContinue,
  onCancel,
}: ResonanceExplainerDialogProps): React.JSX.Element {
  return (
    <JournalModalShell
      visible={visible}
      onDismiss={onCancel}
      scrimTestID="resonance-explainer-scrim"
      scrimLabel={RESONANCE_EXPLAINER_SCRIM_A11Y}
      modalTestID="resonance-explainer"
      cardTestID="resonance-explainer-card"
      cardStyle={styles.card}
    >
      <Text style={styles.title} accessibilityRole="header">
        {RESONANCE_EXPLAINER_TITLE}
      </Text>
      <Text style={styles.body} testID="resonance-explainer-what">
        {RESONANCE_EXPLAINER_WHAT}
      </Text>
      <Text style={styles.body} testID="resonance-explainer-cost">
        {cost}
      </Text>
      <Text style={styles.body} testID="resonance-explainer-choice">
        {RESONANCE_EXPLAINER_CHOICE}
      </Text>
      <DontShowAgain checked={dontShowAgain} onToggle={onToggleDontShowAgain} />
      <ExplainerActions
        continueDisabled={continueDisabled}
        onContinue={onContinue}
        onCancel={onCancel}
      />
    </JournalModalShell>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '100%',
    maxWidth: journalLayout.pageMaxWidth,
    alignSelf: 'center',
  },
  title: {
    ...editorialType.title,
    color: colors.paper.ink,
  },
  body: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
    paddingTop: spacing(1),
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(1),
    minHeight: touchTarget.minimum,
    marginTop: spacing(1),
  },
  checkboxMark: {
    ...editorialType.action,
    color: colors.paper.ink,
    minWidth: spacing(2.5),
    textAlign: 'center',
    borderWidth: 1,
    borderColor: colors.paper.inkSoft,
    borderRadius: BORDER_RADIUS.sm,
  },
  checkboxLabel: {
    ...editorialType.action,
    color: colors.paper.ink,
    flexShrink: 1,
  },
  /** Both arms in one row; ``action`` below gives each of them the same half. */
  actions: {
    flexDirection: 'row',
    gap: spacing(1),
    marginTop: spacing(1.5),
  },
  action: {
    flex: 1,
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: BORDER_RADIUS.md,
  },
  continue: {
    backgroundColor: colors.primary,
  },
  continueDisabled: {
    opacity: 0.45,
  },
  continueLabel: {
    ...editorialType.action,
    color: colors.text.light,
  },
  cancelLabel: {
    ...editorialType.action,
    color: colors.paper.ink,
  },
});

export default ResonanceExplainerDialog;
