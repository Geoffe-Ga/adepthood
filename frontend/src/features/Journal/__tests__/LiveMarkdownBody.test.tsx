/* eslint-env jest */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, configure, fireEvent, render } from '@testing-library/react-native';
import React, { useRef, useState } from 'react';
import { StyleSheet, type TextInput } from 'react-native';

import { parseJournalMarkdown } from '../journalMarkdown';
import LiveMarkdownBody from '../LiveMarkdownBody';
import { MIRROR_HIDDEN_OPACITY } from '../LiveMarkdownStyles';
import { buildMirrorModel, visibleMirrorRuns } from '../markdownMirror';

import { CORPUS } from './fixtures/journalMarkdownCorpus';

import { colors } from '@/design/tokens';

const Platform = require('react-native').Platform as { OS: string };

// The mirror is hidden from assistive technology by design, and the testing
// library's queries honour that by default; these tests look at it anyway.
// The accessibility test below checks the hiding with the default restored.
configure({ defaultIncludeHiddenElements: true });

type RenderedNode = ReturnType<ReturnType<typeof render>['getByTestId']>;

/** Every string leaf under a node, in render order, verbatim. */
function renderedText(node: RenderedNode): string {
  return node.children
    .map((child: RenderedNode | string) =>
      typeof child === 'string' ? child : renderedText(child),
    )
    .join('');
}

/** Every testID a HOST element under a node carries (composites repeat their host's). */
function testIDsUnder(node: RenderedNode): string[] {
  const isHost = typeof node.type === 'string';
  const own = isHost && typeof node.props.testID === 'string' ? [node.props.testID as string] : [];
  return [
    ...own,
    ...node.children.flatMap((child: RenderedNode | string) =>
      typeof child === 'string' ? [] : testIDsUnder(child),
    ),
  ];
}

interface HarnessProps {
  initial: string;
  onChangeBody?: (next: string) => void;
  fieldRef?: React.RefObject<TextInput | null>;
}

/** The body field as the entry screen owns it: parent state fed back as the value. */
function Harness({ initial, onChangeBody, fieldRef }: HarnessProps): React.JSX.Element {
  const [body, setBody] = useState(initial);
  const ownRef = useRef<TextInput>(null);
  const inputRef = fieldRef ?? ownRef;
  return (
    <LiveMarkdownBody
      body={body}
      onChangeBody={(next) => {
        onChangeBody?.(next);
        setBody(next);
      }}
      bodyPlaceholder="Write"
      inputRef={inputRef}
    />
  );
}

interface MutableGlobal {
  window?: { matchMedia: (query: string) => { matches: boolean } };
  document?: Document;
}

describe('LiveMarkdownBody on web', () => {
  let originalOS: string;
  beforeEach(() => {
    originalOS = Platform.OS;
    Platform.OS = 'web';
  });
  afterEach(() => {
    Platform.OS = originalOS;
    delete (globalThis as MutableGlobal).window;
  });

  it('styles bold on the keystroke that completes the closing delimiter', () => {
    const { getByTestId, queryByTestId } = render(<Harness initial="" />);
    const input = getByTestId('journal-body-input');

    fireEvent.changeText(input, '**a*');
    expect(queryByTestId('journal-live-bold-2')).toBeNull();

    fireEvent.changeText(input, '**a**');
    expect(renderedText(getByTestId('journal-live-bold-2'))).toBe('a');
    expect(getByTestId('journal-body-input').props.value).toBe('**a**');
  });

  it.each([
    ['**a**', 'bold', 2],
    ['*a*', 'bold', 1],
    ['__a__', 'bold', 2],
    ['_a_', 'italic', 1],
    ['<u>a</u>', 'underline', 3],
  ])('renders %j as %s in the mirror', (body, style, start) => {
    const { getByTestId } = render(<Harness initial={body} />);
    expect(renderedText(getByTestId(`journal-live-${style}-${start}`))).toBe('a');
  });

  it('draws underline as a decoration and bold without a heavier (wider) face', () => {
    const { getByTestId } = render(<Harness initial="**b** <u>u</u>" />);
    const bold = StyleSheet.flatten(getByTestId('journal-live-bold-2').props.style);
    expect(bold.fontWeight).toBeUndefined();
    expect(bold.textShadowColor).toBe(colors.paper.ink);
    expect(StyleSheet.flatten(getByTestId('journal-live-underline-9').props.style)).toMatchObject({
      textDecorationLine: 'underline',
    });
  });

  it('renders a retired ==x== as literal prose, not underline', () => {
    const { getByTestId } = render(<Harness initial="a ==u== b" />);
    const ids = testIDsUnder(getByTestId('journal-body-mirror'));
    expect(ids.some((id) => id.startsWith('journal-live-underline'))).toBe(false);
  });

  it.each(CORPUS)('draws every character of %j and styles exactly the model runs', (body) => {
    const { getByTestId } = render(<Harness initial={body} />);
    const mirror = getByTestId('journal-body-mirror');
    expect(renderedText(mirror)).toBe(body);

    const expected = buildMirrorModel(parseJournalMarkdown(body), {
      start: Array.from(body).length,
      end: Array.from(body).length,
    })
      .flatMap(visibleMirrorRuns)
      .flatMap((run) =>
        (['bold', 'italic', 'underline'] as const)
          .filter((style) => run[style])
          .map((style) => `journal-live-${style}-${run.start}`),
      )
      .sort();
    const rendered = testIDsUnder(mirror)
      .filter((id) => /^journal-live-(?:bold|italic|underline)-\d+$/u.test(id))
      .sort();
    expect(rendered).toEqual(expected);
    for (const id of rendered) {
      const start = Number(id.split('-').at(-1));
      const run = buildMirrorModel(parseJournalMarkdown(body), { start: 0, end: 0 })
        .flatMap(visibleMirrorRuns)
        .find((candidate) => candidate.start === start);
      expect(renderedText(getByTestId(id))).toBe(run?.text);
    }
  });

  it('keeps a quote marker in the source and draws the line as a quote', () => {
    const onChangeBody = jest.fn();
    const { getByTestId } = render(<Harness initial="x" onChangeBody={onChangeBody} />);
    const input = getByTestId('journal-body-input');

    fireEvent.changeText(input, 'x\n> said');
    expect(onChangeBody).toHaveBeenLastCalledWith('x\n> said');
    const quote = getByTestId('journal-live-quote-2');
    expect(StyleSheet.flatten(quote.props.style).backgroundColor).toBe(colors.paper.backgroundAlt);
    expect(renderedText(getByTestId('journal-live-marker-2'))).toBe('> ');
  });

  it('dims block markers and delimiters instead of removing them', () => {
    const { getByTestId } = render(<Harness initial="- **a**" />);
    for (const id of ['journal-live-marker-0', 'journal-live-delimiter-2']) {
      const style = StyleSheet.flatten(getByTestId(id).props.style);
      expect(style.opacity).toBe(MIRROR_HIDDEN_OPACITY);
      expect(style.color).toBe(colors.paper.inkSoft);
    }
    expect(renderedText(getByTestId('journal-live-marker-0'))).toBe('- ');
  });

  it('reveals the delimiters around the caret without touching the body', () => {
    const onChangeBody = jest.fn();
    const { getByTestId } = render(<Harness initial="a **b** c" onChangeBody={onChangeBody} />);
    const input = getByTestId('journal-body-input');
    const opacity = (id: string) => StyleSheet.flatten(getByTestId(id).props.style).opacity;

    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 0, end: 0 } } });
    expect(opacity('journal-live-delimiter-2')).toBe(MIRROR_HIDDEN_OPACITY);

    for (const caret of [3, 4, 5, 6, 9]) {
      fireEvent(input, 'selectionChange', {
        nativeEvent: { selection: { start: caret, end: caret } },
      });
    }
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 4, end: 4 } } });
    expect(opacity('journal-live-delimiter-2')).toBe(1);
    expect(opacity('journal-live-delimiter-5')).toBe(1);

    expect(onChangeBody).not.toHaveBeenCalled();
    expect(getByTestId('journal-body-input').props.value).toBe('a **b** c');
  });

  it('follows a selection-handle drag that only the document selectionchange reports', () => {
    // iOS Safari fires no `select` for handle drags; the field's own
    // selection is read on the document event instead.
    (globalThis as MutableGlobal).document = new EventTarget() as unknown as Document;
    const fieldRef: React.RefObject<TextInput | null> = { current: null };
    const { getByTestId } = render(<Harness initial="a **b** c" fieldRef={fieldRef} />);
    const opacity = () =>
      StyleSheet.flatten(getByTestId('journal-live-delimiter-2').props.style).opacity;
    expect(opacity()).toBe(MIRROR_HIDDEN_OPACITY);

    (fieldRef as { current: unknown }).current = { selectionStart: 4, selectionEnd: 4 };
    act(() => {
      globalThis.document.dispatchEvent(new Event('selectionchange'));
    });
    expect(opacity()).toBe(1);
    delete (globalThis as MutableGlobal).document;
  });

  it('inserts typing inside a span at the exact source position', () => {
    const onChangeBody = jest.fn();
    const { getByTestId } = render(<Harness initial="a **bd** c" onChangeBody={onChangeBody} />);
    const input = getByTestId('journal-body-input');
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 5, end: 5 } } });
    fireEvent.changeText(input, 'a **bcd** c');
    expect(onChangeBody).toHaveBeenCalledWith('a **bcd** c');
    expect(renderedText(getByTestId('journal-live-bold-4'))).toBe('bcd');
  });

  it('hides the mirror from assistive technology and leaves the field as the one voice', () => {
    const { getByTestId, getByLabelText, queryByTestId } = render(<Harness initial="**a**" />);
    const mirror = getByTestId('journal-body-mirror');
    expect(mirror.props['aria-hidden']).toBe(true);
    expect(mirror.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(mirror.props.accessibilityElementsHidden).toBe(true);
    expect(mirror.props.pointerEvents).toBe('none');
    expect(queryByTestId('journal-body-mirror', { includeHiddenElements: false })).toBeNull();
    expect(queryByTestId('journal-live-bold-2', { includeHiddenElements: false })).toBeNull();
    expect(getByLabelText('Entry body').props.value).toBe('**a**');
  });

  it('makes only the field glyphs transparent, keeping its caret colour', () => {
    const { getByTestId } = render(<Harness initial="a" />);
    const input = getByTestId('journal-body-input');
    const style = StyleSheet.flatten(input.props.style) as Record<string, unknown>;
    expect(style.color).toBe('transparent');
    expect(style.tabSize).toBe(4);
    expect(input.props.selectionColor).toBeDefined();
  });

  it('turns the mirror off under forced colors, keeping the field glyphs visible', () => {
    (globalThis as MutableGlobal).window = {
      matchMedia: (query) => ({ matches: query === '(forced-colors: active)' }),
    };
    const { getByTestId, queryByTestId } = render(<Harness initial="**a**" />);
    expect(queryByTestId('journal-body-mirror')).toBeNull();
    expect(StyleSheet.flatten(getByTestId('journal-body-input').props.style).color).toBe(
      colors.paper.ink,
    );
  });

  it('keeps the mirror when the media query does not match', () => {
    (globalThis as MutableGlobal).window = { matchMedia: () => ({ matches: false }) };
    const { getByTestId } = render(<Harness initial="a" />);
    expect(getByTestId('journal-body-mirror')).toBeTruthy();
  });
});

describe('LiveMarkdownBody on native', () => {
  it('keeps the visible TextInput with no mirror behind it', () => {
    const { getByTestId, queryByTestId } = render(<Harness initial="**a**" />);
    expect(queryByTestId('journal-body-mirror')).toBeNull();
    expect(StyleSheet.flatten(getByTestId('journal-body-input').props.style).color).toBe(
      colors.paper.ink,
    );
  });

  it('still continues a quote on Return and exits an empty one', () => {
    const onChangeBody = jest.fn();
    const { getByTestId } = render(<Harness initial="> a" onChangeBody={onChangeBody} />);
    const input = getByTestId('journal-body-input');
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 3, end: 3 } } });
    act(() => fireEvent.changeText(input, '> a\n'));
    expect(onChangeBody).toHaveBeenLastCalledWith('> a\n> ');
    act(() => fireEvent.changeText(getByTestId('journal-body-input'), '> a\n> \n'));
    expect(onChangeBody).toHaveBeenLastCalledWith('> a\n');
  });
});
