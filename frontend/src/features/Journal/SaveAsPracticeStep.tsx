/**
 * ``SaveAsPracticeStep`` — the practice branch of the finished-session note.
 *
 * Reached only when the writer taps "Keep this as a practice", and it does
 * exactly one thing before it does anything else: it ASKS what keeping it
 * would do, and shows the answer. That order is the point of the component.
 *
 * Two things could happen that the writer cannot see from the journal page,
 * and both are unrecoverable-feeling if they happen silently:
 *
 * 1. **Green may already hold a practice they chose.** The server resolves a
 *    second open selection for a stage by closing the first, so a bare write
 *    would evict it with no prompt and no undo. Here it is named first, and
 *    the way out of the step is labelled after the practice it preserves.
 * 2. **Green may not be open to them yet.** The selection is still allowed —
 *    the server treats a forward-planned pick as planning, not access — but
 *    the session that has just finished cannot be logged against it. So the
 *    summary says the session is not counted rather than implying it was, and
 *    the write does not attempt a log it knows would be refused.
 *
 * Nothing here settles the offer except a write that landed. A failed lookup,
 * a failed write and the way out all leave the invitation standing, because in
 * each of those cases the writer asked for something they have not got.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { FinishedWriting, PracticeOfferPlan } from './keepAsPractice';
import { keepAsPractice, planKeepAsPractice } from './keepAsPractice';
import OfferAction from './OfferAction';
import {
  SAVE_AS_PRACTICE_CANCEL_A11Y,
  SAVE_AS_PRACTICE_CHECKING,
  SAVE_AS_PRACTICE_CONFIRM,
  SAVE_AS_PRACTICE_CONFIRM_A11Y,
  SAVE_AS_PRACTICE_FAILED,
  SAVE_AS_PRACTICE_REPLACE,
  SAVE_AS_PRACTICE_REPLACE_A11Y,
  SAVE_AS_PRACTICE_SAVING,
  SAVE_AS_PRACTICE_UNAVAILABLE,
  keepPracticeCancelLabel,
  keepPracticeSummary,
  keptPracticeConfirmation,
} from './saveAsPracticeCopy';

import { SPACING, colors, editorialType } from '@/design/tokens';

/** Where the step has got to. ``checking`` is "the lookup has not answered yet". */
type Phase = 'checking' | 'deciding' | 'saving' | 'kept';

export interface SaveAsPracticeStepProps {
  /** The session this would record, and when it ended. */
  writing: FinishedWriting;
  /** Called once, when a write has actually landed, so the offer settles. */
  onKept: () => void;
  /** Called when the writer steps out, leaving the invitation standing. */
  onCancel: () => void;
}

/** The plan, once the lookup answers: ``null`` is "it could not answer". */
type Lookup =
  { readonly settled: false } | { readonly settled: true; readonly plan: PracticeOfferPlan | null };

/** Ask the server what keeping this would do, once, on mount. */
function usePlanLookup(): Lookup {
  const [lookup, setLookup] = useState<Lookup>({ settled: false });
  useEffect(() => {
    let mounted = true;
    void planKeepAsPractice().then((plan) => {
      if (mounted) setLookup({ settled: true, plan });
    });
    return () => {
      mounted = false;
    };
  }, []);
  return lookup;
}

/** One line of the note, saying what is true rather than what to do about it. */
function Notice({ text, testID }: { text: string; testID: string }): React.JSX.Element {
  return (
    <View style={styles.step} testID="save-as-practice-step">
      <Text style={styles.prompt} testID={testID}>
        {text}
      </Text>
    </View>
  );
}

/** The summary, the confirm, and the way out — the whole of the decision. */
function Decision({
  plan,
  saving,
  failed,
  onConfirm,
  onCancel,
}: {
  plan: PracticeOfferPlan;
  saving: boolean;
  failed: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const displacing = plan.displaces !== null;
  return (
    <View style={styles.step} testID="save-as-practice-step">
      <Text style={styles.prompt} testID="save-as-practice-summary">
        {keepPracticeSummary(plan)}
      </Text>
      {failed ? (
        <Text style={styles.notice} testID="save-as-practice-notice">
          {SAVE_AS_PRACTICE_FAILED}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <OfferAction
          label={
            saving
              ? SAVE_AS_PRACTICE_SAVING
              : displacing
                ? SAVE_AS_PRACTICE_REPLACE
                : SAVE_AS_PRACTICE_CONFIRM
          }
          a11yLabel={displacing ? SAVE_AS_PRACTICE_REPLACE_A11Y : SAVE_AS_PRACTICE_CONFIRM_A11Y}
          onPress={onConfirm}
          disabled={saving}
          emphasis
          testID="save-as-practice-confirm"
        />
        <OfferAction
          label={keepPracticeCancelLabel(plan.displaces)}
          a11yLabel={SAVE_AS_PRACTICE_CANCEL_A11Y}
          onPress={onCancel}
          testID="save-as-practice-cancel"
        />
      </View>
    </View>
  );
}

function SaveAsPracticeStep({
  writing,
  onKept,
  onCancel,
}: SaveAsPracticeStepProps): React.JSX.Element {
  const lookup = usePlanLookup();
  const [phase, setPhase] = useState<Phase>('checking');
  const [failed, setFailed] = useState(false);
  const [sessionLogged, setSessionLogged] = useState(false);

  const plan = lookup.settled ? lookup.plan : null;

  const confirm = useCallback(() => {
    if (plan === null) return;
    setFailed(false);
    setPhase('saving');
    void keepAsPractice(plan, writing).then((outcome) => {
      // Only a write that landed settles the offer. A failed one leaves the
      // decision standing, because the writer asked for a practice they have
      // not got.
      if (!outcome.kept) {
        setFailed(true);
        setPhase('deciding');
        return;
      }
      setSessionLogged(outcome.sessionLogged);
      setPhase('kept');
      onKept();
    });
  }, [onKept, plan, writing]);

  if (!lookup.settled)
    return <Notice text={SAVE_AS_PRACTICE_CHECKING} testID="save-as-practice-checking" />;
  if (plan === null)
    return <Notice text={SAVE_AS_PRACTICE_UNAVAILABLE} testID="save-as-practice-notice" />;
  if (phase === 'kept') {
    return <Notice text={keptPracticeConfirmation(sessionLogged)} testID="save-as-practice-kept" />;
  }
  return (
    <Decision
      plan={plan}
      saving={phase === 'saving'}
      failed={failed}
      onConfirm={confirm}
      onCancel={onCancel}
    />
  );
}

const styles = StyleSheet.create({
  step: {
    marginTop: SPACING.sm,
    gap: SPACING.xs,
  },
  prompt: {
    ...editorialType.note,
    color: colors.paper.ink,
  },
  notice: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    flexWrap: 'wrap',
  },
});

export default SaveAsPracticeStep;
