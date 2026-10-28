import { FileQuestion, FileText, Globe, PenLine, type LucideIcon } from 'lucide-react-native';
import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import {
  CORPUS_NOT_SORTED_YET_NOTE,
  CORPUS_REVOKE_CANCEL_LABEL,
  CORPUS_REVOKE_CONFIRM_LABEL,
  CORPUS_REVOKE_PROMPT,
  consentStatusLine,
  sortsAnything,
  sourceCopy,
} from './corpusConsentCopy';
import { SettingsFeedbackBanner } from './shared/SettingsFeedbackBanner';
import {
  SETTINGS_ROW_TEXT_INSET,
  SettingsRowText,
  SettingsSwitchRow,
} from './shared/SettingsSwitchRow';
import {
  confirmationMatches,
  useCorpusConsent,
  type ConsentConfirmation,
} from './useCorpusConsent';

import type { CorpusConsent } from '@/api';
import {
  BORDER_RADIUS,
  SPACING,
  colors,
  ink,
  rhythm,
  surface,
  touchTarget,
  uiType,
} from '@/design/tokens';

/** The note row's glyph, the same size as a switch row's. */
const NOTE_ICON_SIZE = 22;

/**
 * The corpus-consent switches themselves: one per kind of material the server
 * names, with the question asked before a withdrawal deletes anything.
 *
 * Lifted out of ``CorpusConsentScreen`` so the same switches can sit on the
 * Settings hub, under Your writing, where somebody who has just given their
 * corpus a vault goes looking for them. One component, mounted in two places,
 * so the two can never disagree on what a switch does or asks.
 *
 * **Agreeing is one tap; withdrawing is not.** Granting is reversible and its
 * consequences are stated before the switch. Withdrawing deletes the copies
 * that source contributed, in the same transaction that records the decision —
 * so the switch is also a delete button, and it asks before it acts. Nothing
 * here treats that as a preference being flipped.
 *
 * **Nothing is shown as agreed until the server says so.** Every row renders
 * the state the last response reported, never the position that was tapped: a
 * failed write leaves the switch where it was and says what happened, because
 * a switch that shows "on" after a refused grant is a screen claiming consent
 * nobody recorded.
 *
 * **A source nothing collects gets no switch.** Consent for material that
 * cannot exist yet would be a permission gathered early and spent later
 * without anyone being asked again; those rows say what they are and wait.
 */

interface RevokeConfirmProps {
  source: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** The question asked before a withdrawal deletes anything. */
const RevokeConfirm = ({ source, onConfirm, onCancel }: RevokeConfirmProps): React.JSX.Element => (
  <View style={styles.revoke} testID={`corpus-consent-revoke-${source}`}>
    <Text style={styles.revokePrompt}>{CORPUS_REVOKE_PROMPT}</Text>
    <TouchableOpacity
      style={styles.revokeConfirmButton}
      onPress={onConfirm}
      accessibilityRole="button"
      accessibilityLabel={CORPUS_REVOKE_CONFIRM_LABEL}
      testID={`corpus-consent-revoke-confirm-${source}`}
    >
      <Text style={styles.revokeConfirmText}>{CORPUS_REVOKE_CONFIRM_LABEL}</Text>
    </TouchableOpacity>
    <TouchableOpacity
      style={styles.revokeCancelButton}
      onPress={onCancel}
      accessibilityRole="button"
      accessibilityLabel={CORPUS_REVOKE_CANCEL_LABEL}
      testID={`corpus-consent-revoke-cancel-${source}`}
    >
      <Text style={styles.revokeCancelText}>{CORPUS_REVOKE_CANCEL_LABEL}</Text>
    </TouchableOpacity>
  </View>
);

interface SourceRowProps {
  decision: CorpusConsent;
  busy: boolean;
  confirming: boolean;
  onValueChange: (_next: boolean) => void;
  onConfirmRevoke: () => void;
  onCancelRevoke: () => void;
}

/** The glyph for each kind of material; a source this release has not met gets a question. */
const SOURCE_ICONS: Record<string, LucideIcon> = {
  journal: PenLine,
  upload: FileText,
  import: Globe,
};

/** The switch for a single kind of material, with the question a withdrawal asks. */
const SourceRow = (props: SourceRowProps): React.JSX.Element => {
  const { decision, busy, confirming } = props;
  const { source } = decision;
  const copy = sourceCopy(source);
  return (
    <SettingsSwitchRow
      icon={SOURCE_ICONS[source] ?? FileQuestion}
      label={copy.label}
      description={copy.description}
      status={consentStatusLine(decision)}
      statusTestID={`corpus-consent-status-${source}`}
      value={decision.granted}
      disabled={busy}
      onValueChange={props.onValueChange}
      testID={`corpus-consent-row-${source}`}
      switchTestID={`corpus-consent-switch-${source}`}
    >
      {confirming ? (
        <RevokeConfirm
          source={source}
          onConfirm={props.onConfirmRevoke}
          onCancel={props.onCancelRevoke}
        />
      ) : null}
    </SettingsSwitchRow>
  );
};

/** A kind of material nothing here collects yet: named, explained, and offered no switch. */
const SourceNoteRow = ({ source }: { source: string }): React.JSX.Element => {
  const Icon = SOURCE_ICONS[source] ?? FileQuestion;
  const copy = sourceCopy(source);
  return (
    <View style={styles.noteRow} testID={`corpus-consent-row-${source}`}>
      <View style={styles.noteIcon}>
        <Icon color={ink.muted} size={NOTE_ICON_SIZE} />
      </View>
      <SettingsRowText
        label={copy.label}
        description={copy.description}
        status={CORPUS_NOT_SORTED_YET_NOTE}
        statusTestID={`corpus-consent-note-${source}`}
      />
    </View>
  );
};

export interface CorpusConsentRowsProps {
  /**
   * Show only the sources that have a switch. The hub passes this: a row
   * that explains why there is no switch belongs on the screen that explains
   * everything else, not between two rows that do something.
   */
  offeredOnly?: boolean;
}

const ConsentRetry = ({
  error,
  retry,
}: {
  error: string | null;
  retry: () => Promise<void>;
}): React.JSX.Element | null =>
  error ? (
    <TouchableOpacity
      onPress={() => void retry()}
      accessibilityRole="button"
      accessibilityLabel="Try again"
      testID="corpus-consent-retry"
      style={styles.retry}
    >
      <Text style={styles.retryText}>Try again</Text>
    </TouchableOpacity>
  ) : null;

/** Keep each withdrawal question local while shared decisions remain confirmed. */
function useConsentQuestion({
  decisions,
  epoch,
  decide,
}: Pick<ReturnType<typeof useCorpusConsent>, 'decisions' | 'epoch' | 'decide'>) {
  const [confirming, setConfirming] = useState<ConsentConfirmation | null>(null);

  const onValueChange = useCallback(
    (source: string, next: boolean) => {
      if (next) {
        decide(source, true);
        return;
      }
      const decision = decisions?.find((row) => row.source === source);
      if (decision?.granted) setConfirming({ epoch, decision });
    },
    [decide, decisions, epoch],
  );

  const onConfirmRevoke = useCallback(
    (source: string) => {
      setConfirming(null);
      if (confirming) decide(source, false, confirming);
    },
    [decide, confirming],
  );

  return { confirming, onValueChange, onConfirmRevoke, cancel: () => setConfirming(null) };
}

/** Every source's row, the revoke question, and the banner for a failed read or write. */
export function CorpusConsentRows({
  offeredOnly = false,
}: CorpusConsentRowsProps = {}): React.JSX.Element {
  const { decisions, epoch, error, pending, decide, retry } = useCorpusConsent();
  const question = useConsentQuestion({ decisions, epoch, decide });

  return (
    <>
      <SettingsFeedbackBanner idPrefix="corpus-consent" error={error} status={null} />
      <ConsentRetry error={error} retry={retry} />
      {(decisions ?? []).map((decision) => {
        if (!sortsAnything(decision.source)) {
          return offeredOnly ? null : (
            <SourceNoteRow key={decision.source} source={decision.source} />
          );
        }
        return (
          <SourceRow
            key={decision.source}
            decision={decision}
            busy={pending.includes(decision.source)}
            confirming={
              question.confirming?.decision.source === decision.source &&
              confirmationMatches(question.confirming, epoch, decisions)
            }
            onValueChange={(next) => question.onValueChange(decision.source, next)}
            onConfirmRevoke={() => question.onConfirmRevoke(decision.source)}
            onCancelRevoke={question.cancel}
          />
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  retryText: { ...uiType.button, color: ink.soft },
  retry: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  noteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: touchTarget.minimum,
    paddingVertical: rhythm.blockGap,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: surface.hairline,
  },
  noteIcon: {
    width: SETTINGS_ROW_TEXT_INSET,
  },
  revoke: {
    marginTop: rhythm.blockGap,
    marginLeft: SETTINGS_ROW_TEXT_INSET,
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: surface.sunken,
  },
  revokePrompt: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.destructive.text,
    marginBottom: SPACING.md,
  },
  revokeConfirmButton: {
    borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.buttonV,
    alignItems: 'center',
    backgroundColor: colors.danger,
    minHeight: touchTarget.minimum,
  },
  revokeConfirmText: {
    color: colors.text.light,
    fontSize: 15,
    fontWeight: '600',
  },
  revokeCancelButton: {
    marginTop: SPACING.sm,
    paddingVertical: SPACING.buttonV,
    alignItems: 'center',
    minHeight: touchTarget.minimum,
  },
  revokeCancelText: {
    color: ink.soft,
    fontSize: 15,
  },
});
