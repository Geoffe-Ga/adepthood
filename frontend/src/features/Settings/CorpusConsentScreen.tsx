import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';

import {
  CORPUS_CONSENT_CONSEQUENCE_HEADING,
  CORPUS_CONSENT_CONSEQUENCE_REMOVAL,
  CORPUS_CONSENT_CONSEQUENCE_SENDING,
  CORPUS_CONSENT_EYEBROW,
  CORPUS_CONSENT_FAILURE,
  CORPUS_CONSENT_INTIMATE_LINE,
  CORPUS_CONSENT_LEAD,
  CORPUS_CONSENT_RECORD_LINE,
  CORPUS_CONSENT_SOURCES_HEADING,
  CORPUS_CONSENT_TITLE,
  CORPUS_NOT_SORTED_YET_NOTE,
  CORPUS_REVOKE_CANCEL_LABEL,
  CORPUS_REVOKE_CONFIRM_LABEL,
  CORPUS_REVOKE_PROMPT,
  consentStatusLine,
  sortsAnything,
  sourceCopy,
} from './corpusConsentCopy';
import { SettingsFeedbackBanner } from './shared/SettingsFeedbackBanner';

import { corpusConsent, type CorpusConsent } from '@/api';
import { EditorialSection } from '@/components/layout/EditorialSection';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import {
  BORDER_RADIUS,
  SPACING,
  accent,
  colors,
  ink,
  rhythm,
  surface,
  touchTarget,
} from '@/design/tokens';

/**
 * "Writing reflections can draw on" — where somebody turns the ontologized
 * corpus on, and off.
 *
 * The screen exists because the decision was reachable only over HTTP: the
 * endpoints shipped with the writer, defaulting to off, so every real account's
 * corpus stayed empty and every reflection fell back to a recency window. This
 * is the surface that lets a person answer the question at all.
 *
 * **Agreeing is one tap; withdrawing is not.** Granting is reversible and its
 * two consequences are stated above the switch. Withdrawing deletes the copies
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

/** Loaded-state model: null until the first read answers, one way or another. */
type Decisions = readonly CorpusConsent[] | null;

interface ConsentController {
  decisions: Decisions;
  error: string | null;
  pending: string | null;
  decide: (_source: string, _granted: boolean) => void;
}

/**
 * A state updater that swaps in one source's new state and leaves the rest.
 *
 * Lifted out of the write path so the merge is a named thing rather than a
 * callback inside a callback inside a callback.
 */
function replaceSource(state: CorpusConsent) {
  return (current: Decisions): CorpusConsent[] =>
    (current ?? []).map((entry) => (entry.source === state.source ? state : entry));
}

/** Read every source once, then write one decision at a time. */
function useCorpusConsent(): ConsentController {
  const [decisions, setDecisions] = useState<Decisions>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void corpusConsent
      .list()
      .then((states) => {
        if (live) setDecisions(states);
      })
      .catch(() => {
        if (live) setError(CORPUS_CONSENT_FAILURE);
      });
    return () => {
      live = false;
    };
  }, []);

  const decide = useCallback((source: string, granted: boolean) => {
    setError(null);
    setPending(source);
    void corpusConsent
      .set(source, granted)
      .then((state) => setDecisions(replaceSource(state)))
      .catch(() => setError(CORPUS_CONSENT_FAILURE))
      .finally(() => setPending(null));
  }, []);

  return { decisions, error, pending, decide };
}

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

/** The switch, or the reason there is not one, for a single kind of material. */
const SourceRow = (props: SourceRowProps): React.JSX.Element => {
  const { decision, busy, confirming } = props;
  const { source } = decision;
  const copy = sourceCopy(source);
  const offered = sortsAnything(source);
  return (
    <View style={styles.row} testID={`corpus-consent-row-${source}`}>
      <View style={styles.rowHead}>
        <View style={styles.rowText}>
          <Text style={styles.rowLabel}>{copy.label}</Text>
          <Text style={styles.rowDescription}>{copy.description}</Text>
        </View>
        {offered ? (
          <Switch
            testID={`corpus-consent-switch-${source}`}
            accessibilityRole="switch"
            accessibilityLabel={copy.label}
            accessibilityState={{ checked: decision.granted, disabled: busy }}
            value={decision.granted}
            disabled={busy}
            onValueChange={props.onValueChange}
            trackColor={{ false: surface.hairline, true: accent.primary }}
            thumbColor={surface.raised}
          />
        ) : null}
      </View>
      {offered ? (
        <Text style={styles.rowStatus} testID={`corpus-consent-status-${source}`}>
          {consentStatusLine(decision)}
        </Text>
      ) : (
        <Text style={styles.rowStatus} testID={`corpus-consent-note-${source}`}>
          {CORPUS_NOT_SORTED_YET_NOTE}
        </Text>
      )}
      {confirming ? (
        <RevokeConfirm
          source={source}
          onConfirm={props.onConfirmRevoke}
          onCancel={props.onCancelRevoke}
        />
      ) : null}
    </View>
  );
};

/** The two consequences and the two guarantees, above every switch. */
const Consequences = (): React.JSX.Element => (
  <EditorialSection title={CORPUS_CONSENT_CONSEQUENCE_HEADING} testID="corpus-consent-consequences">
    <Text style={styles.paragraph}>{CORPUS_CONSENT_CONSEQUENCE_SENDING}</Text>
    <Text style={styles.paragraph}>{CORPUS_CONSENT_CONSEQUENCE_REMOVAL}</Text>
    <Text style={styles.paragraphSoft}>{CORPUS_CONSENT_INTIMATE_LINE}</Text>
    <Text style={styles.paragraphSoft}>{CORPUS_CONSENT_RECORD_LINE}</Text>
  </EditorialSection>
);

export default function CorpusConsentScreen(): React.JSX.Element {
  const { decisions, error, pending, decide } = useCorpusConsent();
  const [confirming, setConfirming] = useState<string | null>(null);

  const onValueChange = useCallback(
    (source: string, next: boolean) => {
      if (next) {
        decide(source, true);
        return;
      }
      setConfirming(source);
    },
    [decide],
  );

  const onConfirmRevoke = useCallback(
    (source: string) => {
      setConfirming(null);
      decide(source, false);
    },
    [decide],
  );

  return (
    <ScreenScaffold scroll testID="corpus-consent-screen">
      <ScreenHeader
        eyebrow={CORPUS_CONSENT_EYEBROW}
        title={CORPUS_CONSENT_TITLE}
        lead={CORPUS_CONSENT_LEAD}
      />
      <Consequences />
      <EditorialSection title={CORPUS_CONSENT_SOURCES_HEADING} testID="corpus-consent-sources">
        <SettingsFeedbackBanner idPrefix="corpus-consent" error={error} status={null} />
        {(decisions ?? []).map((decision) => (
          <SourceRow
            key={decision.source}
            decision={decision}
            busy={pending === decision.source}
            confirming={confirming === decision.source}
            onValueChange={(next) => onValueChange(decision.source, next)}
            onConfirmRevoke={() => onConfirmRevoke(decision.source)}
            onCancelRevoke={() => setConfirming(null)}
          />
        ))}
      </EditorialSection>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  paragraph: {
    fontSize: 15,
    lineHeight: 22,
    color: ink.primary,
    marginBottom: rhythm.blockGap,
  },
  paragraphSoft: {
    fontSize: 14,
    lineHeight: 20,
    color: ink.soft,
    marginBottom: rhythm.blockGap,
  },
  row: {
    paddingVertical: rhythm.blockGap,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: surface.hairline,
  },
  rowHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: touchTarget.minimum,
  },
  rowText: {
    flex: 1,
    paddingRight: SPACING.md,
  },
  rowLabel: {
    fontSize: 16,
    color: ink.primary,
  },
  rowDescription: {
    fontSize: 14,
    lineHeight: 20,
    color: ink.soft,
    marginTop: SPACING.xs,
  },
  rowStatus: {
    fontSize: 13,
    lineHeight: 18,
    color: ink.muted,
    marginTop: SPACING.xs,
  },
  revoke: {
    marginTop: rhythm.blockGap,
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
