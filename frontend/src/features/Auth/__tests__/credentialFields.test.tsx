/* eslint-env jest */
/* global describe, it, expect, jest */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import { EmailField } from '@/features/Auth/components/EmailField';
import { PasswordField } from '@/features/Auth/components/PasswordField';

describe('EmailField', () => {
  it('renders with the email keyboard/capitalisation props', () => {
    const { getByTestId } = render(<EmailField testID="email" value="" onChangeText={jest.fn()} />);
    const input = getByTestId('email');
    expect(input.props.placeholder).toBe('Email');
    expect(input.props.keyboardType).toBe('email-address');
    expect(input.props.autoCapitalize).toBe('none');
  });

  it('forwards onChangeText', () => {
    const onChangeText = jest.fn();
    const { getByTestId } = render(
      <EmailField testID="email" value="" onChangeText={onChangeText} />,
    );
    fireEvent.changeText(getByTestId('email'), 'user@test.com');
    expect(onChangeText).toHaveBeenCalledWith('user@test.com');
  });
});

describe('PasswordField', () => {
  it('renders masked with the password props', () => {
    const { getByTestId } = render(<PasswordField testID="pw" value="" onChangeText={jest.fn()} />);
    const input = getByTestId('pw');
    expect(input.props.secureTextEntry).toBe(true);
    expect(input.props.placeholder).toBe('Password');
  });

  it('lets callers override the placeholder and forwards onChangeText', () => {
    const onChangeText = jest.fn();
    const { getByTestId } = render(
      <PasswordField
        testID="pw"
        placeholder="Confirm Password"
        value=""
        onChangeText={onChangeText}
      />,
    );
    const input = getByTestId('pw');
    expect(input.props.placeholder).toBe('Confirm Password');
    fireEvent.changeText(input, 'secret'); // pragma: allowlist secret
    expect(onChangeText).toHaveBeenCalledWith('secret'); // pragma: allowlist secret
  });
});
