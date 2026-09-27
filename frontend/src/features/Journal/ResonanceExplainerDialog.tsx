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
import { Text } from 'react-native';

import {
  DontShowAgainCheckbox,
  ExplainerActionPair,
  explainerStyles as styles,
} from './ExplainerDialogParts';
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

/** The two arms, in the disclosure's own words; the charged one waits on the payer. */
function ResonanceArms({
  continueDisabled,
  onContinue,
  onCancel,
}: Pick<
  ResonanceExplainerDialogProps,
  'continueDisabled' | 'onContinue' | 'onCancel'
>): React.JSX.Element {
  return (
    <ExplainerActionPair
      cancel={{
        label: RESONANCE_EXPLAINER_CANCEL,
        accessibilityLabel: RESONANCE_EXPLAINER_CANCEL_A11Y,
        testID: 'resonance-explainer-cancel',
        onPress: onCancel,
      }}
      proceed={{
        label: RESONANCE_EXPLAINER_CONTINUE,
        accessibilityLabel: RESONANCE_EXPLAINER_CONTINUE_A11Y,
        testID: 'resonance-explainer-continue',
        onPress: onContinue,
      }}
      proceedDisabled={continueDisabled}
    />
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
      <DontShowAgainCheckbox
        checked={dontShowAgain}
        onToggle={onToggleDontShowAgain}
        label={RESONANCE_EXPLAINER_DONT_SHOW}
        accessibilityLabel={RESONANCE_EXPLAINER_DONT_SHOW_A11Y}
        testID="resonance-explainer-dont-show"
      />
      <ResonanceArms
        continueDisabled={continueDisabled}
        onContinue={onContinue}
        onCancel={onCancel}
      />
    </JournalModalShell>
  );
}

export default ResonanceExplainerDialog;
