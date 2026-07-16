/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

/**
 * Covers ``ContractionReflectionNote``: a warm, declinable "tend your
 * foundation" reflection surface driven by the resonance-pass ``contraction``
 * field. The copy must never read as failure, demotion, or ranking language,
 * and a dismiss always fully hides the surface (no forced re-open, unlike
 * CareSupportNote).
 */
import ContractionReflectionNote from '../ContractionReflectionNote';

import type { ContractionReflection } from '@/api';
import { touchTarget } from '@/design/tokens';

function contraction(overrides: Partial<ContractionReflection> = {}): ContractionReflection {
  return {
    variant: 'simple_ease_off',
    message: 'Your practice has eased off a little. No rush back — pick it up when it calls.',
    ...overrides,
  };
}

function returnOfferContraction(
  overrides: Partial<ContractionReflection> = {},
): ContractionReflection {
  return {
    variant: 'return_offer',
    message:
      'It has been a while since you tended this. A five-week Return is here if you want it.',
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

describe('ContractionReflectionNote — null contraction', () => {
  it('renders nothing when contraction is null', () => {
    const { queryByTestId } = render(<ContractionReflectionNote contraction={null} />);
    expect(queryByTestId('contraction-reflection')).toBeNull();
  });
});

describe('ContractionReflectionNote — initial render', () => {
  it('mounts the root container with testID "contraction-reflection"', () => {
    const { getByTestId } = render(<ContractionReflectionNote contraction={contraction()} />);
    expect(getByTestId('contraction-reflection')).toBeTruthy();
  });

  it('renders the backend message text', () => {
    const { getByText } = render(<ContractionReflectionNote contraction={contraction()} />);
    expect(
      getByText('Your practice has eased off a little. No rush back — pick it up when it calls.'),
    ).toBeTruthy();
  });

  it('gives the title element accessibilityRole="header"', () => {
    const { getByTestId } = render(<ContractionReflectionNote contraction={contraction()} />);
    const title = getByTestId('contraction-reflection-title');
    expect(title.props.accessibilityRole).toBe('header');
  });
});

describe('ContractionReflectionNote — variant-distinct titles', () => {
  it('renders a different title for simple_ease_off vs return_offer, both with their message', () => {
    const easeOff = render(<ContractionReflectionNote contraction={contraction()} />);
    const easeOffTitle = textOf(easeOff.getByTestId('contraction-reflection-title'));
    expect(
      easeOff.getByText(
        'Your practice has eased off a little. No rush back — pick it up when it calls.',
      ),
    ).toBeTruthy();

    const returnOffer = render(
      <ContractionReflectionNote contraction={returnOfferContraction()} />,
    );
    const returnTitle = textOf(returnOffer.getByTestId('contraction-reflection-title'));
    expect(
      returnOffer.getByText(
        'It has been a while since you tended this. A five-week Return is here if you want it.',
      ),
    ).toBeTruthy();

    expect(easeOffTitle).not.toBe(returnTitle);
  });
});

describe('ContractionReflectionNote — dismiss', () => {
  it('mounts a dismiss control with testID "contraction-dismiss"', () => {
    const { getByTestId } = render(<ContractionReflectionNote contraction={contraction()} />);
    expect(getByTestId('contraction-dismiss')).toBeTruthy();
  });

  it('gives the dismiss control accessibilityRole "button" and a non-empty accessibilityLabel', () => {
    const { getByTestId } = render(<ContractionReflectionNote contraction={contraction()} />);
    const dismiss = getByTestId('contraction-dismiss');
    expect(dismiss.props.accessibilityRole).toBe('button');
    const label: unknown = dismiss.props.accessibilityLabel;
    expect(typeof label).toBe('string');
    expect((label as string).length).toBeGreaterThan(0);
  });

  it('hides the whole surface after one tap on contraction-dismiss', () => {
    const { getByTestId, queryByTestId } = render(
      <ContractionReflectionNote contraction={contraction()} />,
    );
    fireEvent.press(getByTestId('contraction-dismiss'));
    expect(queryByTestId('contraction-reflection')).toBeNull();
  });

  it('re-shows the note when a NEW contraction object arrives after a prior dismissal', () => {
    const { getByTestId, getByText, queryByTestId, rerender } = render(
      <ContractionReflectionNote contraction={contraction()} />,
    );
    fireEvent.press(getByTestId('contraction-dismiss'));
    expect(queryByTestId('contraction-reflection')).toBeNull();

    const fresh = contraction({ message: 'A fresh reflection for a new pass.' });
    rerender(<ContractionReflectionNote contraction={fresh} />);

    expect(getByTestId('contraction-reflection')).toBeTruthy();
    expect(getByText('A fresh reflection for a new pass.')).toBeTruthy();
  });
});

describe('ContractionReflectionNote — touch-target requirements', () => {
  it('dismiss control meets the 44dp minimum touch target', () => {
    const { getByTestId } = render(<ContractionReflectionNote contraction={contraction()} />);
    const dismiss = getByTestId('contraction-dismiss');
    expect(StyleSheetMin(dismiss)).toBeGreaterThanOrEqual(touchTarget.minimum);
  });
});

describe('ContractionReflectionNote — non-punitive intent', () => {
  it('renders no failure/demotion/ranking language for simple_ease_off', () => {
    const rendered = render(<ContractionReflectionNote contraction={contraction()} />);
    expect(textOf(rendered.getByTestId('contraction-reflection'))).not.toMatch(
      /fail|demot|fell behind|rank/i,
    );
  });

  it('renders no failure/demotion/ranking language for return_offer', () => {
    const rendered = render(<ContractionReflectionNote contraction={returnOfferContraction()} />);
    expect(textOf(rendered.getByTestId('contraction-reflection'))).not.toMatch(
      /fail|demot|fell behind|rank/i,
    );
  });
});

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

describe('ContractionReflectionNote — not a chat surface', () => {
  it('renders static content with no text-entry composer', () => {
    const { toJSON } = render(<ContractionReflectionNote contraction={contraction()} />);
    const types = hostTypes(toJSON());
    // Guard the walker: the note really renders Text content.
    expect(types).toContain('Text');
    // A reply/chat composer would mount a TextInput; a reflection note never does.
    expect(types).not.toContain('TextInput');
  });
});

/** Concatenates all visible text strings under a rendered element for a scan. */
function textOf(node: { children: readonly unknown[] }): string {
  const parts: string[] = [];
  const walk = (n: unknown): void => {
    if (typeof n === 'string') {
      parts.push(n);
      return;
    }
    if (n != null && typeof n === 'object' && 'children' in n) {
      const withChildren = n as { children: readonly unknown[] };
      for (const child of withChildren.children) walk(child);
    }
  };
  walk(node);
  return parts.join(' ');
}
