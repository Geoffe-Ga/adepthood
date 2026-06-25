// Render-isolation guard for issue #471. MessageBubble is a hookless leaf in a
// long inverted FlatList, so the deterministic proof that "unchanged bubbles do
// not re-render" is its React.memo comparator: React skips re-rendering a memo
// component exactly when the comparator returns true. We assert the memo wiring,
// exhaustively check the comparator's bail/re-render decisions, and simulate a
// single-message append to show every existing bubble bails (zero re-renders).
import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';

import type { JournalTag } from '../../../api';
import MessageBubble, { type ChatMessage, messageBubblePropsAreEqual } from '../MessageBubble';

interface BubbleProps {
  message: ChatMessage;
  errorLabel?: string;
  onRetry?: () => void;
}

function makeMessage(id: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    message: `message ${id}`,
    sender: 'bot',
    timestamp: '2026-06-24T10:00:00.000Z',
    tag: 'freeform' as JournalTag,
    practice_session_id: null,
    user_practice_id: null,
    ...overrides,
  };
}

function propsFor(message: ChatMessage, overrides: Partial<BubbleProps> = {}): BubbleProps {
  return { message, onRetry: () => {}, ...overrides };
}

describe('MessageBubble is memoized', () => {
  it('wraps the component in React.memo with the custom comparator', () => {
    const memoized = MessageBubble as unknown as { compare: unknown; $$typeof: symbol };
    expect(memoized.compare).toBe(messageBubblePropsAreEqual);
    expect(memoized.$$typeof).toBe(Symbol.for('react.memo'));
  });

  it('renders its message content (visual output unchanged)', () => {
    const { getByText } = render(<MessageBubble message={makeMessage(1, { message: 'hello' })} />);
    expect(getByText('hello')).toBeTruthy();
  });
});

describe('messageBubblePropsAreEqual', () => {
  it('bails (returns true) when content is identical across new object refs', () => {
    const a = propsFor(makeMessage(1));
    const b = propsFor(makeMessage(1)); // distinct object, same content
    expect(messageBubblePropsAreEqual(a, b)).toBe(true);
  });

  it('ignores onRetry identity — a fresh closure must not force a re-render', () => {
    const message = makeMessage(1, { _errored: true });
    const a = propsFor(message, { onRetry: () => {}, errorLabel: 'Failed' });
    const b = propsFor(message, { onRetry: () => {}, errorLabel: 'Failed' });
    expect(messageBubblePropsAreEqual(a, b)).toBe(true);
  });

  it.each([
    ['message text', makeMessage(1, { message: 'changed' })],
    ['streaming flag', makeMessage(1, { _streaming: true })],
    ['errored flag', makeMessage(1, { _errored: true })],
    ['timestamp', makeMessage(1, { timestamp: '2026-06-24T11:11:11.000Z' })],
    ['tag', makeMessage(1, { tag: 'reflection' as JournalTag })],
    ['sender', makeMessage(1, { sender: 'user' })],
    ['practice badge', makeMessage(1, { practice_session_id: 7 })],
  ])('re-renders (returns false) when %s changes', (_label, changed) => {
    expect(messageBubblePropsAreEqual(propsFor(makeMessage(1)), propsFor(changed))).toBe(false);
  });

  it('re-renders when the error label changes', () => {
    const message = makeMessage(1, { _errored: true });
    const a = propsFor(message, { errorLabel: 'Network error' });
    const b = propsFor(message, { errorLabel: 'Timed out' });
    expect(messageBubblePropsAreEqual(a, b)).toBe(false);
  });

  it('appending one message re-renders zero existing bubbles', () => {
    // A conversation of three bubbles; the list re-renders to prepend a new
    // message. Each existing bubble receives the same content it had before, so
    // the comparator bails for all of them — only the new bubble renders.
    const existing = [makeMessage(1), makeMessage(2), makeMessage(3)];
    const reRendered = existing
      .map((message, index) => {
        const before = propsFor(message);
        // The list rebuilds props (new onRetry closure) but identical content.
        const after = propsFor(makeMessage(message.id as number), { onRetry: () => {} });
        return messageBubblePropsAreEqual(before, after) ? null : index;
      })
      .filter((index) => index !== null);

    expect(reRendered).toEqual([]);
  });
});
