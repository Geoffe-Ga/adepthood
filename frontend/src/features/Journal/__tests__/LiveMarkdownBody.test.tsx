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
    // Over the field, so its selection highlight and caret paint beneath the glyphs.
    expect(StyleSheet.flatten(mirror.props.style)).toMatchObject({
      position: 'absolute',
      zIndex: 1,
    });
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

/** A keydown as react-native-web hands it to onKeyPress. */
function keyPress(key: string, modifiers: Record<string, boolean | number> = {}) {
  const preventDefault = jest.fn();
  return { event: { nativeEvent: { key, ...modifiers }, preventDefault }, preventDefault };
}

function select(input: RenderedNode, start: number, end = start) {
  fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start, end } } });
}

describe('LiveMarkdownBody keyboard commands', () => {
  let originalOS: string;
  let originalNavigator: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalOS = Platform.OS;
    Platform.OS = 'web';
    originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      value: { platform: 'Linux x86_64', userAgent: 'X11; Linux' },
      configurable: true,
    });
  });
  afterEach(() => {
    Platform.OS = originalOS;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    delete (globalThis as MutableGlobal).document;
  });

  it.each([
    ['b', 'a **word**', { start: 4, end: 8 }],
    ['i', 'a _word_', { start: 3, end: 7 }],
    ['u', 'a <u>word</u>', { start: 5, end: 9 }],
  ])('Ctrl+%s wraps the selection and claims the key', (key, expected, selection) => {
    const onChangeBody = jest.fn();
    const { getByTestId } = render(<Harness initial="a word" onChangeBody={onChangeBody} />);
    const input = getByTestId('journal-body-input');
    select(input, 2, 6);
    const { event, preventDefault } = keyPress(key, { ctrlKey: true });

    fireEvent(input, 'keyPress', event);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onChangeBody).toHaveBeenCalledWith(expected);
    expect(getByTestId('journal-body-input').props.selection).toEqual(selection);
  });

  it('toggles the same span back off on a second press', () => {
    const onChangeBody = jest.fn();
    const { getByTestId } = render(<Harness initial="a word" onChangeBody={onChangeBody} />);
    select(getByTestId('journal-body-input'), 2, 6);
    fireEvent(
      getByTestId('journal-body-input'),
      'keyPress',
      keyPress('b', { ctrlKey: true }).event,
    );
    fireEvent(
      getByTestId('journal-body-input'),
      'keyPress',
      keyPress('b', { ctrlKey: true }).event,
    );
    expect(onChangeBody).toHaveBeenLastCalledWith('a word');
  });

  it('uses Command, not Control, on an Apple browser', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { platform: 'MacIntel' },
      configurable: true,
    });
    const onChangeBody = jest.fn();
    const { getByTestId } = render(<Harness initial="a word" onChangeBody={onChangeBody} />);
    const input = getByTestId('journal-body-input');
    select(input, 2, 6);
    const control = keyPress('b', { ctrlKey: true });
    fireEvent(input, 'keyPress', control.event);
    expect(control.preventDefault).not.toHaveBeenCalled();
    fireEvent(input, 'keyPress', keyPress('b', { metaKey: true }).event);
    expect(onChangeBody).toHaveBeenCalledWith('a **word**');
  });

  it.each([
    ['an active composition', { ctrlKey: true, isComposing: true }],
    ['the IME keyCode', { ctrlKey: true, keyCode: 229 }],
    ['Alt', { ctrlKey: true, altKey: true }],
  ])('leaves Ctrl+B alone during %s', (_label, modifiers) => {
    const onChangeBody = jest.fn();
    const { getByTestId } = render(<Harness initial="a word" onChangeBody={onChangeBody} />);
    select(getByTestId('journal-body-input'), 2, 6);
    const { event, preventDefault } = keyPress('b', modifiers);
    fireEvent(getByTestId('journal-body-input'), 'keyPress', event);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onChangeBody).not.toHaveBeenCalled();
  });

  it('leaves ordinary typing alone', () => {
    const { getByTestId } = render(<Harness initial="a" />);
    const { event, preventDefault } = keyPress('b');
    fireEvent(getByTestId('journal-body-input'), 'keyPress', event);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('claims a shortcut it cannot apply without changing the body', () => {
    const onChangeBody = jest.fn();
    const { getByTestId } = render(<Harness initial="forward" onChangeBody={onChangeBody} />);
    select(getByTestId('journal-body-input'), 3);
    const { event, preventDefault } = keyPress('i', { ctrlKey: true });
    fireEvent(getByTestId('journal-body-input'), 'keyPress', event);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onChangeBody).not.toHaveBeenCalled();
  });

  it('opens an empty pair at a collapsed caret, with the caret inside it', () => {
    const onChangeBody = jest.fn();
    const { getByTestId } = render(<Harness initial="say " onChangeBody={onChangeBody} />);
    select(getByTestId('journal-body-input'), 4);
    fireEvent(
      getByTestId('journal-body-input'),
      'keyPress',
      keyPress('b', { ctrlKey: true }).event,
    );
    expect(onChangeBody).toHaveBeenCalledWith('say ****');
    expect(getByTestId('journal-body-input').props.selection).toEqual({ start: 6, end: 6 });
  });

  it('applies the command through the browser when it can, for native undo', () => {
    const execCommand = jest.fn(() => {
      node.value = 'a **word**';
      return true;
    });
    const node = { value: 'a word', setSelectionRange: jest.fn() };
    (globalThis as MutableGlobal).document = Object.assign(new EventTarget(), {
      execCommand,
    }) as unknown as Document;
    const fieldRef: React.RefObject<TextInput | null> = { current: null };
    const onChangeBody = jest.fn();
    const { getByTestId } = render(
      <Harness initial="a word" onChangeBody={onChangeBody} fieldRef={fieldRef} />,
    );
    (fieldRef as { current: unknown }).current = node;
    select(getByTestId('journal-body-input'), 2, 6);
    fireEvent(
      getByTestId('journal-body-input'),
      'keyPress',
      keyPress('b', { ctrlKey: true }).event,
    );

    expect(execCommand).toHaveBeenCalledWith('insertText', false, '**word**');
    expect(node.setSelectionRange).toHaveBeenLastCalledWith(4, 8);
    // The browser's own input event carries the text; the controlled fallback stays out.
    expect(onChangeBody).not.toHaveBeenCalled();
  });

  it('passes the input event a browser command fires straight through', () => {
    // A command that inserts exactly one line feed must not be re-read as a
    // Return and continued as a list item.
    const onChangeBody = jest.fn();
    const fieldRef: React.RefObject<TextInput | null> = { current: null };
    const { getByTestId } = render(
      <Harness initial="- a" onChangeBody={onChangeBody} fieldRef={fieldRef} />,
    );
    const input = getByTestId('journal-body-input');
    const node = { value: '- a', setSelectionRange: jest.fn() };
    (globalThis as MutableGlobal).document = {
      execCommand: jest.fn(() => {
        node.value = '- <u>a</u>';
        fireEvent.changeText(input, '- <u>a</u>');
        return true;
      }),
    } as unknown as Document;
    (fieldRef as { current: unknown }).current = node;
    select(input, 2, 3);
    fireEvent(input, 'keyPress', keyPress('u', { ctrlKey: true }).event);
    expect(onChangeBody).toHaveBeenCalledWith('- <u>a</u>');
  });
});

describe('LiveMarkdownBody formatting toolbar', () => {
  it('applies a toolbar action at the field selection and returns focus to the field', () => {
    const onChangeBody = jest.fn();
    const focus = jest.fn();
    const fieldRef: React.RefObject<TextInput | null> = { current: null };
    const { getByTestId, getByRole } = render(
      <Harness initial="a word" onChangeBody={onChangeBody} fieldRef={fieldRef} />,
    );
    (fieldRef as { current: unknown }).current = { focus };
    select(getByTestId('journal-body-input'), 2, 6);

    fireEvent.press(getByRole('button', { name: 'Underline' }));

    expect(focus).toHaveBeenCalledTimes(1);
    expect(onChangeBody).toHaveBeenCalledWith('a <u>word</u>');
  });

  it('shows the style at the caret as the pressed action', () => {
    const { getByTestId } = render(<Harness initial="**a** b" />);
    const input = getByTestId('journal-body-input');
    const selected = (style: string) =>
      getByTestId(`journal-format-${style}`).props.accessibilityState.selected;

    select(input, 3);
    expect(selected('bold')).toBe(true);
    expect(selected('italic')).toBe(false);
    select(input, 7);
    expect(selected('bold')).toBe(false);
  });

  it('does nothing to the body for an action the dialect cannot apply', () => {
    const onChangeBody = jest.fn();
    const { getByTestId, getByRole } = render(
      <Harness initial="forward" onChangeBody={onChangeBody} />,
    );
    select(getByTestId('journal-body-input'), 3);
    fireEvent.press(getByRole('button', { name: 'Italic' }));
    expect(onChangeBody).not.toHaveBeenCalled();
  });
});

describe('LiveMarkdownBody Backspace on list items', () => {
  it('outdents a nested item when Backspace removes its separator', () => {
    const onChangeBody = jest.fn();
    const { getByTestId } = render(<Harness initial={'- a\n  - b'} onChangeBody={onChangeBody} />);
    const input = getByTestId('journal-body-input');
    select(input, 8);
    fireEvent(input, 'keyPress', keyPress('Backspace').event);
    fireEvent.changeText(input, '- a\n  -b');
    expect(onChangeBody).toHaveBeenLastCalledWith('- a\n- b');
    expect(getByTestId('journal-body-input').props.selection).toEqual({ start: 6, end: 6 });
  });

  it('removes a level-0 prefix outright', () => {
    const onChangeBody = jest.fn();
    const { getByTestId } = render(<Harness initial="- one" onChangeBody={onChangeBody} />);
    const input = getByTestId('journal-body-input');
    select(input, 2);
    fireEvent.changeText(input, '-one');
    expect(onChangeBody).toHaveBeenLastCalledWith('one');
  });

  it('keeps a forward Delete exactly as the field reported it', () => {
    const onChangeBody = jest.fn();
    const { getByTestId } = render(<Harness initial="-  x" onChangeBody={onChangeBody} />);
    const input = getByTestId('journal-body-input');
    select(input, 2);
    fireEvent(input, 'keyPress', keyPress('Delete').event);
    fireEvent.changeText(input, '- x');
    expect(onChangeBody).toHaveBeenLastCalledWith('- x');
  });

  it('leaves ordinary deletion mid-item to the field', () => {
    const onChangeBody = jest.fn();
    const { getByTestId } = render(<Harness initial="- one" onChangeBody={onChangeBody} />);
    const input = getByTestId('journal-body-input');
    select(input, 4);
    fireEvent.changeText(input, '- oe');
    expect(onChangeBody).toHaveBeenLastCalledWith('- oe');
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
