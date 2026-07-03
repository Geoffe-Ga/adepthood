import React from 'react';

import InvitationNote from './InvitationNote';
import { useInvitations } from './useInvitations';

/** The pending invitations (NORTH-STAR §6): silent when empty, one card each. */
const InvitationStack = (): React.JSX.Element | null => {
  const { invitations, dismiss } = useInvitations();
  if (invitations.length === 0) return null;
  return (
    <>
      {invitations.map((invitation) => (
        <InvitationNote key={invitation.id} invitation={invitation} onDismiss={dismiss} />
      ))}
    </>
  );
};

export default InvitationStack;
