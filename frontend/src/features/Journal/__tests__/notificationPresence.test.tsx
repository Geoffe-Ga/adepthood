/* eslint-env jest */
/**
 * The Notification Center's presence reports (#3142): a section says whether it
 * is on screen and how many items it holds, the screen sums them, and outside
 * a provider (the Journal home) a report is a no-op.
 */
import { describe, it, expect } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import {
  NotificationPresenceProvider,
  usePresenceTally,
  useReportNotificationPresence,
  type NotificationSlot,
  type PresenceTally,
} from '../notificationPresence';

function Reporter({
  slot,
  visible,
  count,
}: {
  slot: NotificationSlot;
  visible: boolean;
  count: number;
}): React.JSX.Element {
  useReportNotificationPresence(slot, visible, count);
  return <Text>{slot}</Text>;
}

interface Shown {
  invitations?: { visible: boolean; count: number };
  voice?: { visible: boolean; count: number };
}

function Harness({
  shown,
  onTally,
}: {
  shown: Shown;
  onTally: (_tally: PresenceTally) => void;
}): React.JSX.Element {
  const tally = usePresenceTally();
  onTally(tally);
  return (
    <NotificationPresenceProvider value={tally.report}>
      {shown.invitations ? <Reporter slot="invitations" {...shown.invitations} /> : null}
      {shown.voice ? <Reporter slot="voice" {...shown.voice} /> : null}
    </NotificationPresenceProvider>
  );
}

describe('notification presence', () => {
  it('sums what visible sections report and tracks which are shown', () => {
    let latest: PresenceTally | null = null;
    render(
      <Harness
        shown={{
          invitations: { visible: true, count: 2 },
          voice: { visible: true, count: 1 },
        }}
        onTally={(t) => {
          latest = t;
        }}
      />,
    );
    const tally = latest as unknown as PresenceTally;
    expect(tally.count).toBe(3);
    expect(tally.isVisible('invitations')).toBe(true);
    expect(tally.isVisible('return')).toBe(false);
  });

  it('ignores a hidden section’s count', () => {
    let latest: PresenceTally | null = null;
    render(
      <Harness
        shown={{ invitations: { visible: false, count: 4 } }}
        onTally={(t) => {
          latest = t;
        }}
      />,
    );
    const tally = latest as unknown as PresenceTally;
    expect(tally.count).toBe(0);
    expect(tally.isVisible('invitations')).toBe(false);
  });

  it('follows a section as its count changes and clears it on unmount', () => {
    let latest: PresenceTally | null = null;
    const onTally = (t: PresenceTally): void => {
      latest = t;
    };
    const view = render(
      <Harness shown={{ invitations: { visible: true, count: 2 } }} onTally={onTally} />,
    );
    view.rerender(
      <Harness shown={{ invitations: { visible: true, count: 1 } }} onTally={onTally} />,
    );
    expect((latest as unknown as PresenceTally).count).toBe(1);

    view.rerender(<Harness shown={{}} onTally={onTally} />);
    expect((latest as unknown as PresenceTally).count).toBe(0);
    expect((latest as unknown as PresenceTally).isVisible('invitations')).toBe(false);
  });

  it('is a quiet no-op outside a provider', () => {
    const { getByText } = render(<Reporter slot="voice" visible count={1} />);
    expect(getByText('voice')).toBeTruthy();
  });
});
