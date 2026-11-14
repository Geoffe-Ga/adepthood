/**
 * ``PromoteExplainerDialog`` — what the first "Promote a quote" says before it
 * asks for a passage (#2864).
 *
 * Presentational only: it reports which arm was taken and the host starts (or
 * does not start) selection. It says what promotion does and where the quote
 * goes — a review that covers the week it was written, and the Promoted quotes door in the
 * Journal menu — then offers the two arms at equal weight. The scrim declines
 * exactly as "Not now" does, and the "don’t show this again" box starts
 * unticked, so a reader who wants the note to keep appearing does nothing.
 *
 * Built from the same parts as the resonance spend disclosure
 * (``ExplainerDialogParts``), so the two first-press notes read as one family.
 * A Course chapter or a letter (#3660) passes its ``sourceKind`` for the
 * reading wording, and a chapter -- which shows the note at its Promote press --
 * says the passage is already chosen.
 */
import React from 'react';
import { Text, View } from 'react-native';

import {
  DontShowAgainCheckbox,
  ExplainerActionPair,
  explainerStyles as styles,
} from './ExplainerDialogParts';
import JournalModalShell from './JournalModalShell';
import {
  PROMOTE_EXPLAINER_CANCEL,
  PROMOTE_EXPLAINER_CANCEL_A11Y,
  PROMOTE_EXPLAINER_DONT_SHOW,
  PROMOTE_EXPLAINER_DONT_SHOW_A11Y,
  PROMOTE_EXPLAINER_SCRIM_A11Y,
  PROMOTE_EXPLAINER_TITLE,
  promoteExplainerWords,
} from './promoteExplainerCopy';

import type { PromotedQuoteSourceKind } from '@/api';

/** The note's own content and arms, wherever it is set. */
export interface PromoteExplainerPanelProps {
  /** Whether the reader has ticked "don’t show this again" on this showing. */
  dontShowAgain: boolean;
  onToggleDontShowAgain: () => void;
  /** Go on -- to choosing the passage, or to promoting the one already chosen. */
  onContinue: () => void;
  /** Leave without promoting. Also what the dialog's scrim and the hardware back do. */
  onCancel: () => void;
  /** What the passage is promoted from; a chapter or a letter waits for a different review. */
  sourceKind?: PromotedQuoteSourceKind;
  /** True when the passage is already chosen, so the go-ahead promotes it (#3660). */
  passageChosen?: boolean;
}

export interface PromoteExplainerDialogProps extends PromoteExplainerPanelProps {
  visible: boolean;
}

/**
 * The note itself: title, what promotion does, the box and the two arms. The
 * dialog sets it over a scrim; a card that is already open over the page -- a
 * letter (#3660) -- sets it in place of its body instead, so the reader never
 * meets a dialog over a dialog.
 */
export function PromoteExplainerPanel({
  dontShowAgain,
  onToggleDontShowAgain,
  onContinue,
  onCancel,
  sourceKind = 'entry',
  passageChosen = false,
}: PromoteExplainerPanelProps): React.JSX.Element {
  const words = promoteExplainerWords(sourceKind, passageChosen);
  return (
    <View testID="promote-explainer-panel">
      <Text style={styles.title} accessibilityRole="header">
        {PROMOTE_EXPLAINER_TITLE}
      </Text>
      <Text style={styles.body} testID="promote-explainer-body">
        {words.body}
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
          label: words.continueLabel,
          accessibilityLabel: words.continueA11y,
          testID: 'promote-explainer-continue',
          onPress: onContinue,
        }}
      />
    </View>
  );
}

function PromoteExplainerDialog({
  visible,
  ...panel
}: PromoteExplainerDialogProps): React.JSX.Element {
  return (
    <JournalModalShell
      visible={visible}
      onDismiss={panel.onCancel}
      scrimTestID="promote-explainer-scrim"
      scrimLabel={PROMOTE_EXPLAINER_SCRIM_A11Y}
      modalTestID="promote-explainer-dialog"
      cardTestID="promote-explainer-card"
      cardStyle={styles.card}
    >
      <PromoteExplainerPanel {...panel} />
    </JournalModalShell>
  );
}

export default PromoteExplainerDialog;
