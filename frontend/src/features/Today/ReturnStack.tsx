import React from 'react';

import ReturnArcCard from './ReturnArcCard';
import ReturnCompletionCard from './ReturnCompletionCard';
import ReturnOfferCard from './ReturnOfferCard';
import { useMettaReturn } from './useMettaReturn';

/** The Return surface: the soft-landing offer when invited, or the active arc. */
const ReturnStack = (): React.JSX.Element | null => {
  const { weeks, arc, offerVisible, dismissOffer, start, pause, resume, leave } = useMettaReturn();
  if (arc !== null && arc.complete) {
    return <ReturnCompletionCard onLeave={() => void leave()} />;
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
  if (offerVisible) {
    return <ReturnOfferCard onAccept={() => void start()} onDismiss={dismissOffer} />;
  }
  return null;
};

export default ReturnStack;
