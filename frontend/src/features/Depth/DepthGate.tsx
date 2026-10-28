/**
 * ``DepthGate`` — renders its children only while ``ring`` is enabled (#3073).
 *
 * Applied at the MOUNT site of a ring's offer rather than inside it, so a
 * declined ring costs nothing at all: the gated component's hooks, storage
 * reads and fetches never run, instead of running and then rendering null.
 */
import React from 'react';

import { useRingEnabled, type DepthRing } from './depthRings';

export interface DepthGateProps {
  /** The optional depth whose offer this wraps. */
  ring: DepthRing;
  children: React.ReactNode;
}

function DepthGate({ ring, children }: DepthGateProps): React.JSX.Element | null {
  const enabled = useRingEnabled(ring);
  return enabled ? <>{children}</> : null;
}

export default DepthGate;
