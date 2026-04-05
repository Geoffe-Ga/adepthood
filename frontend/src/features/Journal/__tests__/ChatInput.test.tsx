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

    expect(onSend).toHaveBeenCalledWith('Hello world');
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
});
