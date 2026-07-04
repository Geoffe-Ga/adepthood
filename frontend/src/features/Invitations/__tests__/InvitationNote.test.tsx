/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

const mockPressIn = jest.fn();
const mockPressOut = jest.fn();
jest.mock('@/hooks/usePressScale', () => ({
  usePressScale: () => ({ scale: 1, onPressIn: mockPressIn, onPressOut: mockPressOut }),
}));

import { invitationCopy, INVITATION_COPY_ENTRIES } from '../invitationCopy';
import InvitationNote from '../InvitationNote';

import type { Invitation } from '@/api';
import { touchTarget } from '@/design/tokens';

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

const BANNED_PHRASES = [
  'missing out',
  "don't miss",
  'dont miss',
  'streak',
  'falling behind',
  'keep it up',
  'last chance',
  'almost there',
  'you should',
  'you need to',
  "don't lose",
  'dont lose',
  'break your streak',
  'broke your streak',
  'on track',
  'expire',
  'hurry',
  'now or never',
] as const;

/** Smallest of the flattened minHeight/minWidth on a pressable, for 44dp checks. */
function StyleSheetMin(node: { props: { style: unknown } }): number {
  const { StyleSheet } = require('react-native');
  const flat = StyleSheet.flatten(node.props.style) as { minHeight?: number; minWidth?: number };
  return Math.min(flat.minHeight ?? 0, flat.minWidth ?? 0);
}

describe('InvitationNote', () => {
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

  it('decline has accessibilityRole button and a non-empty accessibilityLabel', () => {
    const inv = invitation({ id: 4 });
    const { getByTestId } = render(<InvitationNote invitation={inv} onDismiss={noop} />);
    const btn = getByTestId('invitation-4-dismiss');
    expect(btn.props.accessibilityRole).toBe('button');
    const label: string = btn.props.accessibilityLabel;
    expect(label).toBeTruthy();
    expect(label.length).toBeGreaterThan(0);
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
      expect(entry.line.endsWith('!')).toBe(false);
      expect(entry.declineA11y.endsWith('!')).toBe(false);
    }
  });

  it('wires the press-scale handlers to the decline touchable', () => {
    // Pressing the decline button must drive usePressScale's handlers, so the
    // scale animation is live (the regression: they were never wired).
    mockPressIn.mockClear();
    mockPressOut.mockClear();
    const inv = invitation({ id: 7 });
    const { getByTestId } = render(<InvitationNote invitation={inv} onDismiss={noop} />);
    const btn = getByTestId('invitation-7-dismiss');
    fireEvent(btn, 'pressIn');
    fireEvent(btn, 'pressOut');
    expect(mockPressIn).toHaveBeenCalledTimes(1);
    expect(mockPressOut).toHaveBeenCalledTimes(1);
  });
});
