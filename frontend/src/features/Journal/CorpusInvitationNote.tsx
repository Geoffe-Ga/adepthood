/**
 * ``CorpusInvitationNote`` — the corpus decision, offered once a reflection has
 * actually arrived (#2407, owner ruling 2026-09-05).
 *
 * The corpus is opt-in and, until this, nothing outside Settings said it
 * existed. This note appears beside the journal page after the first
 * COMPLETED Resonance pass on an account that has never decided, and only when
 * the server says so: the screen hands it a count of resolved passes, and each
 * time that count moves the note asks ``GET /corpus/invitation`` whether a
 * moment has arrived. The rule -- first pass; again after a plain "Not now"
 * only once both a cooldown of days and a count of further passes have passed;
 * never after "Do not ask again" or once consent is decided either way -- lives
 * on the server, so this component cannot grow a second copy of it.
 *
 * "You choose your depth": the pass is never gated on this, the note is
 * declinable in one tap two ways, and declining is written as a decision about
 * being *asked*, never as a consent event. It renders no number, though the
 * server holds one: a count on an invitation turns it into a meter.
 *
 * Every line is the consent screen's own vocabulary, so the journal and
 * Settings cannot drift apart on what agreeing does. The one sentence Settings
 * does not need is the reach sentence: a yes sorts what is already written,
 * and an invitation vague about that would be vague about egress.
 *
 * Fail-soft throughout. A read that fails resolves to silence; a decline whose
 * write fails still takes the note away, because the person has already
 * answered and the worst case is being asked again later.
 */
import React, { useCallback, useEffect, useState, useRef } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import ReflectionDismiss from './ReflectionDismiss';

import { corpusInvitation } from '@/api';
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
import {
  CORPUS_CONSENT_CONSEQUENCE_SENDING,
  CORPUS_CONSENT_LEAD,
  CORPUS_CONSENT_ROW_LABEL,
  CORPUS_INVITATION_NEVER_A11Y,
  CORPUS_INVITATION_NEVER_LABEL,
  CORPUS_INVITATION_NOT_NOW_A11Y,
  CORPUS_INVITATION_NOT_NOW_LABEL,
  CORPUS_INVITATION_OPEN_A11Y,
  CORPUS_INVITATION_OPEN_LABEL,
  CORPUS_INVITATION_REACH,
} from '@/features/Settings/corpusConsentCopy';

/** The note's identifying warm left rule (matches the shelf's bands), in dp. */
const ACCENT_BAR_WIDTH = 3;

const TEST_ID = 'journal-corpus-invitation';

export interface CorpusInvitationNoteProps {
  /** Resolved, non-intimate passes on this screen; the note asks the server when it moves. */
  completedPasses: number;
  /** Where "Look at the decision" goes -- the screen owns navigation. */
  onOpen: () => void;
}

/**
 * Whether the server offers the invitation right now. Any failure resolves to
 * ``false`` so a background read never surfaces an error on the page.
 */
async function offeredNow(): Promise<boolean> {
  try {
    return (await corpusInvitation.status()).offer;
  } catch {
    return false;
  }
}

/** Owns the offer state, the ask-on-increment, and the two ways of declining. */
function useCorpusInvitation(completedPasses: number) {
  const [offer, setOffer] = useState(false);
  // An answer given here outranks any read still on the wire. The read for
  // this pass is issued the moment the pass settles, while the previous
  // pass's note is still on screen and pressable, and the server answering it
  // has not yet seen the dismissal -- so without this the note the writer just
  // declined comes back when that read lands. ``active`` cannot cover it: it
  // is scoped to one effect run and is cleared only by unmount or the next
  // increment, and a decline is neither.
  //
  // It is never reset, so for the life of this mount no read can reopen the
  // offer -- including one the cooldown would allow. That is the intended
  // bias, not an oversight: the two mistakes are not symmetric, and re-asking
  // someone who just declined is the one NORTH-STAR §6 forbids. A guard
  // scoped to a single effect run would also be weaker than it looks, since
  // ``dismiss`` is fire-and-forget and a later pass's read can still overtake
  // it. The cost is an invitation withheld from someone who sat on one entry
  // for the seven days and three passes the cooldown needs.
  const declined = useRef(false);

  useEffect(() => {
    // Zero passes is not a moment; the server would say so, but asking would
    // put a request on every entry open for an answer already known.
    if (completedPasses <= 0) return undefined;
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
    void corpusInvitation.dismiss(doNotAskAgain).catch(() => {
      // The answer was given and the note is gone; a lost write costs at most
      // being asked again later, which the server's cooldown already bounds.
    });
  }, []);

  return { offer, decline };
}

function CorpusInvitationNote({
  completedPasses,
  onOpen,
}: CorpusInvitationNoteProps): React.JSX.Element | null {
  const { offer, decline } = useCorpusInvitation(completedPasses);

  // Looking is not deciding: a person who opens the screen and closes it has
  // answered "not now", and is not asked again on the very next pass.
  const open = useCallback(() => {
    onOpen();
    decline(false);
  }, [onOpen, decline]);
  const notNow = useCallback(() => decline(false), [decline]);
  const never = useCallback(() => decline(true), [decline]);

  if (!offer) return null;

  // A plain container, not a pressable, so the open and the two decline
  // controls stay independently reachable by assistive tech.
  return (
    <View style={styles.note} testID={TEST_ID}>
      <Text style={styles.label}>{CORPUS_CONSENT_ROW_LABEL}</Text>
      <Text style={styles.body}>{CORPUS_CONSENT_LEAD}</Text>
      <Text style={styles.body}>{CORPUS_CONSENT_CONSEQUENCE_SENDING}</Text>
      <Text style={styles.body}>{CORPUS_INVITATION_REACH}</Text>
      <TouchableOpacity
        style={styles.openArea}
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={CORPUS_INVITATION_OPEN_A11Y}
        testID={`${TEST_ID}-open`}
      >
        <Text style={styles.cta}>{CORPUS_INVITATION_OPEN_LABEL}</Text>
      </TouchableOpacity>
      <View style={styles.declines}>
        <ReflectionDismiss
          label={CORPUS_INVITATION_NOT_NOW_LABEL}
          accessibilityLabel={CORPUS_INVITATION_NOT_NOW_A11Y}
          testID={`${TEST_ID}-dismiss`}
          onPress={notNow}
        />
        <ReflectionDismiss
          label={CORPUS_INVITATION_NEVER_LABEL}
          accessibilityLabel={CORPUS_INVITATION_NEVER_A11Y}
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
    // The same raised sheet and warm accent rule as the shelf's bands, so this
    // reads as part of a matched set rather than an alert.
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

export default CorpusInvitationNote;
