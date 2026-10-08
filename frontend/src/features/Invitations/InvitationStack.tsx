import React from 'react';

import InvitationNote from './InvitationNote';
import { useInvitations } from './useInvitations';

import { RING_FOR_TARGET, useEnabledRings } from '@/features/Depth/depthRings';

/**
 * The pending invitations (NORTH-STAR §6): silent when empty, one card each.
 *
 * The server lists only invitations into rings the writer has kept (#3073), but
 * the list is fetched once on mount and the shelf stays mounted under Settings.
 * So a ring declined mid-session drops its cards here at once, from the live
 * depth toggles, rather than at the next fetch.
 */
const InvitationStack = (): React.JSX.Element | null => {
  const { invitations, dismiss } = useInvitations();
  const enabled = useEnabledRings();
  const shown = invitations.filter(
    (invitation) => enabled[RING_FOR_TARGET[invitation.target_type]],
  );
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((invitation) => (
        <InvitationNote key={invitation.id} invitation={invitation} onDismiss={dismiss} />
      ))}
    </>
  );
};

export default InvitationStack;
