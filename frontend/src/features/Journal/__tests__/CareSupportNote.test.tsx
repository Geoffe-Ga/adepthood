/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

/**
 * RED tests for ``CareSupportNote`` (issue #891).
 *
 * These tests fail until the implementation-specialist creates
 * ``frontend/src/features/Journal/CareSupportNote.tsx``.
 *
 * Design requirements from the architect:
 * - Renders a warm ``message`` with ``accessibilityRole="header"``.
 * - Lists every resource with name, contact, and what_it_is text visible.
 * - Each resource has a descriptive accessibilityLabel (not just the kind slug).
 * - A dismiss control collapses the resource list to a compact re-opener.
 * - The re-opener brings resources back (not a dead-end).
 * - Renders nothing when ``care`` is null.
 * - Interactive elements meet the 44dp ``touchTarget.minimum``.
 * - No chat/bot affordances (no sender, avatar, reply testIDs).
 */
import CareSupportNote from '../CareSupportNote';

import type { CareResponse } from '@/api';
import { touchTarget } from '@/design/tokens';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function carePayload(overrides: Partial<CareResponse> = {}): CareResponse {
  return {
    message: 'What you shared sounds heavy. Here are some people who can help right now.',
    resources: [
      {
        kind: 'hotline',
        name: '988 Suicide & Crisis Lifeline',
        contact: '988',
        what_it_is: 'Free, confidential crisis support — call or text anytime.',
      },
      {
        kind: 'text_line',
        name: 'Crisis Text Line',
        contact: 'Text HOME to 741741',
        what_it_is: 'Text-based crisis counselling, 24/7.',
      },
      {
        kind: 'human',
        name: 'Trusted person in your life',
        contact: 'Call, text, or visit',
        what_it_is: 'Someone who knows you — no professional training required.',
      },
      {
        kind: 'professional',
        name: 'Licensed therapist',
        contact: 'Psychology Today directory',
        what_it_is: 'An ongoing therapeutic relationship with a credentialed clinician.',
      },
    ],
    ...overrides,
  };
}

/** Smallest of the flattened minHeight/minWidth on an interactive node. */
function StyleSheetMin(node: { props: { style: unknown } }): number {
  const { StyleSheet } = require('react-native');
  const flat = StyleSheet.flatten(node.props.style) as {
    minHeight?: number;
    minWidth?: number;
  };
  return Math.min(flat.minHeight ?? 0, flat.minWidth ?? 0);
}

// ---------------------------------------------------------------------------
// null guard
// ---------------------------------------------------------------------------

describe('CareSupportNote — null care', () => {
  it('renders nothing when care is null', () => {
    const { queryByTestId } = render(<CareSupportNote care={null} />);
    expect(queryByTestId('care-support')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Initial render (expanded state)
// ---------------------------------------------------------------------------

describe('CareSupportNote — initial render', () => {
  it('mounts the root container with testID "care-support"', () => {
    const { getByTestId } = render(<CareSupportNote care={carePayload()} />);
    expect(getByTestId('care-support')).toBeTruthy();
  });

  it('renders the message text', () => {
    const { getByText } = render(<CareSupportNote care={carePayload()} />);
    expect(
      getByText('What you shared sounds heavy. Here are some people who can help right now.'),
    ).toBeTruthy();
  });

  it('gives the message element accessibilityRole="header"', () => {
    const { getByText } = render(<CareSupportNote care={carePayload()} />);
    const messageEl = getByText(
      'What you shared sounds heavy. Here are some people who can help right now.',
    );
    expect(messageEl.props.accessibilityRole).toBe('header');
  });

  it('renders name text for all four resource kinds', () => {
    const { getByText } = render(<CareSupportNote care={carePayload()} />);
    expect(getByText('988 Suicide & Crisis Lifeline')).toBeTruthy();
    expect(getByText('Crisis Text Line')).toBeTruthy();
    expect(getByText('Trusted person in your life')).toBeTruthy();
    expect(getByText('Licensed therapist')).toBeTruthy();
  });

  it('renders contact text for all four resource kinds', () => {
    const { getByText } = render(<CareSupportNote care={carePayload()} />);
    expect(getByText('988')).toBeTruthy();
    expect(getByText('Text HOME to 741741')).toBeTruthy();
    expect(getByText('Call, text, or visit')).toBeTruthy();
    expect(getByText('Psychology Today directory')).toBeTruthy();
  });

  it('renders what_it_is text for all four resource kinds', () => {
    const { getByText } = render(<CareSupportNote care={carePayload()} />);
    expect(getByText('Free, confidential crisis support — call or text anytime.')).toBeTruthy();
    expect(getByText('Text-based crisis counselling, 24/7.')).toBeTruthy();
    expect(getByText('Someone who knows you — no professional training required.')).toBeTruthy();
    expect(
      getByText('An ongoing therapeutic relationship with a credentialed clinician.'),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Resource-level testIDs and accessibility
// ---------------------------------------------------------------------------

describe('CareSupportNote — per-resource testIDs', () => {
  it('mounts "care-resource-hotline" for the hotline resource', () => {
    const { getByTestId } = render(<CareSupportNote care={carePayload()} />);
    expect(getByTestId('care-resource-hotline')).toBeTruthy();
  });

  it('mounts "care-resource-text_line" for the text-line resource', () => {
    const { getByTestId } = render(<CareSupportNote care={carePayload()} />);
    expect(getByTestId('care-resource-text_line')).toBeTruthy();
  });

  it('mounts "care-resource-human" for the human resource', () => {
    const { getByTestId } = render(<CareSupportNote care={carePayload()} />);
    expect(getByTestId('care-resource-human')).toBeTruthy();
  });

  it('mounts "care-resource-professional" for the professional resource', () => {
    const { getByTestId } = render(<CareSupportNote care={carePayload()} />);
    expect(getByTestId('care-resource-professional')).toBeTruthy();
  });

  it('each resource element has a non-empty, descriptive accessibilityLabel', () => {
    const { getByTestId } = render(<CareSupportNote care={carePayload()} />);
    const kinds = ['hotline', 'text_line', 'human', 'professional'] as const;
    for (const kind of kinds) {
      const el = getByTestId(`care-resource-${kind}`);
      const label: unknown = el.props.accessibilityLabel;
      expect(typeof label).toBe('string');
      // The label must be descriptive enough — longer than just the kind slug.
      expect((label as string).length).toBeGreaterThan(kind.length + 5);
    }
  });
});

// ---------------------------------------------------------------------------
// Dismiss → re-open (not a dead-end)
// ---------------------------------------------------------------------------

describe('CareSupportNote — dismiss and re-open', () => {
  it('mounts a dismiss control with testID "care-dismiss"', () => {
    const { getByTestId } = render(<CareSupportNote care={carePayload()} />);
    expect(getByTestId('care-dismiss')).toBeTruthy();
  });

  it('hides resource cards after pressing care-dismiss', () => {
    const { getByTestId, queryByTestId } = render(<CareSupportNote care={carePayload()} />);
    fireEvent.press(getByTestId('care-dismiss'));
    // Resources should no longer be visible.
    expect(queryByTestId('care-resource-hotline')).toBeNull();
    expect(queryByTestId('care-resource-text_line')).toBeNull();
  });

  it('mounts a re-open control with testID "care-reopen" after dismissing', () => {
    const { getByTestId } = render(<CareSupportNote care={carePayload()} />);
    fireEvent.press(getByTestId('care-dismiss'));
    // The component must NOT disappear entirely — a re-opener must be reachable.
    expect(getByTestId('care-reopen')).toBeTruthy();
  });

  it('re-shows resources after pressing care-reopen (not a dead-end)', () => {
    const { getByTestId } = render(<CareSupportNote care={carePayload()} />);
    fireEvent.press(getByTestId('care-dismiss'));
    fireEvent.press(getByTestId('care-reopen'));
    // Resources reappear.
    expect(getByTestId('care-resource-hotline')).toBeTruthy();
    expect(getByTestId('care-resource-professional')).toBeTruthy();
  });

  it('dismiss control still carries the care-support root after dismissal', () => {
    // The root container must survive dismiss — the user must never lose the
    // surface entirely.
    const { getByTestId } = render(<CareSupportNote care={carePayload()} />);
    fireEvent.press(getByTestId('care-dismiss'));
    expect(getByTestId('care-support')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Touch-target size
// ---------------------------------------------------------------------------

describe('CareSupportNote — touch-target requirements', () => {
  it('dismiss control meets the 44dp minimum touch target', () => {
    const { getByTestId } = render(<CareSupportNote care={carePayload()} />);
    const dismiss = getByTestId('care-dismiss');
    expect(StyleSheetMin(dismiss)).toBeGreaterThanOrEqual(touchTarget.minimum);
  });

  it('re-open control meets the 44dp minimum touch target', () => {
    const { getByTestId } = render(<CareSupportNote care={carePayload()} />);
    fireEvent.press(getByTestId('care-dismiss'));
    const reopen = getByTestId('care-reopen');
    expect(StyleSheetMin(reopen)).toBeGreaterThanOrEqual(touchTarget.minimum);
  });
});

// ---------------------------------------------------------------------------
// No chat/bot affordances
// ---------------------------------------------------------------------------

describe('CareSupportNote — no chat UI', () => {
  it('does not render a sender testID', () => {
    const { queryByTestId } = render(<CareSupportNote care={carePayload()} />);
    expect(queryByTestId('sender')).toBeNull();
  });

  it('does not render an avatar testID', () => {
    const { queryByTestId } = render(<CareSupportNote care={carePayload()} />);
    expect(queryByTestId('avatar')).toBeNull();
  });

  it('does not render a reply testID', () => {
    const { queryByTestId } = render(<CareSupportNote care={carePayload()} />);
    expect(queryByTestId('reply')).toBeNull();
  });

  it('does not render a "Send" text element', () => {
    const { queryByText } = render(<CareSupportNote care={carePayload()} />);
    expect(queryByText('Send')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Issue #892 regression — care-resource-${kind} testIDs survive the
// ResourceCard → CareResourceCard extraction.
//
// After issue #892 the inline ``ResourceCard`` function in ``CareSupportNote``
// is extracted to ``components/care/CareResourceCard`` and re-imported.
// These tests confirm that the testID contract on the reactive (journal)
// surface is IDENTICAL after the refactor — the implementation-specialist
// must NOT rename the testIDs or alter the accessibilityLabel formula.
// ---------------------------------------------------------------------------

describe('CareSupportNote — regression: care-resource testIDs after CareResourceCard extraction (issue #892)', () => {
  it('still mounts "care-resource-hotline" after the extraction refactor', () => {
    const { getByTestId } = render(<CareSupportNote care={carePayload()} />);
    expect(getByTestId('care-resource-hotline')).toBeTruthy();
  });

  it('still mounts "care-resource-text_line" after the extraction refactor', () => {
    const { getByTestId } = render(<CareSupportNote care={carePayload()} />);
    expect(getByTestId('care-resource-text_line')).toBeTruthy();
  });

  it('still mounts "care-resource-human" after the extraction refactor', () => {
    const { getByTestId } = render(<CareSupportNote care={carePayload()} />);
    expect(getByTestId('care-resource-human')).toBeTruthy();
  });

  it('still mounts "care-resource-professional" after the extraction refactor', () => {
    const { getByTestId } = render(<CareSupportNote care={carePayload()} />);
    expect(getByTestId('care-resource-professional')).toBeTruthy();
  });

  it('accessibilityLabel format is preserved: "{name}. {contact}. {what_it_is}"', () => {
    const payload = carePayload();
    const { getByTestId } = render(<CareSupportNote care={payload} />);
    const hotlineResource = payload.resources.find((r) => r.kind === 'hotline');
    if (!hotlineResource) throw new Error('fixture missing hotline resource');
    const card = getByTestId('care-resource-hotline');
    const expected = `${hotlineResource.name}. ${hotlineResource.contact}. ${hotlineResource.what_it_is}`;
    expect(card.props.accessibilityLabel).toBe(expected);
  });
});
