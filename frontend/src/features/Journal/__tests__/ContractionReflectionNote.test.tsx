/* eslint-env jest */
import { beforeEach, describe, it, expect, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

/**
 * Covers ``ContractionReflectionNote``: a warm, declinable "tend your
 * foundation" reflection surface driven by the resonance-pass ``contraction``
 * field. The copy must never read as failure, demotion, or ranking language,
 * and a dismiss always fully hides the surface (no forced re-open, unlike
 * CareSupportNote).
 */
import ContractionReflectionNote from '../ContractionReflectionNote';

import type { ContractionReflection, ReturnWeek } from '@/api';
import { touchTarget } from '@/design/tokens';
import {
  RETURN_CONFIRM_CANCEL,
  RETURN_CONFIRM_CANCEL_A11Y,
  RETURN_CONFIRM_GUARANTEE,
  RETURN_CONFIRM_HEADING,
  RETURN_DISMISS_ERROR,
  RETURN_OFFER_ACCEPT,
  RETURN_OFFER_ACCEPT_A11Y,
  RETURN_START_ERROR,
  buildReturnConfirmWeekLine,
} from '@/features/Return/returnCopy';
import type { UseMettaReturnResult } from '@/features/Return/useMettaReturn';

// The note consults the Return's own hook to decide whether an offer may be
// accepted here. Mocked for the whole file so no test in it touches the network
// or the shared contraction-signal store.
const mockUseMettaReturn = jest.fn() as jest.MockedFunction<() => UseMettaReturnResult>;
jest.mock('@/features/Return/useMettaReturn', () => ({
  useMettaReturn: (): unknown => mockUseMettaReturn(),
}));

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

// ---------------------------------------------------------------------------
// The Return offer: accepting a Return from the entry that names one (#2727).
// ---------------------------------------------------------------------------

const RETURN_WEEKS: readonly ReturnWeek[] = [
  { week_number: 1, focus: 'self', title: 'Coming home to steady ground', framing: 'Begin here.' },
  { week_number: 2, focus: 'benefactor', title: 'Someone who has held you', framing: 'Then them.' },
  { week_number: 3, focus: 'stranger', title: 'A face you barely know', framing: 'Then them too.' },
  {
    week_number: 4,
    focus: 'antagonist',
    title: 'Meeting a hard heart with softness',
    framing: 'And them.',
  },
  {
    week_number: 5,
    focus: 'all_beings',
    title: 'The circle without an edge',
    framing: 'All of it.',
  },
];

const mockStart = jest.fn() as jest.MockedFunction<() => Promise<void>>;
const mockDismissOffer = jest.fn() as jest.MockedFunction<() => Promise<void>>;

/** A full ``useMettaReturn`` result, offer live by default; overrides narrow it. */
function returnHook(overrides: Partial<UseMettaReturnResult> = {}): UseMettaReturnResult {
  const noopAsync = (): Promise<void> => Promise.resolve();
  return {
    eligible: true,
    weeks: [...RETURN_WEEKS],
    arc: null,
    offerVisible: true,
    letGoVisible: false,
    releasedHabits: [],
    dismissOffer: mockDismissOffer,
    start: mockStart,
    pause: noopAsync,
    resume: noopAsync,
    leave: noopAsync,
    release: noopAsync,
    recommit: noopAsync,
    skipLetGo: (): void => undefined,
    ...overrides,
  };
}

/**
 * Flush the microtask an unawaited ``start``/``dismissOffer`` resolves on, inside
 * ``act``, so the re-render it triggers is applied before the next assertion.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Point the mocked hook at one result for the test about to run. */
function offer(overrides: Partial<UseMettaReturnResult> = {}): void {
  mockUseMettaReturn.mockImplementation(() => returnHook(overrides));
}

beforeEach(() => {
  mockStart.mockImplementation(() => Promise.resolve());
  mockDismissOffer.mockImplementation(() => Promise.resolve());
  offer();
});

describe('ContractionReflectionNote — the Return is enterable from the entry', () => {
  it('offers "Begin the Return" on a return_offer while the offer is live', () => {
    const { getByTestId } = render(
      <ContractionReflectionNote contraction={returnOfferContraction()} />,
    );
    const accept = getByTestId('contraction-return-accept');
    expect(textOf(accept)).toContain(RETURN_OFFER_ACCEPT);
    expect(accept.props.accessibilityRole).toBe('button');
    expect(accept.props.accessibilityLabel).toBe(RETURN_OFFER_ACCEPT_A11Y);
    expect(StyleSheetMin(accept)).toBeGreaterThanOrEqual(touchTarget.minimum);
  });

  it('offers nothing to begin on a simple_ease_off, even while the offer is live', () => {
    const { queryByTestId } = render(<ContractionReflectionNote contraction={contraction()} />);
    expect(queryByTestId('contraction-return-accept')).toBeNull();
  });

  it('offers nothing to begin when the Return is not on offer', () => {
    offer({ offerVisible: false });
    const { queryByTestId, getByTestId } = render(
      <ContractionReflectionNote contraction={returnOfferContraction()} />,
    );
    expect(queryByTestId('contraction-return-accept')).toBeNull();
    expect(getByTestId('contraction-reflection')).toBeTruthy();
  });
});

describe('ContractionReflectionNote — the confirmation says what a Return is', () => {
  it('opens a confirmation naming the five weekly foci, and starts nothing yet', () => {
    const { getByTestId, getByText } = render(
      <ContractionReflectionNote contraction={returnOfferContraction()} />,
    );
    fireEvent.press(getByTestId('contraction-return-accept'));

    expect(getByTestId('contraction-return-confirm-card')).toBeTruthy();
    expect(getByText(RETURN_CONFIRM_HEADING)).toBeTruthy();
    expect(getByText(RETURN_CONFIRM_GUARANTEE)).toBeTruthy();
    for (const week of RETURN_WEEKS) {
      expect(getByText(buildReturnConfirmWeekLine(week.week_number, week.title))).toBeTruthy();
    }
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('names the weeks the server sent rather than any invented sequence', () => {
    offer({
      weeks: [
        { week_number: 1, focus: 'self', title: 'A week the server named', framing: 'Begin here.' },
      ],
    });
    const { getByTestId, getByText, queryByText } = render(
      <ContractionReflectionNote contraction={returnOfferContraction()} />,
    );
    fireEvent.press(getByTestId('contraction-return-accept'));

    expect(getByText(buildReturnConfirmWeekLine(1, 'A week the server named'))).toBeTruthy();
    expect(queryByText(buildReturnConfirmWeekLine(5, 'The circle without an edge'))).toBeNull();
  });

  it('cancelling starts nothing and leaves the card standing', () => {
    const { getByTestId, queryByTestId } = render(
      <ContractionReflectionNote contraction={returnOfferContraction()} />,
    );
    fireEvent.press(getByTestId('contraction-return-accept'));
    const cancel = getByTestId('contraction-return-confirm-cancel');
    expect(textOf(cancel)).toContain(RETURN_CONFIRM_CANCEL);
    expect(cancel.props.accessibilityLabel).toBe(RETURN_CONFIRM_CANCEL_A11Y);

    fireEvent.press(cancel);

    expect(mockStart).not.toHaveBeenCalled();
    expect(queryByTestId('contraction-return-confirm-card')).toBeNull();
    expect(getByTestId('contraction-reflection')).toBeTruthy();
    expect(getByTestId('contraction-return-accept')).toBeTruthy();
  });

  it('the scrim closes the confirmation without starting anything', () => {
    const { getByTestId, queryByTestId } = render(
      <ContractionReflectionNote contraction={returnOfferContraction()} />,
    );
    fireEvent.press(getByTestId('contraction-return-accept'));
    fireEvent.press(getByTestId('contraction-return-confirm-scrim'));

    expect(mockStart).not.toHaveBeenCalled();
    expect(queryByTestId('contraction-return-confirm-card')).toBeNull();
  });

  it('confirms with no pressure: no streak, urgency, or cost-of-declining language', () => {
    const { getByTestId } = render(
      <ContractionReflectionNote contraction={returnOfferContraction()} />,
    );
    fireEvent.press(getByTestId('contraction-return-accept'));
    const words = textOf(getByTestId('contraction-return-confirm-card'));

    expect(words).not.toMatch(/streak|hurry|right now|last chance|miss out|don.?t lose|expires/i);
    expect(words).not.toMatch(/fail|behind|must|required to|should/i);
  });
});

describe('ContractionReflectionNote — confirming begins exactly one Return', () => {
  it('starts the Return once even when the confirm is double-tapped', async () => {
    let releaseStart: () => void = () => undefined;
    mockStart.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseStart = resolve;
        }),
    );
    const { getByTestId } = render(
      <ContractionReflectionNote contraction={returnOfferContraction()} />,
    );
    fireEvent.press(getByTestId('contraction-return-accept'));

    fireEvent.press(getByTestId('contraction-return-confirm-accept'));
    fireEvent.press(getByTestId('contraction-return-confirm-accept'));

    expect(mockStart).toHaveBeenCalledTimes(1);

    // Let the single in-flight start settle inside act, so the arc it opens is
    // the only one and the tree is quiet before the next test renders.
    await act(async () => {
      releaseStart();
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(getByTestId('contraction-reflection')).toBeTruthy();
  });

  it('stops offering a beginning once the Return has begun', async () => {
    const { getByTestId, queryByTestId } = render(
      <ContractionReflectionNote contraction={returnOfferContraction()} />,
    );
    fireEvent.press(getByTestId('contraction-return-accept'));
    fireEvent.press(getByTestId('contraction-return-confirm-accept'));

    await flush();
    expect(queryByTestId('contraction-return-accept')).toBeNull();
    expect(queryByTestId('contraction-return-confirm-card')).toBeNull();
    expect(getByTestId('contraction-reflection')).toBeTruthy();
  });

  it('a failed start leaves the card standing and says so, without crashing', async () => {
    mockStart.mockImplementation(() => Promise.reject(new Error('offline')));
    const { getByTestId, getByText } = render(
      <ContractionReflectionNote contraction={returnOfferContraction()} />,
    );
    fireEvent.press(getByTestId('contraction-return-accept'));
    fireEvent.press(getByTestId('contraction-return-confirm-accept'));

    await flush();
    expect(getByText(RETURN_START_ERROR)).toBeTruthy();
    expect(getByTestId('contraction-reflection')).toBeTruthy();
    expect(getByTestId('contraction-return-accept')).toBeTruthy();
  });
});

describe('ContractionReflectionNote — declining here is honoured on the shelf', () => {
  it('persists the decline and hides the card on "Not now"', async () => {
    const { getByTestId, queryByTestId } = render(
      <ContractionReflectionNote contraction={returnOfferContraction()} />,
    );
    fireEvent.press(getByTestId('contraction-dismiss'));

    expect(queryByTestId('contraction-reflection')).toBeNull();
    await flush();
    expect(mockDismissOffer).toHaveBeenCalledTimes(1);
  });

  it('persists nothing when there was no live offer to decline', () => {
    offer({ offerVisible: false });
    const { getByTestId, queryByTestId } = render(
      <ContractionReflectionNote contraction={returnOfferContraction()} />,
    );
    fireEvent.press(getByTestId('contraction-dismiss'));

    expect(queryByTestId('contraction-reflection')).toBeNull();
    expect(mockDismissOffer).not.toHaveBeenCalled();
  });

  it('a failed decline still sets the card aside and says the choice may not have carried', async () => {
    mockDismissOffer.mockImplementation(() => Promise.reject(new Error('offline')));
    const { getByTestId, getByText, queryByTestId } = render(
      <ContractionReflectionNote contraction={returnOfferContraction()} />,
    );
    fireEvent.press(getByTestId('contraction-dismiss'));

    await flush();
    expect(getByText(RETURN_DISMISS_ERROR)).toBeTruthy();
    expect(queryByTestId('contraction-reflection')).toBeNull();
  });
});
