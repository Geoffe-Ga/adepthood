/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';
import React from 'react';
import renderer from 'react-test-renderer';

import type { JournalMessage } from '../../../api';
import MessageBubble from '../MessageBubble';

interface TextInstance {
  props: { children: unknown };
}

const makeMessage = (overrides: Partial<JournalMessage> = {}): JournalMessage => ({
  id: 1,
  message: 'Hello world',
  sender: 'user',
  user_id: 1,
  timestamp: '2026-01-15T10:30:00Z',
  tag: 'freeform',
  practice_session_id: null,
  user_practice_id: null,
  ...overrides,
});

describe('MessageBubble', () => {
  it('renders user message text', () => {
    const tree = renderer.create(<MessageBubble message={makeMessage()} />);
    const root = tree.root;
    const texts = root.findAllByType('Text') as TextInstance[];
    const messageText = texts.find((t) => t.props.children === 'Hello world');
    expect(messageText).toBeTruthy();
  });

  it('renders bot message with avatar', () => {
    const msg = makeMessage({ sender: 'bot', message: 'I am BotMason' });
    const tree = renderer.create(<MessageBubble message={msg} />);
    const root = tree.root;
    const texts = root.findAllByType('Text') as TextInstance[];
    const avatarText = texts.find((t) => t.props.children === 'B');
    expect(avatarText).toBeTruthy();
    const botText = texts.find((t) => t.props.children === 'I am BotMason');
    expect(botText).toBeTruthy();
  });

  it('does not render avatar for user messages', () => {
    const tree = renderer.create(<MessageBubble message={makeMessage()} />);
    const root = tree.root;
    const texts = root.findAllByType('Text') as TextInstance[];
    const avatarText = texts.find((t) => t.props.children === 'B');
    expect(avatarText).toBeUndefined();
  });

  it('displays tag badge when tag is set', () => {
    const msg = makeMessage({ tag: 'stage_reflection' });
    const tree = renderer.create(<MessageBubble message={msg} />);
    const root = tree.root;
    const texts = root.findAllByType('Text') as TextInstance[];
    const reflectionTag = texts.find((t) => t.props.children === 'Reflection');
    expect(reflectionTag).toBeTruthy();
  });

  it('displays practice tag badge', () => {
    const msg = makeMessage({ tag: 'practice_note' });
    const tree = renderer.create(<MessageBubble message={msg} />);
    const root = tree.root;
    const texts = root.findAllByType('Text') as TextInstance[];
    const practiceTag = texts.find((t) => t.props.children === 'Practice');
    expect(practiceTag).toBeTruthy();
  });

  it('does not display tag badge for freeform entries', () => {
    const tree = renderer.create(<MessageBubble message={makeMessage()} />);
    const root = tree.root;
    const texts = root.findAllByType('Text') as TextInstance[];
    const tagTexts = texts.filter((t) =>
      ['Reflection', 'Practice', 'Habit'].includes(t.props.children as string),
    );
    expect(tagTexts).toHaveLength(0);
  });

  it('displays Practice Session badge when practice_session_id is set', () => {
    const msg = makeMessage({ practice_session_id: 42, user_practice_id: 10 });
    const tree = renderer.create(<MessageBubble message={msg} />);
    const root = tree.root;
    const texts = root.findAllByType('Text') as TextInstance[];
    const badge = texts.find((t) => t.props.children === 'Practice Session');
    expect(badge).toBeTruthy();
  });

  it('does not display Practice Session badge when practice_session_id is null', () => {
    const tree = renderer.create(<MessageBubble message={makeMessage()} />);
    const root = tree.root;
    const texts = root.findAllByType('Text') as TextInstance[];
    const badge = texts.find((t) => t.props.children === 'Practice Session');
    expect(badge).toBeUndefined();
  });

  it('displays formatted timestamp', () => {
    const tree = renderer.create(<MessageBubble message={makeMessage()} />);
    const root = tree.root;
    const texts = root.findAllByType('Text') as TextInstance[];
    const timestampTexts = texts.filter((t) => {
      const content = t.props.children;
      return typeof content === 'string' && /\d{1,2}:\d{2}/.test(content);
    });
    expect(timestampTexts.length).toBeGreaterThan(0);
  });
});
