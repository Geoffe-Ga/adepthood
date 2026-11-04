/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { trimSpanEdges } from '../anchorSpan';
import { markdownRuns, parseJournalMarkdown } from '../journalMarkdown';
import {
  SOURCE_START_ATTRIBUTE,
  journalSourceSpan,
  letterSourceSpan,
  readRenderedSelection,
  type DomNodeLike,
  type DomRangeLike,
  type RenderedSelection,
} from '../renderedSelection';

/**
 * The rendered-selection mappers (#3661): a reader's selection over rendered
 * text, flattened into text pieces, mapped back to code-point offsets into the
 * source. Pure: the DOM is a hand-built tree of the few members the flattening
 * reads, shaped the way react-native-web lays the real text out.
 */

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

interface FakeNode extends DomNodeLike {
  childNodes: FakeNode[];
}

function text(value: string): FakeNode {
  return { nodeType: TEXT_NODE, nodeValue: value, childNodes: [] };
}

function element(children: FakeNode[], srcStart?: number): FakeNode {
  return {
    nodeType: ELEMENT_NODE,
    nodeValue: null,
    childNodes: children,
    getAttribute: (name: string) =>
      name === SOURCE_START_ATTRIBUTE && srcStart !== undefined ? String(srcStart) : null,
  };
}

/** Every text node under ``node``, in document order. */
function textNodes(node: FakeNode): FakeNode[] {
  if (node.nodeType === TEXT_NODE) return [node];
  return node.childNodes.flatMap(textNodes);
}

/** The ``occurrence``-th text node holding ``needle``, and where in it ``needle`` begins. */
function locate(root: FakeNode, needle: string, occurrence = 0): { node: FakeNode; at: number } {
  const hits = textNodes(root).flatMap((node) => {
    const value = node.nodeValue ?? '';
    const found: { node: FakeNode; at: number }[] = [];
    for (let at = value.indexOf(needle); at >= 0; at = value.indexOf(needle, at + 1)) {
      found.push({ node, at });
    }
    return found;
  });
  const hit = hits[occurrence];
  if (hit === undefined) throw new Error(`"${needle}" is not rendered ${occurrence + 1} times`);
  return hit;
}

/** A range from the start of ``from`` to the end of ``to`` (each in its own text node). */
function rangeFrom(root: FakeNode, from: string, to: string, occurrence = 0): DomRangeLike {
  const start = locate(root, from, occurrence);
  const end = locate(root, to, occurrence);
  return {
    startContainer: start.node,
    startOffset: start.at,
    endContainer: end.node,
    endOffset: end.at + to.length,
  };
}

/**
 * Journal read mode as ``HighlightedBody`` draws it on the web: one element
 * per block, each visible run in a ``data-src-start`` host, and a line's
 * bullet glyph or the line feed between lines as text with no source behind it.
 */
function journalDom(body: string): FakeNode {
  const document = parseJournalMarkdown(body);
  const blocks = document.blocks.map((block) =>
    element(
      block.lines.flatMap((line, index) => [
        ...(index === 0 ? [] : [text('\n')]),
        ...(block.kind === 'bullet' ? [text('• ')] : []),
        ...markdownRuns(document, line.contentStart, line.end).map((run) =>
          element([run.bold ? element([text(run.text)]) : text(run.text)], run.start),
        ),
      ]),
    ),
  );
  return element(blocks);
}

/** The words a span stores: the code-point slice the server takes. */
function slice(body: string, span: { start: number; end: number } | null): string | null {
  return span === null ? null : Array.from(body).slice(span.start, span.end).join('');
}

function selectionOf(root: FakeNode, range: DomRangeLike): RenderedSelection {
  const selection = readRenderedSelection(root, range);
  if (selection === null) throw new Error('the range is not inside the container');
  return selection;
}

function journalSlice(body: string, from: string, to: string, occurrence = 0): string | null {
  const root = journalDom(body);
  return slice(
    body,
    journalSourceSpan(body, selectionOf(root, rangeFrom(root, from, to, occurrence))),
  );
}

const EMOJI = '\u{1F30A}';
const COMBINING_E = 'é';

describe('readRenderedSelection', () => {
  it('flattens the container into text pieces, each tagged with its run’s source start', () => {
    const root = element([element([text('Plain ')], 0), text('• '), element([text('bold')], 8)]);
    const selection = selectionOf(root, rangeFrom(root, 'Plain', 'bold'));
    expect(selection.pieces).toEqual([
      { text: 'Plain ', srcStart: 0 },
      { text: '• ', srcStart: null },
      { text: 'bold', srcStart: 8 },
    ]);
    expect(selection.start).toEqual({ piece: 0, offset: 0 });
    expect(selection.end).toEqual({ piece: 2, offset: 4 });
  });

  it('counts each later text node of one host from where the earlier ones ended, in code points', () => {
    const root = element([element([text(`a${EMOJI}`), text('cd')], 5)]);
    const selection = selectionOf(root, rangeFrom(root, 'cd', 'cd'));
    expect(selection.pieces[1]).toEqual({ text: 'cd', srcStart: 7 });
  });

  it('resolves a boundary between children to the text that follows it', () => {
    const first = element([text('one')], 0);
    const second = element([text('two')], 4);
    const root = element([first, second]);
    const selection = selectionOf(root, {
      startContainer: root,
      startOffset: 1,
      endContainer: root,
      endOffset: 2,
    });
    expect(selection.start).toEqual({ piece: 1, offset: 0 });
    // Past the last child: the end of the last piece, never a piece that is not there.
    expect(selection.end).toEqual({ piece: 1, offset: 3 });
  });

  it('is null when either end of the range lies outside the container', () => {
    const inside = text('inside');
    const outside = text('outside');
    const root = element([inside]);
    expect(
      readRenderedSelection(root, {
        startContainer: inside,
        startOffset: 0,
        endContainer: outside,
        endOffset: 3,
      }),
    ).toBeNull();
    expect(
      readRenderedSelection(root, {
        startContainer: outside,
        startOffset: 0,
        endContainer: inside,
        endOffset: 3,
      }),
    ).toBeNull();
  });

  it('is null for a container with no text at all', () => {
    const root = element([]);
    expect(
      readRenderedSelection(root, {
        startContainer: root,
        startOffset: 0,
        endContainer: root,
        endOffset: 0,
      }),
    ).toBeNull();
  });

  it('ignores a malformed source start and keeps the one it inherited', () => {
    const malformed: FakeNode = {
      ...element([text('x')]),
      getAttribute: (name: string) => (name === SOURCE_START_ATTRIBUTE ? 'not-a-number' : null),
    };
    const root = element([element([malformed], 3)]);
    expect(selectionOf(root, rangeFrom(root, 'x', 'x')).pieces).toEqual([
      { text: 'x', srcStart: 3 },
    ]);
  });
});

describe('journalSourceSpan — exact, because every run knows its source start', () => {
  it('maps a selection inside one run to exactly those words', () => {
    expect(journalSlice('I walked by the river.', 'by', 'river')).toBe('by the river');
  });

  it('counts an astral emoji as one code point', () => {
    expect(journalSlice(`${EMOJI} by the river`, 'the', 'river')).toBe('the river');
  });

  it('keeps a combining mark with its letter', () => {
    expect(journalSlice(`Caf${COMBINING_E} by the river`, 'Caf', 'by')).toBe(
      `Caf${COMBINING_E} by`,
    );
  });

  it('spans the hidden ** of a **bold** word it crosses, and only the word when it ends on it', () => {
    const body = 'so **bold** here';
    expect(journalSlice(body, 'so', 'here')).toBe(body);
    expect(journalSlice(body, 'bold', 'bold')).toBe('bold');
  });

  it('maps a link, which the journal draws as the literal it was typed as', () => {
    expect(journalSlice('see [the map](https://x.y) now', 'the map', 'the map')).toBe('the map');
  });

  it('tells a repeated sentence apart by where it was rendered, not by what it says', () => {
    const body = 'The same sentence. The same sentence.';
    const root = journalDom(body);
    const span = journalSourceSpan(body, selectionOf(root, rangeFrom(root, 'The', 'sentence.', 1)));
    expect(span).toEqual({ start: 19, end: 37 });
  });

  it('crosses two paragraphs, carrying the source between them', () => {
    expect(journalSlice('First line.\n\nSecond line.', 'line.', 'Second')).toBe('line.\n\nSecond');
  });

  it('snaps an end that starts on a bullet glyph forward onto the item’s text', () => {
    const body = 'Intro\n- one bullet';
    const root = journalDom(body);
    const glyph = locate(root, '• ');
    const range = {
      startContainer: glyph.node,
      startOffset: 0,
      endContainer: locate(root, 'one').node,
      endOffset: 3,
    };
    expect(slice(body, journalSourceSpan(body, selectionOf(root, range)))).toBe('one');
  });

  it('snaps an end that lands on a glyph back onto the text before it', () => {
    const body = 'Intro\n- one bullet';
    const root = journalDom(body);
    const glyph = locate(root, '• ');
    const range = {
      startContainer: locate(root, 'Intro').node,
      startOffset: 0,
      endContainer: glyph.node,
      endOffset: 1,
    };
    expect(slice(body, journalSourceSpan(body, selectionOf(root, range)))).toBe('Intro');
  });

  it('trims the edge whitespace a double-click drags in, as the server will', () => {
    expect(journalSlice('a word here', 'word ', 'word ')).toBe('word');
  });

  it('is null for a selection of decoration alone', () => {
    const body = '- one bullet';
    const root = journalDom(body);
    const glyph = locate(root, '• ');
    const range = {
      startContainer: glyph.node,
      startOffset: 0,
      endContainer: glyph.node,
      endOffset: 2,
    };
    expect(journalSourceSpan(body, selectionOf(root, range))).toBeNull();
  });

  it('is null for a whitespace-only selection', () => {
    expect(journalSlice('one   two', '   ', '   ')).toBeNull();
  });

  it('is null when no run follows the start or none precedes the end', () => {
    const root = element([text('• '), element([text('word')], 2), text('\n')]);
    const tail = selectionOf(root, rangeFrom(root, '\n', '\n'));
    expect(journalSourceSpan('- word', tail)).toBeNull();
    const head = selectionOf(root, rangeFrom(root, '• ', '• '));
    expect(journalSourceSpan('- word', head)).toBeNull();
  });
});

describe('letterSourceSpan — the rendered string is the letter itself', () => {
  function letterSlice(essay: string, from: string, to: string, occurrence = 0): string | null {
    const root = element([text(essay)]);
    const range = rangeFrom(root, from, to, occurrence);
    return slice(essay, letterSourceSpan(essay, selectionOf(root, range)));
  }

  it('counts an astral emoji as one code point', () => {
    expect(letterSlice(`${EMOJI} You wrote it down.`, 'You', 'down.')).toBe('You wrote it down.');
  });

  it('keeps a combining mark with its letter', () => {
    expect(letterSlice(`A caf${COMBINING_E} at dusk.`, 'caf', 'dusk')).toBe(
      `caf${COMBINING_E} at dusk`,
    );
  });

  it('maps **bold** and a link as the literal characters a letter shows', () => {
    const essay = 'Read **this** and [that](https://x.y) again.';
    expect(letterSlice(essay, '**this**', '**this**')).toBe('**this**');
    expect(letterSlice(essay, '[that]', '[that]')).toBe('[that]');
  });

  it('tells a repeated sentence apart by its place in the letter', () => {
    const essay = 'Stay with it. Stay with it.';
    const root = element([text(essay)]);
    const span = letterSourceSpan(essay, selectionOf(root, rangeFrom(root, 'Stay', 'it.', 1)));
    expect(span).toEqual({ start: 14, end: 27 });
  });

  it('crosses two paragraphs of one letter', () => {
    expect(letterSlice('One thought.\n\nAnother one.', 'thought.', 'Another')).toBe(
      'thought.\n\nAnother',
    );
  });

  it('maps a range drawn around the whole text element', () => {
    const essay = '  Come back to it.  ';
    const root = element([text(essay)]);
    const span = letterSourceSpan(
      essay,
      selectionOf(root, { startContainer: root, startOffset: 0, endContainer: root, endOffset: 1 }),
    );
    expect(slice(essay, span)).toBe('Come back to it.');
  });

  it('is null when what is rendered is not the letter (it never guesses)', () => {
    const root = element([text('Something else.')]);
    expect(
      letterSourceSpan('The letter.', selectionOf(root, rangeFrom(root, 'else', 'else'))),
    ).toBeNull();
  });

  it('is null for a whitespace-only selection', () => {
    expect(letterSlice('One.   Two.', '   ', '   ')).toBeNull();
  });
});

describe('trimSpanEdges', () => {
  it('trims a span by the rule the server applies to its snapshot', () => {
    expect(trimSpanEdges('  word\n', { start: 0, end: 7 })).toEqual({ start: 2, end: 6 });
  });

  it('collapses a whitespace-only span to its trimmed start', () => {
    expect(trimSpanEdges('a   b', { start: 1, end: 4 })).toEqual({ start: 4, end: 4 });
  });
});
