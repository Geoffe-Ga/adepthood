// #3660: a passage chosen before the selection surface opened (a Course
// quote's Open) can sit screens down a field that grows to its text, so the
// page has to be scrolled to it. The field never scrolls inside, so the
// browser cannot do that by itself; a hidden copy of the field's text up to
// the passage marks the spot to bring into view.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { revealWebOffset } from '../webSelectionReveal';

const Platform = require('react-native').Platform as { OS: string };

const COMPUTED: Record<string, string> = {
  boxSizing: 'border-box',
  width: '342px',
  paddingLeft: '12px',
  fontFamily: 'Georgia',
  fontSize: '18px',
  lineHeight: '29px',
};

interface FakeElement {
  tag: string;
  style: Record<string, string>;
  textContent: string;
  children: FakeElement[];
  attributes: Record<string, string>;
  appendChild: (child: FakeElement) => FakeElement;
  setAttribute: (name: string, value: string) => void;
  remove: jest.Mock;
  scrollIntoView: jest.Mock;
}

function element(tag: string): FakeElement {
  const made: FakeElement = {
    tag,
    style: {},
    textContent: '',
    children: [],
    attributes: {},
    appendChild: (child) => {
      made.children.push(child);
      return child;
    },
    setAttribute: (name, value) => {
      made.attributes[name] = value;
    },
    remove: jest.fn(),
    scrollIntoView: jest.fn(),
  };
  return made;
}

/** A host textarea laid out at (16, 140) inside a positioned parent. */
function hostField(value: string) {
  const created: FakeElement[] = [];
  const parent = element('div');
  const node = {
    value,
    offsetTop: 140,
    offsetLeft: 16,
    offsetParent: parent,
    ownerDocument: {
      createElement: (tag: string) => {
        const made = element(tag);
        created.push(made);
        return made;
      },
      defaultView: { getComputedStyle: () => COMPUTED },
    },
  };
  return { node, parent, created };
}

describe('revealWebOffset', () => {
  let originalOS: string;
  beforeEach(() => {
    originalOS = Platform.OS;
    Platform.OS = 'web';
  });
  afterEach(() => {
    Platform.OS = originalOS;
  });

  it('brings the passage at the offset to the middle of the scroller, then leaves no trace', () => {
    const { node, parent, created } = hostField('First line.\nThe passage deep down.');

    expect(revealWebOffset(node, 12)).toBe(true);

    const [mirror, marker] = created;
    expect(parent.children).toEqual([mirror]);
    expect(mirror?.children[1]).toBe(marker);
    expect(mirror?.children[0]?.textContent).toBe('First line.\n');
    expect(mirror?.children[2]?.textContent).toBe('The passage deep down.');
    expect(marker?.scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' });
    expect(mirror?.remove).toHaveBeenCalledTimes(1);
  });

  it('lays the copy over the field in its own type, wrapping as it wraps, unseen', () => {
    const { node, created } = hostField('Some text');

    revealWebOffset(node, 4);

    expect(created[0]?.style).toMatchObject({
      position: 'absolute',
      top: '140px',
      left: '16px',
      visibility: 'hidden',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'break-word',
      width: '342px',
      fontFamily: 'Georgia',
      fontSize: '18px',
      lineHeight: '29px',
      paddingLeft: '12px',
    });
    expect(created[0]?.attributes['aria-hidden']).toBe('true');
  });

  it.each([
    ['off the web', 'ios', {}],
    ['for a node that is not a laid-out field', 'web', { value: 'x' }],
    ['for a detached field', 'web', { ...hostField('x').node, offsetParent: null }],
  ])('does nothing %s', (_label, os, node) => {
    Platform.OS = os;
    expect(revealWebOffset(node, 0)).toBe(false);
  });

  it('does nothing without a window to read the field’s type from', () => {
    const { node, created } = hostField('x');
    const detached = { ...node, ownerDocument: { ...node.ownerDocument, defaultView: null } };

    expect(revealWebOffset(detached, 0)).toBe(false);
    expect(created).toEqual([]);
  });
});
