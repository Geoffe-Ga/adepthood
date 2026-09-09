/**
 * ``ContractionReflectionNote`` — a warm, declinable "tend your foundation"
 * reflection shown when a resonance pass senses a foundation easing off. It
 * mirrors ``CareSupportNote`` in shape but is deliberately gentler: it names a
 * gentle nudge (``simple_ease_off``) or an open invitation (``return_offer``),
 * never failure, demotion, or ranking. "You choose your depth" — a single tap
 * sets it aside for good, and only a fresh pass's new reflection resurfaces it.
 *
 * The ``return_offer`` variant is the one card that names the Return, so it is
 * also the one card that can begin one: while the Return is actually on offer
 * it carries an accept affordance behind a confirmation that says what the arc
 * materially is, and its "Not now" persists the same server-side decline the
 * Journal shelf's offer card uses, so declining here is honoured there.
 *
 * Deliberately NOT a chatbot: no avatar, no sender, no reply, no Send. It is a
 * header-role title, the backend's own message, and one-tap answers.
 * Reduced-motion-safe (it animates nothing), tokens only.
 */
import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { reflectionCardStyles } from './noteCards';
import ReflectionDismiss from './ReflectionDismiss';
import ReturnConfirmDialog from './ReturnConfirmDialog';

import type { ContractionReflection, ContractionVariant } from '@/api';
import {
  BORDER_RADIUS,
  SPACING,
  colors,
  editorialType,
  ink,
  spacing,
  touchTarget,
} from '@/design/tokens';
import {
  RETURN_DISMISS_ERROR,
  RETURN_OFFER_ACCEPT,
  RETURN_OFFER_ACCEPT_A11Y,
  RETURN_START_ERROR,
} from '@/features/Return/returnCopy';
import { useMettaReturn } from '@/features/Return/useMettaReturn';

/** Warm, declinable titles per contraction variant — never punishing copy. */
const VARIANT_TITLES: Record<ContractionVariant, string> = {
  simple_ease_off: 'Tend your foundation',
  return_offer: 'The Return is open to you',
};

const DISMISS_LABEL = 'Not now';
const DISMISS_A11Y = 'Set this reflection aside';

/** The raised card every variant shares: header-role title, the server's message, then answers. */
function ReflectionCard({
  contraction,
  children,
}: {
  contraction: ContractionReflection;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={reflectionCardStyles.root} testID="contraction-reflection">
      <Text
        style={reflectionCardStyles.header}
        accessibilityRole="header"
        testID="contraction-reflection-title"
      >
        {VARIANT_TITLES[contraction.variant]}
      </Text>
      <Text style={styles.message}>{contraction.message}</Text>
      {children}
    </View>
  );
}

/** A line that reports what did not carry — the journal's own way of owning a failed call. */
function ReflectionNotice({ notice }: { notice: string | null }): React.JSX.Element | null {
  return notice === null ? null : (
    <Text style={styles.notice} testID="contraction-return-notice">
      {notice}
    </Text>
  );
}

/** The plain reflection: the server's words and a one-tap, local-only set-aside. */
function PlainReflection({
  contraction,
  onDismiss,
}: {
  contraction: ContractionReflection;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <ReflectionCard contraction={contraction}>
      <DismissAction onPress={onDismiss} />
    </ReflectionCard>
  );
}

interface ReturnOfferReflectionProps {
  contraction: ContractionReflection;
  /** A failed call's line, held by the note so it outlives this branch's unmount. */
  notice: string | null;
  onNotice: (_notice: string) => void;
  onDismiss: () => void;
}

interface Acceptance {
  confirming: boolean;
  started: boolean;
  openConfirm: () => void;
  cancelConfirm: () => void;
  confirmStart: () => void;
  decline: () => void;
}

/**
 * The two answers the offer can be given, and the guard that keeps a double-tap
 * from opening two arcs.
 *
 * The latch is a ref rather than the ``started`` state beside it because a
 * second tap lands before React has re-rendered; only a synchronous flag can
 * turn it away. A rejected start releases the latch again, so a failure leaves
 * the door open rather than jamming it shut.
 */
function useAcceptance(
  start: () => Promise<void>,
  dismissOffer: () => Promise<void>,
  onDismiss: () => void,
  onNotice: (_notice: string) => void,
): Acceptance {
  const [confirming, setConfirming] = useState(false);
  const [started, setStarted] = useState(false);
  const startingRef = useRef(false);

  const confirmStart = useCallback((): void => {
    if (startingRef.current) return;
    startingRef.current = true;
    void start()
      .then(() => {
        setStarted(true);
        setConfirming(false);
      })
      .catch(() => {
        startingRef.current = false;
        setConfirming(false);
        onNotice(RETURN_START_ERROR);
      });
  }, [start, onNotice]);

  const decline = useCallback((): void => {
    onDismiss();
    void dismissOffer().catch(() => onNotice(RETURN_DISMISS_ERROR));
  }, [dismissOffer, onDismiss, onNotice]);

  return {
    confirming,
    started,
    openConfirm: useCallback((): void => setConfirming(true), []),
    cancelConfirm: useCallback((): void => setConfirming(false), []),
    confirmStart,
    decline,
  };
}

/** The set-aside answer every reflection carries, warm and one tap deep. */
function DismissAction({ onPress }: { onPress: () => void }): React.JSX.Element {
  return (
    <ReflectionDismiss
      label={DISMISS_LABEL}
      accessibilityLabel={DISMISS_A11Y}
      testID="contraction-dismiss"
      onPress={onPress}
    />
  );
}

/**
 * The ``return_offer`` reflection while the Return is genuinely on offer: the
 * card, an accept affordance, and a persisted decline.
 *
 * ``offerVisible`` — not a hand-rolled ``eligible && arc === null`` — is the
 * gate, because it is the single place the Return decides it may be offered at
 * all (eligible, a contraction observed, not already declined, no arc running).
 * When it is false there is no offer to accept OR to decline, so the card falls
 * back to the plain reflection and its "Not now" stays local.
 */
function ReturnOfferReflection({
  contraction,
  notice,
  onNotice,
  onDismiss,
}: ReturnOfferReflectionProps): React.JSX.Element {
  const { offerVisible, weeks, start, dismissOffer } = useMettaReturn();
  const answer = useAcceptance(start, dismissOffer, onDismiss, onNotice);

  if (!offerVisible || answer.started) {
    return (
      <ReflectionCard contraction={contraction}>
        <ReflectionNotice notice={notice} />
        <DismissAction onPress={onDismiss} />
      </ReflectionCard>
    );
  }

  return (
    <ReflectionCard contraction={contraction}>
      <ReflectionNotice notice={notice} />
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.accept}
          onPress={answer.openConfirm}
          accessibilityRole="button"
          accessibilityLabel={RETURN_OFFER_ACCEPT_A11Y}
          testID="contraction-return-accept"
        >
          <Text style={styles.acceptLabel}>{RETURN_OFFER_ACCEPT}</Text>
        </TouchableOpacity>
        <DismissAction onPress={answer.decline} />
      </View>
      <ReturnConfirmDialog
        visible={answer.confirming}
        weeks={weeks}
        onConfirm={answer.confirmStart}
        onCancel={answer.cancelConfirm}
      />
    </ReflectionCard>
  );
}

export interface ContractionReflectionNoteProps {
  /** The contraction surface from the latest pass; ``null`` hides everything. */
  contraction: ContractionReflection | null;
}

function ContractionReflectionNote({
  contraction,
}: ContractionReflectionNoteProps): React.JSX.Element | null {
  // Reference-identity dismissal: setting ``dismissedFor`` to the current object
  // hides it for good, but a fresh pass hands a NEW object that never matches —
  // so a later reflection resurfaces without a re-open affordance. The notice is
  // pinned to its own contraction the same way, so a line about a call that did
  // not carry cannot bleed onto the next pass's reflection.
  const [dismissedFor, setDismissedFor] = useState<ContractionReflection | null>(null);
  const [notice, setNotice] = useState<{ for: ContractionReflection; text: string } | null>(null);
  const dismiss = useCallback((): void => setDismissedFor(contraction), [contraction]);
  const showNotice = useCallback(
    (text: string): void => {
      if (contraction !== null) setNotice({ for: contraction, text });
    },
    [contraction],
  );

  if (contraction == null) return null;
  const shown = notice !== null && notice.for === contraction ? notice.text : null;
  // Set aside, but a decline that never reached the server still owes the person
  // a word — so the line stays where the card was rather than vanishing with it.
  if (dismissedFor === contraction) return <ReflectionNotice notice={shown} />;
  if (contraction.variant === 'return_offer') {
    return (
      <ReturnOfferReflection
        contraction={contraction}
        notice={shown}
        onNotice={showNotice}
        onDismiss={dismiss}
      />
    );
  }
  return <PlainReflection contraction={contraction} onDismiss={dismiss} />;
}

const styles = StyleSheet.create({
  message: {
    ...editorialType.body,
    color: ink.primary,
  },
  notice: {
    ...editorialType.caption,
    color: colors.danger,
    paddingTop: spacing(1),
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  accept: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    paddingHorizontal: SPACING.md,
    marginTop: SPACING.md,
    marginRight: SPACING.sm,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: colors.tier.clear,
    alignItems: 'center',
    justifyContent: 'center',
  },
  acceptLabel: {
    ...editorialType.action,
    color: colors.paper.background,
  },
});

export default ContractionReflectionNote;
