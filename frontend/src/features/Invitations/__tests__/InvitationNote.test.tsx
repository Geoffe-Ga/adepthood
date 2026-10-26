/* eslint-env jest */
import { jest, beforeEach, describe, it, expect } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import { X } from 'lucide-react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { invitationCopy, INVITATION_COPY_ENTRIES } from '../invitationCopy';
import InvitationNote from '../InvitationNote';

import type { Invitation } from '@/api';
import { accent, ink, touchTarget } from '@/design/tokens';
import { BANNED_PHRASES } from '@/testing/bannedInvitationPhrases';

const FALSE_MODESTY_PHRASES = [
  'if it feels right',
  'if you like',
  "whenever you'd like",
  'whenever you’re ready',
  "whenever you're ready",
  'no pressure',
  'waiting quietly',
] as const;

function invitation(overrides: Partial<Invitation> = {}): Invitation {
  return {
    id: 1,
    target_type: 'habit',
    target_id: 42,
    kind: 'consistency',
    created_at: '2026-06-24T00:00:00Z',
    ...overrides,
  };
}

const noop = () => Promise.resolve();
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual<object>('@react-navigation/native'),
  useNavigation: () => ({ navigate: mockNavigate }),
}));
beforeEach(() => {
  mockNavigate.mockClear();
});

const reading = {
  content_id: 24,
  stage_number: 2,
  title: 'Noticing resentment',
  entry_id: 8,
  entry_title: 'Yesterday',
  quote: 'resentment in my shoulders',
  reason: 'You describe resentment as a bodily sensation.',
  benefit: 'A practice for noticing that sensation before responding.',
};

/** Smallest of the flattened minHeight/minWidth on a pressable, for 44dp checks. */
function StyleSheetMin(node: { props: { style: unknown } }): number {
  const { StyleSheet } = require('react-native');
  const flat = StyleSheet.flatten(node.props.style) as { minHeight?: number; minWidth?: number };
  return Math.min(flat.minHeight ?? 0, flat.minWidth ?? 0);
}

describe('InvitationNote', () => {
  it('opens the invited course section without dismissing the invitation', () => {
    const onDismiss = jest.fn(() => Promise.resolve());
    const { getByRole } = render(
      <InvitationNote
        invitation={invitation({ target_type: 'course', target_id: 2, kind: 'readiness', reading })}
        onDismiss={onDismiss}
      />,
    );
    const open = getByRole('button', { name: reading.title });
    expect(StyleSheetMin(open)).toBeGreaterThanOrEqual(touchTarget.minimum);
    fireEvent.press(open);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('Tabs', {
      screen: 'Course',
      params: { stageNumber: 2, contentId: 24, openReading: true },
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('can open the invited section before its Aspect lookup succeeds', () => {
    const { getByRole } = render(
      <InvitationNote
        invitation={invitation({
          target_type: 'course',
          target_id: 9,
          reading: { ...reading, stage_number: 9 },
        })}
        onDismiss={noop}
      />,
    );
    fireEvent.press(getByRole('button', { name: reading.title }));
    expect(mockNavigate).toHaveBeenCalledWith('Tabs', {
      screen: 'Course',
      params: { stageNumber: 9, contentId: 24, openReading: true },
    });
  });

  it('keeps the decline separate from opening the reading', () => {
    const onDismiss = jest.fn(() => Promise.resolve());
    const { getByTestId } = render(
      <InvitationNote
        invitation={invitation({ target_type: 'course', target_id: 2, reading })}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.press(getByTestId('invitation-1-dismiss'));
    expect(onDismiss).toHaveBeenCalledWith(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it.each([
    { target_type: 'course' as const, target_id: null },
    { target_type: 'practice' as const, target_id: 2 },
  ])('offers no reading action without a course destination: %s', (target) => {
    const { queryByRole } = render(
      <InvitationNote invitation={invitation(target)} onDismiss={noop} />,
    );
    expect(queryByRole('button', { name: reading.title })).toBeNull();
  });

  it('renders derived microcopy line for habit/consistency invitation', () => {
    const inv = invitation({ id: 5, target_type: 'habit', kind: 'consistency' });
    const expected = invitationCopy('habit', 'consistency').line;
    const { getByText } = render(<InvitationNote invitation={inv} onDismiss={noop} />);
    expect(getByText(expected)).toBeTruthy();
  });

  it('single tap on dismiss calls onDismiss exactly once with the id', () => {
    const onDismiss = jest.fn(() => Promise.resolve());
    const inv = invitation({ id: 7 });
    const { getByTestId } = render(<InvitationNote invitation={inv} onDismiss={onDismiss} />);
    fireEvent.press(getByTestId('invitation-7-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(7);
  });

  it('decline affordance meets 44dp minimum touch target', () => {
    const inv = invitation({ id: 3 });
    const { getByTestId } = render(<InvitationNote invitation={inv} onDismiss={noop} />);
    const btn = getByTestId('invitation-3-dismiss');
    expect(StyleSheetMin(btn)).toBeGreaterThanOrEqual(touchTarget.minimum);
  });

  it('decline keeps its exact one-tap accessibility label', () => {
    const inv = invitation({ id: 4 });
    const { getByTestId } = render(<InvitationNote invitation={inv} onDismiss={noop} />);
    const btn = getByTestId('invitation-4-dismiss');
    expect(btn.props.accessibilityRole).toBe('button');
    const label: string = btn.props.accessibilityLabel;
    expect(label).toBe('Dismiss this invitation');
  });

  it('decline accessibilityLabel contains none of the banned phrases', () => {
    const inv = invitation({ id: 8 });
    const { getByTestId } = render(<InvitationNote invitation={inv} onDismiss={noop} />);
    const label: string = getByTestId('invitation-8-dismiss').props.accessibilityLabel;
    const lower = label.toLowerCase();
    for (const phrase of BANNED_PHRASES) {
      expect(lower).not.toContain(phrase);
    }
  });

  it('banned-copy sweep: all 15 INVITATION_COPY_ENTRIES are shame-free and urgency-free', () => {
    expect(INVITATION_COPY_ENTRIES).toHaveLength(15);
    for (const entry of INVITATION_COPY_ENTRIES) {
      const line = entry.line.toLowerCase();
      const a11y = entry.declineA11y.toLowerCase();
      for (const phrase of BANNED_PHRASES) {
        expect(line).not.toContain(phrase);
        expect(a11y).not.toContain(phrase);
      }
      for (const phrase of FALSE_MODESTY_PHRASES) {
        expect(line).not.toContain(phrase);
        expect(a11y).not.toContain(phrase);
      }
      expect(entry.line.endsWith('!')).toBe(false);
      expect(entry.declineA11y.endsWith('!')).toBe(false);
    }
  });

  it('shows the exact source, connection and benefit and links the original entry', () => {
    const { getByText, getByTestId } = render(
      <InvitationNote
        invitation={invitation({ target_type: 'course', target_id: 2, reading })}
        onDismiss={noop}
      />,
    );
    expect(getByText(reading.reason)).toBeTruthy();
    expect(getByText(`“${reading.quote}”`)).toBeTruthy();
    expect(getByText(reading.benefit)).toBeTruthy();
    fireEvent.press(getByTestId('invitation-1-source'));
    expect(mockNavigate).toHaveBeenCalledWith('JournalEntry', { entryId: 8 });
  });

  it('uses a corner X with pressed-ink feedback', () => {
    // Pressing the decline button must drive usePressScale's handlers, so the
    // scale animation is live (the regression: they were never wired).
    const { getByTestId } = render(
      <InvitationNote invitation={invitation({ id: 7 })} onDismiss={noop} />,
    );
    const btn = getByTestId('invitation-7-dismiss');
    expect(StyleSheet.flatten(btn.props.style).position).toBe('absolute');
    fireEvent(btn, 'pressIn');
    expect(btn.findByType(X).props.color).toBe(accent.primary);
    fireEvent(btn, 'pressOut');
    expect(btn.findByType(X).props.color).toBe(ink.soft);
  });
});

it('contains a rejected asynchronous decline inside its press handler', async () => {
  const onDismiss = jest.fn(() => Promise.reject(new Error('offline decline')));
  const { getByTestId } = render(
    <InvitationNote invitation={invitation({ id: 7 })} onDismiss={onDismiss} />,
  );
  await act(async () => {
    fireEvent.press(getByTestId('invitation-7-dismiss'));
    await Promise.resolve();
  });
  expect(onDismiss).toHaveBeenCalledWith(7);
});
