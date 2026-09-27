/**
 * ``PromoteExplainerDialog`` — what the first "Promote a quote" says before it
 * asks for a passage (#2864).
 *
 * Presentational only: it reports which arm was taken and the host starts (or
 * does not start) selection. It says what promotion does and where the quote
 * goes — the top of the next review, and the Promoted quotes door in the
 * Journal menu — then offers the two arms at equal weight. The scrim declines
 * exactly as "Not now" does, and the "don’t show this again" box starts
 * unticked, so a reader who wants the note to keep appearing does nothing.
 *
 * Built from the same parts as the resonance spend disclosure
 * (``ExplainerDialogParts``), so the two first-press notes read as one family.
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
  PROMOTE_EXPLAINER_BODY,
  PROMOTE_EXPLAINER_CANCEL,
  PROMOTE_EXPLAINER_CANCEL_A11Y,
  PROMOTE_EXPLAINER_CONTINUE,
  PROMOTE_EXPLAINER_CONTINUE_A11Y,
  PROMOTE_EXPLAINER_DONT_SHOW,
  PROMOTE_EXPLAINER_DONT_SHOW_A11Y,
  PROMOTE_EXPLAINER_SCRIM_A11Y,
  PROMOTE_EXPLAINER_TITLE,
} from './promoteExplainerCopy';

export interface PromoteExplainerDialogProps {
  visible: boolean;
  /** Whether the reader has ticked "don’t show this again" on this showing. */
  dontShowAgain: boolean;
  onToggleDontShowAgain: () => void;
  /** Go on to choosing the passage — the host starts selection. */
  onContinue: () => void;
  /** Leave without selecting. Also what the scrim and the hardware back do. */
  onCancel: () => void;
}

function PromoteExplainerDialog({
  visible,
  dontShowAgain,
  onToggleDontShowAgain,
  onContinue,
  onCancel,
}: PromoteExplainerDialogProps): React.JSX.Element {
  return (
    <JournalModalShell
      visible={visible}
      onDismiss={onCancel}
      scrimTestID="promote-explainer-scrim"
      scrimLabel={PROMOTE_EXPLAINER_SCRIM_A11Y}
      modalTestID="promote-explainer-dialog"
      cardTestID="promote-explainer-card"
      cardStyle={styles.card}
    >
      <Text style={styles.title} accessibilityRole="header">
        {PROMOTE_EXPLAINER_TITLE}
      </Text>
      <Text style={styles.body} testID="promote-explainer-body">
        {PROMOTE_EXPLAINER_BODY}
      </Text>
      <DontShowAgainCheckbox
        checked={dontShowAgain}
        onToggle={onToggleDontShowAgain}
        label={PROMOTE_EXPLAINER_DONT_SHOW}
        accessibilityLabel={PROMOTE_EXPLAINER_DONT_SHOW_A11Y}
        testID="promote-explainer-dont-show"
      />
      <ExplainerActionPair
        cancel={{
          label: PROMOTE_EXPLAINER_CANCEL,
          accessibilityLabel: PROMOTE_EXPLAINER_CANCEL_A11Y,
          testID: 'promote-explainer-cancel',
          onPress: onCancel,
        }}
        proceed={{
          label: PROMOTE_EXPLAINER_CONTINUE,
          accessibilityLabel: PROMOTE_EXPLAINER_CONTINUE_A11Y,
          testID: 'promote-explainer-continue',
          onPress: onContinue,
        }}
      />
    </JournalModalShell>
  );
}

export default PromoteExplainerDialog;
