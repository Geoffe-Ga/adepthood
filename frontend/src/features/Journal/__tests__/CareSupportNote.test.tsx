/* eslint-env jest */
import { beforeEach, describe, it, expect, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

/**
 * Specs for ``CareSupportNote`` — the crisis-care surface. It:
 * - Renders a short ``title`` as the header-role heading (heading size, #2862)
 *   and the warm ``message`` beneath it as soft body text.
 * - Lists every resource in compact rows: name · contact, then what it is.
 * - Gives each resource a descriptive accessibilityLabel (not just the kind slug).
 * - An icon-only X removes the whole card, leaving one "Support options" line
 *   that restores it (never a dead-end); a fresh care object re-shows the card.
 * - Renders nothing when ``care`` is null.
 * - Meets the 44dp ``touchTarget.minimum`` on interactive elements.
 * - Is a static reflection surface (no TextInput composer), not a chatbot.
 */
import CareSupportNote from '../CareSupportNote';

import type { CareResponse } from '@/api';
import { INTERACTIVE_TEXT_MIN, editorialType, ink, touchTarget } from '@/design/tokens';
import { moveAccessibilityFocus } from '@/utils/accessibilityFocus';

jest.mock('@/utils/accessibilityFocus', () => ({ moveAccessibilityFocus: jest.fn() }));
const mockMoveFocus = jest.mocked(moveAccessibilityFocus);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function carePayload(overrides: Partial<CareResponse> = {}): CareResponse {
  return {
    title: "You're not alone in this",
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

type RenderedTreeNode = {
  props: { testID?: unknown; accessibilityRole?: unknown; children?: unknown };
  children: (RenderedTreeNode | string)[];
};

type RenderedNode = {
  type: string;
  children: (RenderedNode | string)[] | null;
};

// Depth-first list of host-component type names (e.g. 'View', 'Text', 'TextInput').
function hostTypes(node: RenderedNode | RenderedNode[] | string | null): string[] {
  if (node === null) return [];
  if (typeof node === 'string') return [];
  if (Array.isArray(node)) return node.flatMap((child) => hostTypes(child));
  const out: string[] = [node.type];
  const children = node.children;
  if (children === null) return out;
  for (const child of children) out.push(...hostTypes(child));
  return out;
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

  it('renders the title as the header-role element at heading size, not title size', () => {
    const care = carePayload();
    const { getByRole } = render(<CareSupportNote care={care} />);
    const header = getByRole('header');
    expect(header.props.children).toBe(care.title);
    const flat = StyleSheet.flatten(header.props.style);
    expect(flat.fontSize).toBe(editorialType.heading.fontSize);
    expect(flat.fontSize).not.toBe(editorialType.title.fontSize);
  });

  it('keeps the heading clear of the top-right X', () => {
    const header = render(<CareSupportNote care={carePayload()} />).getByRole('header');
    expect(StyleSheet.flatten(header.props.style).paddingRight).toBeGreaterThanOrEqual(
      touchTarget.minimum,
    );
  });

  it('renders the message as soft body text, not a header', () => {
    const care = carePayload();
    const { getByText } = render(<CareSupportNote care={care} />);
    const messageEl = getByText(care.message);
    expect(messageEl.props.accessibilityRole).toBeUndefined();
    const flat = StyleSheet.flatten(messageEl.props.style);
    expect(flat.fontSize).toBe(editorialType.note.fontSize);
    expect(flat.color).toBe(ink.soft);
  });

  it('renders name and contact on one compact line for all four resource kinds', () => {
    const { getByText } = render(<CareSupportNote care={carePayload()} />);
    expect(getByText('988 Suicide & Crisis Lifeline · 988')).toBeTruthy();
    expect(getByText('Crisis Text Line · Text HOME to 741741')).toBeTruthy();
    expect(getByText('Trusted person in your life · Call, text, or visit')).toBeTruthy();
    expect(getByText('Licensed therapist · Psychology Today directory')).toBeTruthy();
  });

  it('leads with the two crisis lines, then a trusted person, then a professional', () => {
    const { getAllByTestId } = render(<CareSupportNote care={carePayload()} />);
    expect(getAllByTestId(/^care-resource-/).map((node) => node.props.testID)).toEqual([
      'care-resource-hotline',
      'care-resource-text_line',
      'care-resource-human',
      'care-resource-professional',
    ]);
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
  it('mounts an icon-only X with testID "care-dismiss" in the top-right corner', () => {
    const { getByTestId, queryByText } = render(<CareSupportNote care={carePayload()} />);
    const dismiss = getByTestId('care-dismiss');
    expect(dismiss.props.accessibilityRole).toBe('button');
    expect(dismiss.props.accessibilityLabel).toBe('Hide the support note');
    expect(queryByText('Dismiss')).toBeNull();
    const flat = StyleSheet.flatten(dismiss.props.style);
    expect(flat.position).toBe('absolute');
    expect(flat.top).toBe(0);
    expect(flat.right).toBe(0);
  });

  it('reads title, message, the resources, then the X (focus order)', () => {
    const care = carePayload();
    const { getByTestId } = render(<CareSupportNote care={care} />);
    const order: string[] = [];
    const walk = (node: RenderedTreeNode | string): void => {
      if (typeof node === 'string') return;
      // Classify the outermost node of each landmark, then stop descending.
      const { testID, accessibilityRole, children } = node.props;
      let landmark: string | null = null;
      if (accessibilityRole === 'header') landmark = 'title';
      else if (children === care.message) landmark = 'message';
      else if (typeof testID === 'string' && /^care-(resource-|dismiss)/.test(testID)) {
        landmark = testID;
      }
      if (landmark !== null) {
        order.push(landmark);
        return;
      }
      for (const child of node.children) walk(child);
    };
    walk(getByTestId('care-support-card') as unknown as RenderedTreeNode);
    expect(order).toEqual([
      'title',
      'message',
      'care-resource-hotline',
      'care-resource-text_line',
      'care-resource-human',
      'care-resource-professional',
      'care-dismiss',
    ]);
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

  it('gives the re-open control a descriptive accessibilityLabel', () => {
    const { getByTestId } = render(<CareSupportNote care={carePayload()} />);
    fireEvent.press(getByTestId('care-dismiss'));
    expect(getByTestId('care-reopen').props.accessibilityLabel).toBe(
      'Show the support options again',
    );
  });

  it('labels the re-open line at the interactive text floor, never caption size', () => {
    const { getByTestId, getByText } = render(<CareSupportNote care={carePayload()} />);
    fireEvent.press(getByTestId('care-dismiss'));
    const label = StyleSheet.flatten(getByText('Support options').props.style);
    expect(label.fontSize).toBeGreaterThanOrEqual(INTERACTIVE_TEXT_MIN);
  });

  it('re-shows the whole card after pressing care-reopen (not a dead-end)', () => {
    const care = carePayload();
    const { getByTestId, getByRole, getAllByTestId, queryByTestId } = render(
      <CareSupportNote care={care} />,
    );
    fireEvent.press(getByTestId('care-dismiss'));
    fireEvent.press(getByTestId('care-reopen'));
    expect(getAllByTestId(/^care-resource-/)).toHaveLength(4);
    expect(getByRole('header').props.children).toBe(care.title);
    expect(getByTestId('care-support-card')).toBeTruthy();
    expect(queryByTestId('care-reopen')).toBeNull();
  });

  it('removes the whole card after pressing care-dismiss, leaving only the reopen line', () => {
    const care = carePayload();
    const { getByTestId, queryByTestId, queryByText, queryAllByTestId, queryByRole } = render(
      <CareSupportNote care={care} />,
    );
    fireEvent.press(getByTestId('care-dismiss'));

    expect(queryByRole('header')).toBeNull();
    expect(queryByText(care.title)).toBeNull();
    expect(queryByText(care.message)).toBeNull();
    expect(queryAllByTestId(/^care-resource-/)).toHaveLength(0);
    expect(queryByTestId('care-support-card')).toBeNull();
    const reopen = getByTestId('care-reopen');
    expect(reopen.props.accessibilityLabel).toBe('Show the support options again');
    expect(queryByText('Support options')).not.toBeNull();
    // No card chrome survives anywhere between the reopen line and the
    // care-support wrapper: no raised ground, no accent stripe.
    let node: typeof reopen | null = reopen.parent;
    let hops = 0;
    while (node !== null) {
      const flat = StyleSheet.flatten(node.props.style) ?? {};
      expect(flat).not.toHaveProperty('backgroundColor');
      expect(flat).not.toHaveProperty('borderLeftWidth');
      hops += 1;
      if (node.props.testID === 'care-support') break;
      node = node.parent;
    }
    expect(node?.props.testID).toBe('care-support');
    expect(hops).toBeGreaterThan(1);
  });

  it('dismiss control still carries the care-support root after dismissal', () => {
    // The root container must survive dismiss — the user must never lose the
    // surface entirely.
    const { getByTestId } = render(<CareSupportNote care={carePayload()} />);
    fireEvent.press(getByTestId('care-dismiss'));
    expect(getByTestId('care-support')).toBeTruthy();
  });

  it('re-shows the resources when a NEW care object arrives after a prior dismissal (fresh crisis signal)', () => {
    const { getByTestId, queryByTestId, getByText, rerender } = render(
      <CareSupportNote care={carePayload()} />,
    );
    fireEvent.press(getByTestId('care-dismiss'));
    expect(queryByTestId('care-resource-hotline')).toBeNull();

    rerender(<CareSupportNote care={carePayload({ message: 'second crisis pass' })} />);

    expect(getByTestId('care-resource-hotline')).toBeTruthy();
    expect(getByTestId('care-support-card')).toBeTruthy();
    expect(getByText('second crisis pass')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Touch-target size
// ---------------------------------------------------------------------------

describe('CareSupportNote — touch-target requirements', () => {
  it('the X meets the 44dp minimum touch target', () => {
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
// Static reflection surface — not a chat/bot composer
// ---------------------------------------------------------------------------

describe('CareSupportNote — not a chat surface', () => {
  it('renders static content with no text-entry composer', () => {
    const { toJSON } = render(<CareSupportNote care={carePayload()} />);
    const types = hostTypes(toJSON());
    // Guard the walker: the card really renders Text content.
    expect(types).toContain('Text');
    // A reply/chat composer would mount a TextInput; a reflection card never does.
    expect(types).not.toContain('TextInput');
  });
});

// ---------------------------------------------------------------------------
// accessibilityLabel composition — the label must read
// "{name}. {contact}. {what_it_is}" so a screen reader hears the whole
// resource in one pass. (The per-resource testIDs and the non-empty-label
// contract are already covered above; only the exact format is asserted here.)
// ---------------------------------------------------------------------------

describe('CareSupportNote — accessibilityLabel composition', () => {
  it('composes the label as "{name}. {contact}. {what_it_is}"', () => {
    const payload = carePayload();
    const { getByTestId } = render(<CareSupportNote care={payload} />);
    const hotlineResource = payload.resources.find((r) => r.kind === 'hotline');
    if (!hotlineResource) throw new Error('fixture missing hotline resource');
    const card = getByTestId('care-resource-hotline');
    const expected = `${hotlineResource.name}. ${hotlineResource.contact}. ${hotlineResource.what_it_is}`;
    expect(card.props.accessibilityLabel).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Focus handoff — the X unmounts itself, so focus must land somewhere useful
// ---------------------------------------------------------------------------

type FocusCallTarget = { props: { testID?: unknown; accessibilityRole?: unknown } } | null;

function focusCall(index: number): { native: FocusCallTarget; web: FocusCallTarget } {
  const call = mockMoveFocus.mock.calls[index];
  if (call === undefined) throw new Error(`no focus handoff #${String(index)}`);
  const [native, web] = call as unknown as [FocusCallTarget, FocusCallTarget | undefined];
  return { native, web: web ?? native };
}

describe('CareSupportNote — focus handoff', () => {
  beforeEach(() => {
    mockMoveFocus.mockClear();
  });

  it('does not move focus when the card first appears', () => {
    render(<CareSupportNote care={carePayload()} />);
    expect(mockMoveFocus).not.toHaveBeenCalled();
  });

  it('hands focus to the reopen line when the X hides the card', () => {
    const { getByTestId } = render(<CareSupportNote care={carePayload()} />);
    fireEvent.press(getByTestId('care-dismiss'));

    expect(mockMoveFocus).toHaveBeenCalledTimes(1);
    const { native, web } = focusCall(0);
    expect(native?.props.testID).toBe('care-reopen');
    expect(web?.props.testID).toBe('care-reopen');
  });

  it('hands focus back to the card heading when the reopen line restores it', () => {
    const { getByTestId } = render(<CareSupportNote care={carePayload()} />);
    fireEvent.press(getByTestId('care-dismiss'));
    fireEvent.press(getByTestId('care-reopen'));

    expect(mockMoveFocus).toHaveBeenCalledTimes(2);
    const { native, web } = focusCall(1);
    // Native screen readers land on the heading; the web focuses the card,
    // since a heading is not a focusable element there.
    expect(native?.props.accessibilityRole).toBe('header');
    expect(web?.props.testID).toBe('care-support-card');
  });

  it('makes the card programmatically focusable on the web without adding a tab stop', () => {
    const card = render(<CareSupportNote care={carePayload()} />).getByTestId('care-support-card');
    expect(card.props.tabIndex).toBe(-1);
  });

  it('does not move focus when a fresh signal re-shows the card', () => {
    const { getByTestId, rerender } = render(<CareSupportNote care={carePayload()} />);
    fireEvent.press(getByTestId('care-dismiss'));
    mockMoveFocus.mockClear();

    rerender(<CareSupportNote care={carePayload({ message: 'second crisis pass' })} />);

    expect(getByTestId('care-support-card')).toBeTruthy();
    expect(mockMoveFocus).not.toHaveBeenCalled();
  });
});
