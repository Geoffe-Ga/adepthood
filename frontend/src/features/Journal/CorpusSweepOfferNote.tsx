/**
 * ``CorpusSweepOfferNote`` — the offer to sort writing that predates the yes
 * to sorting, made once beside the journal page (#3500).
 *
 * A sibling of ``CorpusInvitationNote`` and built the same way: it asks only
 * when the screen's count of completed passes moves (never on a bare entry
 * open), renders nothing on ``false`` or on any error, and is declinable in one
 * tap two ways. Declining is a decision about being *asked*, never a consent
 * event.
 *
 * No server route decides this offer's moment. The shipped ``/corpus/sweep``
 * routes count and sort, nothing more, so the rule is the three facts the
 * Settings row already shows itself on: a standing yes for what is written
 * here, a remainder above zero, and no decline from this person. A "Not now"
 * holds for the session; "Do not ask again" is kept per account on this device
 * (``corpusSweepOfferStorage``). The Settings row stays either way.
 *
 * The note never sorts. Its affirmative only opens the sort-the-rest screen
 * (#3499), where one bounded pass waits for its own confirm: a note on the
 * journal page must not start up to a pass's worth of provider calls in one
 * tap. And it gives way to the consent invitation -- one offer on the page at
 * a time, and the decision about sorting outranks an offer to sort.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import ReflectionDismiss from './ReflectionDismiss';

import { corpusConsent } from '@/api';
import {
  BORDER_RADIUS,
  SPACING,
  accent,
  editorialType,
  ink,
  spacing,
  surface,
  surfaceShadow,
  touchTarget,
} from '@/design/tokens';
import { CORPUS_CONSENT_GAIN } from '@/features/Settings/corpusConsentCopy';
import {
  CORPUS_SWEEP_OFFER_LABEL,
  CORPUS_SWEEP_OFFER_NEVER_A11Y,
  CORPUS_SWEEP_OFFER_NEVER_LABEL,
  CORPUS_SWEEP_OFFER_NEXT_STEP,
  CORPUS_SWEEP_OFFER_NOT_NOW_A11Y,
  CORPUS_SWEEP_OFFER_NOT_NOW_LABEL,
  CORPUS_SWEEP_OFFER_OPEN_A11Y,
  CORPUS_SWEEP_OFFER_OPEN_LABEL,
  corpusSweepPendingLine,
} from '@/features/Settings/corpusSweepCopy';
import {
  CORPUS_SWEEP_SOURCE,
  isSweepOfferSetAside,
  refreshSweepEstimate,
  setSweepOfferAside,
  useCorpusSweepPending,
  useSweepOfferSetAside,
} from '@/features/Settings/useCorpusSweep';
import {
  loadCorpusSweepOfferDeclined,
  saveCorpusSweepOfferDeclined,
} from '@/storage/corpusSweepOfferStorage';

/** The note's identifying warm left rule (matches the invitation's), in dp. */
const ACCENT_BAR_WIDTH = 3;

const TEST_ID = 'journal-corpus-sweep-offer';

export interface CorpusSweepOfferNoteProps {
  /** Resolved passes on this screen; the note asks only when it moves. */
  completedPasses: number;
  /** Where the affirmative goes -- the screen owns navigation. */
  onOpen: () => void;
  /** The consent invitation is on the page, so this note gives way to it. */
  suppressed?: boolean;
}

/** Whether this account has a standing yes for the source a sweep sorts. */
async function journalConsentGranted(): Promise<boolean> {
  const decisions = await corpusConsent.list();
  return decisions.some(
    (decision) => decision.source === CORPUS_SWEEP_SOURCE && decision.granted === true,
  );
}

/**
 * Whether to offer the sweep right now. Cheapest first: a local decline, then
 * consent, then the count -- which lands in the shared sweep store, so the
 * number shown here is the one the Settings row and screen show. Any failure,
 * synchronous or not, resolves ``false``.
 */
async function offeredNow(): Promise<boolean> {
  try {
    if (await loadCorpusSweepOfferDeclined()) return false;
    if (!(await journalConsentGranted())) return false;
    return await refreshSweepEstimate();
  } catch {
    return false;
  }
}

/** Owns the offer state, the ask-on-increment, and the two ways of declining. */
function useCorpusSweepOffer(completedPasses: number) {
  const [offer, setOffer] = useState(false);
  // An answer given here outranks any read still on the wire, for the reason
  // ``CorpusInvitationNote`` gives: the read for the next pass is issued while
  // this note is still pressable, and landing after a decline it must not put
  // back the note just refused. Never reset, so nothing reopens the offer for
  // the life of this mount -- re-asking someone who just declined is the
  // mistake NORTH-STAR §6 forbids, and a withheld nudge is the cheaper one.
  const declined = useRef(false);

  useEffect(() => {
    // Zero passes is not a moment, and asking would put requests on every
    // entry open. A decline this session means there is nothing to ask.
    if (completedPasses <= 0 || isSweepOfferSetAside()) return undefined;
    let active = true;
    void offeredNow().then((value) => {
      if (active && !declined.current) setOffer(value);
    });
    return () => {
      active = false;
    };
  }, [completedPasses]);

  const decline = useCallback((doNotAskAgain: boolean) => {
    declined.current = true;
    setOffer(false);
    setSweepOfferAside();
    // Never rejects; a lost write costs at most one more offer next session.
    if (doNotAskAgain) void saveCorpusSweepOfferDeclined();
  }, []);

  return { offer, decline };
}

function CorpusSweepOfferNote({
  completedPasses,
  onOpen,
  suppressed = false,
}: CorpusSweepOfferNoteProps): React.JSX.Element | null {
  const { offer, decline } = useCorpusSweepOffer(completedPasses);
  const pending = useCorpusSweepPending();
  const setAside = useSweepOfferSetAside();

  // Opening is not deciding: it spends the offer as a "Not now", so someone
  // who looks and comes back is not asked again on the next page this session.
  const open = useCallback(() => {
    onOpen();
    decline(false);
  }, [onOpen, decline]);
  const notNow = useCallback(() => decline(false), [decline]);
  const never = useCallback(() => decline(true), [decline]);

  if (!offer || setAside || suppressed || pending === null || pending <= 0) return null;

  // A plain container, not a pressable, so the open and the two decline
  // controls stay independently reachable by assistive tech.
  return (
    <View style={styles.note} testID={TEST_ID}>
      <Text style={styles.label}>{CORPUS_SWEEP_OFFER_LABEL}</Text>
      <Text style={styles.body}>{CORPUS_CONSENT_GAIN}</Text>
      <Text style={styles.body} testID={`${TEST_ID}-pending`}>
        {corpusSweepPendingLine(pending)}
      </Text>
      <Text style={styles.body}>{CORPUS_SWEEP_OFFER_NEXT_STEP}</Text>
      <TouchableOpacity
        style={styles.openArea}
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={CORPUS_SWEEP_OFFER_OPEN_A11Y}
        testID={`${TEST_ID}-open`}
      >
        <Text style={styles.cta}>{CORPUS_SWEEP_OFFER_OPEN_LABEL}</Text>
      </TouchableOpacity>
      <View style={styles.declines}>
        <ReflectionDismiss
          label={CORPUS_SWEEP_OFFER_NOT_NOW_LABEL}
          accessibilityLabel={CORPUS_SWEEP_OFFER_NOT_NOW_A11Y}
          testID={`${TEST_ID}-dismiss`}
          onPress={notNow}
        />
        <ReflectionDismiss
          label={CORPUS_SWEEP_OFFER_NEVER_LABEL}
          accessibilityLabel={CORPUS_SWEEP_OFFER_NEVER_A11Y}
          testID={`${TEST_ID}-never`}
          onPress={never}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  note: {
    marginHorizontal: SPACING.lg,
    marginTop: SPACING.lg,
    padding: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
    // The invitation's raised sheet and warm rule, so the two read as one set.
    backgroundColor: surface.raised,
    borderLeftWidth: ACCENT_BAR_WIDTH,
    borderLeftColor: accent.primary,
    ...surfaceShadow.card,
  },
  label: {
    ...editorialType.caption,
    color: ink.muted,
  },
  body: {
    ...editorialType.note,
    color: ink.soft,
    paddingTop: spacing(0.5),
  },
  openArea: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
  },
  cta: {
    ...editorialType.action,
    color: accent.primary,
    paddingTop: spacing(1),
  },
  declines: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: SPACING.md,
  },
});

export default CorpusSweepOfferNote;
