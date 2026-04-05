/* eslint-env jest */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

import ChatInput from '../ChatInput';

describe('ChatInput', () => {
  let onSend: jest.Mock;

  beforeEach(() => {
    onSend = jest.fn();
  });

  it('renders input and send button', () => {
    const { getByTestId } = render(<ChatInput onSend={onSend} />);
    expect(getByTestId('chat-input')).toBeTruthy();
    expect(getByTestId('send-button')).toBeTruthy();
  });

  it('calls onSend with trimmed text and clears input', () => {
    const { getByTestId } = render(<ChatInput onSend={onSend} />);
    const input = getByTestId('chat-input');
    const sendBtn = getByTestId('send-button');

    fireEvent.changeText(input, '  Hello world  ');
    fireEvent.press(sendBtn);

    expect(onSend).toHaveBeenCalledWith('Hello world', undefined);
    expect(input.props.value).toBe('');
  });

  it('does not call onSend when input is empty', () => {
    const { getByTestId } = render(<ChatInput onSend={onSend} />);
    const sendBtn = getByTestId('send-button');

    fireEvent.press(sendBtn);

    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not call onSend when input is whitespace only', () => {
    const { getByTestId } = render(<ChatInput onSend={onSend} />);
    const input = getByTestId('chat-input');
    const sendBtn = getByTestId('send-button');

    fireEvent.changeText(input, '   ');
    fireEvent.press(sendBtn);

    expect(onSend).not.toHaveBeenCalled();
  });

  it('disables send button when disabled prop is true', () => {
    const { getByTestId } = render(<ChatInput onSend={onSend} disabled />);
    const sendBtn = getByTestId('send-button');

    expect(sendBtn.props.accessibilityState?.disabled).toBe(true);
  });

  it('renders tag toggle button', () => {
    const { getByTestId } = render(<ChatInput onSend={onSend} />);
    expect(getByTestId('tag-toggle')).toBeTruthy();
  });

  it('shows tag picker when tag toggle is pressed', () => {
    const { getByTestId, queryByTestId } = render(<ChatInput onSend={onSend} />);

    expect(queryByTestId('tag-picker')).toBeNull();

    fireEvent.press(getByTestId('tag-toggle'));

    expect(getByTestId('tag-picker')).toBeTruthy();
    expect(getByTestId('tag-option-is_stage_reflection')).toBeTruthy();
    expect(getByTestId('tag-option-is_practice_note')).toBeTruthy();
    expect(getByTestId('tag-option-is_habit_note')).toBeTruthy();
  });

  it('sends tags with message when tags are selected', () => {
    const { getByTestId } = render(<ChatInput onSend={onSend} />);

    // Open tag picker and select a tag
    fireEvent.press(getByTestId('tag-toggle'));
    fireEvent.press(getByTestId('tag-option-is_stage_reflection'));

    // Type and send
    fireEvent.changeText(getByTestId('chat-input'), 'Tagged message');
    fireEvent.press(getByTestId('send-button'));

    expect(onSend).toHaveBeenCalledWith('Tagged message', {
      is_stage_reflection: true,
      is_practice_note: false,
      is_habit_note: false,
    });
  });

  it('resets tags after sending', () => {
    const { getByTestId, queryByTestId } = render(<ChatInput onSend={onSend} />);

    fireEvent.press(getByTestId('tag-toggle'));
    fireEvent.press(getByTestId('tag-option-is_habit_note'));
    fireEvent.changeText(getByTestId('chat-input'), 'Test');
    fireEvent.press(getByTestId('send-button'));

    // Tag picker should be hidden after send
    expect(queryByTestId('tag-picker')).toBeNull();
  });

  it('uses initialTags when provided', () => {
    const initialTags = {
      is_stage_reflection: false,
      is_practice_note: true,
      is_habit_note: false,
    };

    const { getByTestId } = render(<ChatInput onSend={onSend} initialTags={initialTags} />);

    fireEvent.changeText(getByTestId('chat-input'), 'Practice reflection');
    fireEvent.press(getByTestId('send-button'));

    expect(onSend).toHaveBeenCalledWith('Practice reflection', {
      is_stage_reflection: false,
      is_practice_note: true,
      is_habit_note: false,
    });
  });
});
