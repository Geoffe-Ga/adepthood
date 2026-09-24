import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  LIVE_SELECTION_ALPHA,
  LIVE_SELECTION_STYLE_ID,
  installLiveSelectionStyle,
  liveSelectionCss,
} from '../liveSelectionStyle';

import { writingField } from '@/design/tokens';

interface MutableGlobal {
  document?: unknown;
}

function fakeDocument() {
  const nodes: { id: string; textContent: string }[] = [];
  const head = {
    appendChild: jest.fn((node: { id: string; textContent: string }) => nodes.push(node)),
  };
  return {
    nodes,
    head,
    document: {
      head,
      getElementById: (id: string) => nodes.find((node) => node.id === id) ?? null,
      createElement: () => ({ id: '', textContent: '' }),
    },
  };
}

describe('liveSelectionCss', () => {
  it('highlights the field selection in a see-through tint of the caret token', () => {
    const hex = writingField.caret.slice(1);
    const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
    expect(LIVE_SELECTION_ALPHA).toBeGreaterThan(0);
    expect(LIVE_SELECTION_ALPHA).toBeLessThan(1);
    expect(liveSelectionCss()).toBe(
      `[data-testid="journal-body-input"]::selection{background-color:rgba(${r}, ${g}, ${b}, ${LIVE_SELECTION_ALPHA});-webkit-text-fill-color:transparent;}`,
    );
  });
});

describe('installLiveSelectionStyle', () => {
  afterEach(() => {
    delete (globalThis as MutableGlobal).document;
  });

  it('adds the rule once, however many fields mount', () => {
    const fake = fakeDocument();
    (globalThis as MutableGlobal).document = fake.document;
    expect(installLiveSelectionStyle()).toBe(true);
    expect(installLiveSelectionStyle()).toBe(true);
    expect(fake.head.appendChild).toHaveBeenCalledTimes(1);
    expect(fake.nodes[0]).toEqual({ id: LIVE_SELECTION_STYLE_ID, textContent: liveSelectionCss() });
  });

  it('does nothing without a DOM', () => {
    expect(installLiveSelectionStyle()).toBe(false);
    (globalThis as MutableGlobal).document = {};
    expect(installLiveSelectionStyle()).toBe(false);
  });
});
