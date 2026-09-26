/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

/**
 * RED tests for ``CareResourceCard`` (issue #892 — always-available Support &
 * care in Settings).
 *
 * These tests fail until the implementation-specialist creates
 * ``frontend/src/components/care/CareResourceCard.tsx``, which is the
 * ``ResourceCard`` sub-component extracted from ``CareSupportNote`` so it can
 * be reused in ``SupportCareScreen``.
 *
 * Design contract (from architect):
 *   - Accepts a single ``resource: CareResource`` prop.
 *   - Renders the resource's ``name``, ``contact``, and ``what_it_is`` as text.
 *   - Sets ``testID={`care-resource-${resource.kind}`}``.
 *   - Sets a combined, descriptive ``accessibilityLabel`` (same formula as the
 *     existing ``resourceLabel`` helper in ``CareSupportNote``):
 *     ``"{name}. {contact}. {what_it_is}"``.
 */
import CareResourceCard, { COMPACT_SEPARATOR, resourceLabel } from '../CareResourceCard';

import type { CareResource } from '@/api';
import { accent } from '@/design/tokens';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeResource(overrides: Partial<CareResource> = {}): CareResource {
  return {
    kind: 'hotline',
    name: '988 Suicide & Crisis Lifeline',
    contact: '988',
    what_it_is: 'Free, confidential crisis support — call or text anytime.',
    ...overrides,
  };
}

const ALL_KINDS: CareResource['kind'][] = ['hotline', 'text_line', 'human', 'professional'];

const KIND_FIXTURES: Record<CareResource['kind'], CareResource> = {
  hotline: makeResource({ kind: 'hotline', name: '988 Lifeline', contact: '988' }),
  text_line: makeResource({
    kind: 'text_line',
    name: 'Crisis Text Line',
    contact: 'Text HOME to 741741',
    what_it_is: 'Text-based crisis counselling, 24/7.',
  }),
  human: makeResource({
    kind: 'human',
    name: 'Trusted person in your life',
    contact: 'Call, text, or visit',
    what_it_is: 'Someone who knows you.',
  }),
  professional: makeResource({
    kind: 'professional',
    name: 'Licensed therapist',
    contact: 'Psychology Today directory',
    what_it_is: 'An ongoing therapeutic relationship with a credentialed clinician.',
  }),
};

// ---------------------------------------------------------------------------
// Rendering — name / contact / what_it_is text visible
// ---------------------------------------------------------------------------

describe('CareResourceCard — text content', () => {
  it('renders the resource name as visible text', () => {
    const resource = makeResource();
    const { getByText } = render(<CareResourceCard resource={resource} />);
    expect(getByText('988 Suicide & Crisis Lifeline')).toBeTruthy();
  });

  it('renders the resource contact as visible text', () => {
    const resource = makeResource();
    const { getByText } = render(<CareResourceCard resource={resource} />);
    expect(getByText('988')).toBeTruthy();
  });

  it('renders the resource what_it_is as visible text', () => {
    const resource = makeResource();
    const { getByText } = render(<CareResourceCard resource={resource} />);
    expect(getByText('Free, confidential crisis support — call or text anytime.')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// testID — care-resource-${kind} for each of the four kinds
// ---------------------------------------------------------------------------

describe('CareResourceCard — testID', () => {
  for (const kind of ALL_KINDS) {
    it(`mounts testID "care-resource-${kind}" for kind="${kind}"`, () => {
      const resource = KIND_FIXTURES[kind];
      const { getByTestId } = render(<CareResourceCard resource={resource} />);
      expect(getByTestId(`care-resource-${kind}`)).toBeTruthy();
    });
  }

  it('does NOT mount a card for a kind that was not rendered', () => {
    const resource = makeResource({ kind: 'hotline' });
    const { queryByTestId } = render(<CareResourceCard resource={resource} />);
    // Other kinds must not appear when only "hotline" was rendered.
    expect(queryByTestId('care-resource-text_line')).toBeNull();
    expect(queryByTestId('care-resource-human')).toBeNull();
    expect(queryByTestId('care-resource-professional')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// accessibilityLabel — combined descriptive label
// ---------------------------------------------------------------------------

describe('CareResourceCard — accessibilityLabel', () => {
  it('sets a combined accessibilityLabel containing name, contact, and what_it_is', () => {
    const resource = makeResource();
    const { getByTestId } = render(<CareResourceCard resource={resource} />);
    const card = getByTestId('care-resource-hotline');
    const label: unknown = card.props.accessibilityLabel;
    expect(typeof label).toBe('string');
    // Must contain all three parts.
    expect(label as string).toContain(resource.name);
    expect(label as string).toContain(resource.contact);
    expect(label as string).toContain(resource.what_it_is);
  });

  it('the accessibilityLabel is longer than just the resource name', () => {
    const resource = makeResource();
    const { getByTestId } = render(<CareResourceCard resource={resource} />);
    const card = getByTestId('care-resource-hotline');
    const label = card.props.accessibilityLabel as string;
    expect(label.length).toBeGreaterThan(resource.name.length + 5);
  });

  it('the accessibilityLabel format matches "{name}. {contact}. {what_it_is}"', () => {
    const resource = makeResource();
    const { getByTestId } = render(<CareResourceCard resource={resource} />);
    const card = getByTestId('care-resource-hotline');
    const label = card.props.accessibilityLabel as string;
    const expected = `${resource.name}. ${resource.contact}. ${resource.what_it_is}`;
    expect(label).toBe(expected);
  });

  it('text_line card has a descriptive accessibilityLabel', () => {
    const resource = KIND_FIXTURES['text_line'];
    const { getByTestId } = render(<CareResourceCard resource={resource} />);
    const card = getByTestId('care-resource-text_line');
    const label = card.props.accessibilityLabel as string;
    expect(label).toContain('Crisis Text Line');
    expect(label).toContain('741741');
  });
});

// ---------------------------------------------------------------------------
// No chat/bot affordances
// ---------------------------------------------------------------------------

describe('CareResourceCard — no chat UI', () => {
  it('does not render a "Send" text element', () => {
    const resource = makeResource();
    const { queryByText } = render(<CareResourceCard resource={resource} />);
    expect(queryByText('Send')).toBeNull();
  });

  it('does not render testID "sender"', () => {
    const resource = makeResource();
    const { queryByTestId } = render(<CareResourceCard resource={resource} />);
    expect(queryByTestId('sender')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// compact — the journal care note's tighter row (#2862)
// ---------------------------------------------------------------------------

describe('CareResourceCard — compact', () => {
  const HOTLINE = makeResource({
    name: '988 Suicide & Crisis Lifeline',
    contact: 'Call or text 988',
    what_it_is: 'Free, confidential support from a trained human counselor.',
  });

  it('joins name and contact on one line with the shared separator', () => {
    const { getByText } = render(<CareResourceCard resource={HOTLINE} compact />);
    expect(COMPACT_SEPARATOR).toBe(' · ');
    expect(getByText('988 Suicide & Crisis Lifeline · Call or text 988')).toBeTruthy();
  });

  it('keeps the contact in the accent tone as its own nested run', () => {
    const { getByText } = render(<CareResourceCard resource={HOTLINE} compact />);
    const contact = getByText('Call or text 988');
    expect(StyleSheet.flatten(contact.props.style).color).toBe(accent.strong);
  });

  it('wraps rather than truncating, so a long contact is never cut off', () => {
    const { getByText } = render(<CareResourceCard resource={HOTLINE} compact />);
    const line = getByText('988 Suicide & Crisis Lifeline · Call or text 988');
    expect(line.props.numberOfLines).toBeUndefined();
  });

  it('still shows what the resource is — compact tightens the row, never drops help text', () => {
    const { getByText } = render(<CareResourceCard resource={HOTLINE} compact />);
    expect(getByText(HOTLINE.what_it_is)).toBeTruthy();
  });

  it('keeps the full spoken label', () => {
    const { getByTestId } = render(<CareResourceCard resource={HOTLINE} compact />);
    expect(getByTestId('care-resource-hotline').props.accessibilityLabel).toBe(
      resourceLabel(HOTLINE),
    );
  });

  it('defaults to the three-line card (the Settings rendering)', () => {
    const { getByText, queryByText } = render(<CareResourceCard resource={HOTLINE} />);
    expect(getByText(HOTLINE.name)).toBeTruthy();
    expect(getByText(HOTLINE.contact)).toBeTruthy();
    expect(getByText(HOTLINE.what_it_is)).toBeTruthy();
    expect(queryByText(`${HOTLINE.name}${COMPACT_SEPARATOR}${HOTLINE.contact}`)).toBeNull();
  });
});
