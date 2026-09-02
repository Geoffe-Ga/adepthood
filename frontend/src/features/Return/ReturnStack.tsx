import React from 'react';

import ReturnArcCard from './ReturnArcCard';
import ReturnCompletionCard from './ReturnCompletionCard';
import ReturnLetGoCard from './ReturnLetGoCard';
import ReturnOfferCard from './ReturnOfferCard';
import { restingHabits } from './ReturnRecommitSection';
import ReturnRestingCard from './ReturnRestingCard';
import { useMettaReturn } from './useMettaReturn';

import type { ReleasedHabit } from '@/api';

/**
 * What the Return surface shows when no arc is running: the soft-landing offer
 * when the moment invites it, and — independently — the way back to any habit
 * still resting from a Return already left.
 *
 * The two are not alternatives. Gating the whole surface on a live arc is what
 * stranded rested habits in the first place, so the recovery card must not be
 * displaceable by an offer that happens to be showing at the same time.
 */
function ReturnIdleStack({
  offerVisible,
  resting,
  onAccept,
  onDismiss,
  onRecommit,
}: {
  offerVisible: boolean;
  resting: ReleasedHabit[];
  onAccept: () => void;
  onDismiss: () => void;
  onRecommit: (_habitId: number) => void;
}): React.JSX.Element | null {
  if (!offerVisible && resting.length === 0) return null;
  return (
    <>
      {offerVisible ? <ReturnOfferCard onAccept={onAccept} onDismiss={onDismiss} /> : null}
      {resting.length > 0 ? (
        <ReturnRestingCard restingHabits={resting} onRecommit={onRecommit} />
      ) : null}
    </>
  );
}

/** The Return surface: the soft-landing offer when invited, or the active arc. */
const ReturnStack = (): React.JSX.Element | null => {
  const {
    weeks,
    arc,
    offerVisible,
    letGoVisible,
    releasedHabits,
    dismissOffer,
    start,
    pause,
    resume,
    leave,
    release,
    recommit,
    skipLetGo,
  } = useMettaReturn();
  if (arc !== null && arc.complete) {
    return (
      <ReturnCompletionCard
        onLeave={() => void leave()}
        releasedHabits={releasedHabits}
        onRecommit={(habitId) => void recommit([habitId])}
      />
    );
  }
  if (arc !== null && letGoVisible) {
    return <ReturnLetGoCard onRelease={(ids) => void release(ids)} onSkip={skipLetGo} />;
  }
  if (arc !== null) {
    return (
      <ReturnArcCard
        weeks={weeks}
        arc={arc}
        onPause={() => void pause()}
        onResume={() => void resume()}
        onLeave={() => void leave()}
      />
    );
  }
  return (
    <ReturnIdleStack
      offerVisible={offerVisible}
      resting={restingHabits(releasedHabits)}
      onAccept={() => void start()}
      onDismiss={dismissOffer}
      onRecommit={(habitId) => void recommit([habitId])}
    />
  );
};

export default ReturnStack;
