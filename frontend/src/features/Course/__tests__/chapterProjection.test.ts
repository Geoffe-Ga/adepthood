/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import type { RenderedSelection } from '../../Journal/renderedSelection';
import { chapterPassage, foldRendered, projectChapter } from '../chapterProjection';

/**
 * The Course mapper (#3661): a selection over a chapter as
 * ``react-native-markdown-display`` renders it, found in a projection of the
 * Markdown and mapped back to code points -- exactly when the page and the
 * projection agree on where it is, as a best guess when they cannot.
 *
 * ``rendered`` is the page's text nodes in order, the way the renderer draws
 * them: typographer quotes and dashes, a bullet drawn per item, a link's text
 * and no image.
 */

/** A selection from the ``occurrence``-th ``from`` to the end of the next ``to`` across ``rendered``. */
function select(rendered: string[], from: string, to: string, occurrence = 0): RenderedSelection {
  const joined = rendered.join('');
  let start = -1;
  for (let seen = 0; seen <= occurrence; seen += 1) start = joined.indexOf(from, start + 1);
  const end = joined.indexOf(to, start) + to.length;
  if (start < 0 || end < to.length) throw new Error(`"${from}"..."${to}" is not rendered`);
  const point = (offset: number, isEnd: boolean) => {
    let base = 0;
    for (let piece = 0; piece < rendered.length; piece += 1) {
      const length = rendered[piece]?.length ?? 0;
      if (isEnd ? offset <= base + length : offset < base + length) {
        return { piece, offset: offset - base };
      }
      base += length;
    }
    throw new Error('past the rendered text');
  };
  return {
    pieces: rendered.map((text) => ({ text, srcStart: null })),
    start: point(start, false),
    end: point(end, true),
  };
}

/** The source words a passage stores. */
function slice(markdown: string, span: { start: number; end: number } | null): string | null {
  return span === null ? null : Array.from(markdown).slice(span.start, span.end).join('');
}

function passageOf(markdown: string, rendered: string[], from: string, to: string, occurrence = 0) {
  return chapterPassage(projectChapter(markdown), select(rendered, from, to, occurrence));
}

const EMOJI = '\u{1F30A}';
const COMBINING_E = 'é';

describe('foldRendered', () => {
  it('drops whitespace and markup, straightens quotes, and spells dashes and ellipses', () => {
    expect(foldRendered('don’t – wait… “no” **x** •')).toBe('don\'t--wait..."no"x');
  });
});

describe('chapterPassage — exact', () => {
  it('counts an astral emoji as one code point', () => {
    const md = `${EMOJI} by the river.`;
    const span = passageOf(md, [`${EMOJI} by the river.`], 'the', 'river');
    expect(slice(md, span)).toBe('the river');
    expect(span?.exact).toBe(true);
  });

  it('keeps a combining mark with its letter', () => {
    const md = `A caf${COMBINING_E} at dusk.`;
    expect(slice(md, passageOf(md, [md], 'caf', 'at'))).toBe(`caf${COMBINING_E} at`);
  });

  it('crosses **bold** whole, and takes only the word when it ends on it', () => {
    const md = 'so **bold** and on';
    const rendered = ['so ', 'bold', ' and on'];
    expect(slice(md, passageOf(md, rendered, 'so', 'and'))).toBe('so **bold** and');
    expect(slice(md, passageOf(md, rendered, 'bold', 'bold'))).toBe('bold');
  });

  it('maps a link’s text, never its target', () => {
    const md = 'Read [the long note](https://example.com/n) twice.';
    const rendered = ['Read ', 'the long note', ' twice.'];
    expect(slice(md, passageOf(md, rendered, 'the long', 'note'))).toBe('the long note');
    expect(slice(md, passageOf(md, rendered, 'Read', 'twice.'))).toBe(md);
  });

  it('tells a repeated sentence apart by how many come before it on the page', () => {
    const md = 'Stay with it. Stay with it.';
    const span = passageOf(md, [md], 'Stay', 'it.', 1);
    expect(span).toEqual({ start: 14, end: 27, exact: true });
  });

  it('crosses two paragraphs, carrying the source between them', () => {
    const md = 'The first one ends.\n\nThe second begins.';
    const rendered = ['The first one ends.', 'The second begins.'];
    expect(slice(md, passageOf(md, rendered, 'ends.', 'second'))).toBe('ends.\n\nThe second');
  });

  it('reads past the typographer’s quotes, dashes and ellipses', () => {
    const md = 'Don\'t stop -- not yet... "Go."';
    const rendered = ['Don’t stop – not yet… “Go.”'];
    const span = passageOf(md, rendered, 'stop', 'Go.');
    expect(slice(md, span)).toBe('stop -- not yet... "Go.');
    expect(span?.exact).toBe(true);
  });

  it('drops heading, quote and bullet prefixes, and the bullets the renderer draws', () => {
    const md = '### A heading\n\n> > A nested quote.\n\n- one item\n- [ ] two items';
    const rendered = ['A heading', 'A nested quote.', '•', 'one item', '•', 'two items'];
    expect(slice(md, passageOf(md, rendered, 'heading', 'nested'))).toBe('heading\n\n> > A nested');
    expect(slice(md, passageOf(md, rendered, 'one', 'two'))).toBe('one item\n- [ ] two');
  });

  it('keeps brackets that open no link as the text they are', () => {
    const md = 'A [bracketed aside] and [one left open (here.';
    expect(slice(md, passageOf(md, [md], '[bracketed', 'open'))).toBe(
      '[bracketed aside] and [one left open',
    );
  });

  it('skips an image, which draws no text, and a table’s pipes and divider', () => {
    const md =
      '![a heron](https://x.y/h.png)\nThe heron.\n\n| when | what |\n|---|:-:|\n| dawn | stillness |';
    const rendered = ['The heron.', 'when', 'what', 'dawn', 'stillness'];
    expect(slice(md, passageOf(md, rendered, 'The', 'heron.'))).toBe('The heron.');
    expect(slice(md, passageOf(md, rendered, 'dawn', 'stillness'))).toBe('dawn | stillness');
  });
});

describe('chapterPassage — a best guess, confirmed in the selection field', () => {
  it('guesses across an ordered list’s drawn numbers from the passage’s head and tail', () => {
    const md = '1. the first item here\n2. the second item there';
    const rendered = ['1.', 'the first item here', '2.', 'the second item there'];
    const span = passageOf(md, rendered, 'first', 'second');
    expect(span?.exact).toBe(false);
    expect(slice(md, span)).toBe('first item here\n2. the second');
  });

  it('guesses the matching occurrence when the page and the projection disagree on how many', () => {
    const md = 'An echo here. An echo there.';
    // The page shows the passage once (the rest of the chapter is not drawn).
    const span = passageOf(md, ['An echo there.'], 'An', 'echo');
    expect(span).toEqual({ start: 0, end: 7, exact: false });
  });

  it('chooses nothing when no part of it is found', () => {
    const span = passageOf(
      'Something else entirely.',
      ['Never written here at all'],
      'Never',
      'all',
    );
    expect(span).toEqual({ start: 0, end: 0, exact: false });
  });

  it('keeps a head it finds when no tail follows it', () => {
    const md = 'A sentence that ends.';
    const span = passageOf(md, ['A sentence that ends', '2.', 'zzzzzzz'], 'sentence', 'zzzzzzz');
    expect(span?.exact).toBe(false);
    expect(slice(md, span)).toBe('sentence that ends');
  });
});

describe('chapterPassage — nothing to promote', () => {
  it('is null for a selection of whitespace or drawn bullets alone', () => {
    const md = '- one\n- two';
    expect(passageOf(md, ['•', 'one', '  ', '•', 'two'], '  ', '  ')).toBeNull();
    expect(passageOf(md, ['•', 'one', '•', 'two'], '•', '•')).toBeNull();
  });
});
