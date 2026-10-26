import React from 'react';

import InvitationNote from './InvitationNote';
import { useInvitations } from './useInvitations';

import type { Invitation } from '@/api';
import { RING_FOR_TARGET, useEnabledRings, type DepthRing } from '@/features/Depth/depthRings';
import { useReportNotificationPresence } from '@/features/Journal/notificationPresence';

/**
 * The invitations a writer is offered: those into rings still on. Shared with
 * the Notification Center's count (#3142), so a card dropped here is never
 * counted there.
 */
export function visibleInvitations(
  invitations: readonly Invitation[],
  enabled: Readonly<Record<DepthRing, boolean>>,
): Invitation[] {
  return invitations.filter(
    (invitation) =>
      enabled[RING_FOR_TARGET[invitation.target_type]] &&
      (invitation.target_type !== 'course' || invitation.reading != null),
  );
}

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
  const shown = visibleInvitations(invitations, enabled);
  useReportNotificationPresence('invitations', shown.length > 0, shown.length);
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
