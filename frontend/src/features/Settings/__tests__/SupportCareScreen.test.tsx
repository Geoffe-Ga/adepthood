/* eslint-env jest */
/* global jest */
import { describe, it, expect } from '@jest/globals';
import { render, within } from '@testing-library/react-native';

/**
 * RED tests for ``SupportCareScreen`` (issue #892 — always-available Support &
 * care in Settings).
 *
 * These tests fail until the implementation-specialist creates
 * ``frontend/src/features/Settings/SupportCareScreen.tsx``.
 *
 * Design contract:
 *   - Renders all four care resource cards (testID ``care-resource-{kind}``).
 *   - Renders a header-role message (``accessibilityRole="header"``).
 *   - Renders the ``CARE_LIMITS_LINE`` text.
 *   - Does NOT render any chatbot chrome (no sender, avatar, reply, Send).
 *   - The four resources come from ``STANDING_CARE`` (static, not reactive).
 */

// Module-level mock for careResources so the screen resolves its imports even
// before production files exist; the values it exposes are the canonical
// fixtures so tests still fail on rendering gaps, not on mock gaps.
jest.mock('../careResources', () => ({
  STANDING_CARE: {
    message: 'Support is available whenever you need it. Here are some people who can help.',
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
  },
  CARE_LIMITS_LINE: 'This complements professional care — it does not replace it.',
}));

// CareResourceCard is the extracted shared component; mock it to a thin
// pass-through so SupportCareScreen tests are isolated from CareResourceCard
// rendering details. The testID contract is still asserted here because the
// screen must pass correct props.
jest.mock('@/components/care/CareResourceCard', () => {
  const React = require('react');
  const { View, Text } = require('react-native');
  return {
    __esModule: true,
    default: ({
      resource,
    }: {
      resource: { kind: string; name: string; contact: string; what_it_is: string };
    }) => (
      <View
        testID={`care-resource-${resource.kind}`}
        accessibilityLabel={`${resource.name}. ${resource.contact}. ${resource.what_it_is}`}
      >
        <Text>{resource.name}</Text>
        <Text>{resource.contact}</Text>
        <Text>{resource.what_it_is}</Text>
      </View>
    ),
  };
});

import SupportCareScreen from '../SupportCareScreen';

// ---------------------------------------------------------------------------
// Resource card presence
// ---------------------------------------------------------------------------

describe('SupportCareScreen — resource cards', () => {
  it('renders testID "care-resource-hotline"', () => {
    const { getByTestId } = render(<SupportCareScreen />);
    expect(getByTestId('care-resource-hotline')).toBeTruthy();
  });

  it('renders testID "care-resource-text_line"', () => {
    const { getByTestId } = render(<SupportCareScreen />);
    expect(getByTestId('care-resource-text_line')).toBeTruthy();
  });

  it('renders testID "care-resource-human"', () => {
    const { getByTestId } = render(<SupportCareScreen />);
    expect(getByTestId('care-resource-human')).toBeTruthy();
  });

  it('renders testID "care-resource-professional"', () => {
    const { getByTestId } = render(<SupportCareScreen />);
    expect(getByTestId('care-resource-professional')).toBeTruthy();
  });

  it('renders the hotline name text within its card', () => {
    const { getByTestId } = render(<SupportCareScreen />);
    const hotlineCard = getByTestId('care-resource-hotline');
    expect(within(hotlineCard).getByText('988 Suicide & Crisis Lifeline')).toBeTruthy();
  });

  it('renders the text_line contact within its card', () => {
    const { getByTestId } = render(<SupportCareScreen />);
    const textLineCard = getByTestId('care-resource-text_line');
    expect(within(textLineCard).getByText('Text HOME to 741741')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Header-role message
// ---------------------------------------------------------------------------

describe('SupportCareScreen — header message', () => {
  it('renders the STANDING_CARE message text', () => {
    const { getByText } = render(<SupportCareScreen />);
    expect(
      getByText('Support is available whenever you need it. Here are some people who can help.'),
    ).toBeTruthy();
  });

  it('the STANDING_CARE message element has accessibilityRole="header"', () => {
    const { getByText } = render(<SupportCareScreen />);
    const messageEl = getByText(
      'Support is available whenever you need it. Here are some people who can help.',
    );
    expect(messageEl.props.accessibilityRole).toBe('header');
  });
});

// ---------------------------------------------------------------------------
// Limits line
// ---------------------------------------------------------------------------

describe('SupportCareScreen — limits line', () => {
  it('renders the CARE_LIMITS_LINE text', () => {
    const { getByText } = render(<SupportCareScreen />);
    expect(getByText('This complements professional care — it does not replace it.')).toBeTruthy();
  });
});
