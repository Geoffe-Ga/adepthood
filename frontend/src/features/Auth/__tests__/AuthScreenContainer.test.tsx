/* eslint-env jest */
/* global describe, it, expect */
import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';

import { AuthScreenContainer } from '../AuthScreenContainer';

describe('AuthScreenContainer', () => {
  it('centres fitting auth content inside a flex-growing scroll surface', () => {
    const screen = render(
      <AuthScreenContainer testID="auth-fit">
        <Text>Short form</Text>
      </AuthScreenContainer>,
    );

    const scroll = screen.getByTestId('auth-fit-scroll');

    expect(StyleSheet.flatten(scroll.props.contentContainerStyle)).toMatchObject({
      flexGrow: 1,
      justifyContent: 'center',
    });
  });

  it('keeps overflowing auth content and controls inside an enabled scroll surface', () => {
    const screen = render(
      <AuthScreenContainer testID="auth-overflow">
        {Array.from({ length: 40 }, (_, index) => (
          <Text key={index}>
            {index === 39 ? 'Last reachable control' : `Long form row ${index}`}
          </Text>
        ))}
      </AuthScreenContainer>,
    );

    const scroll = screen.getByTestId('auth-overflow-scroll');

    expect(scroll.props.scrollEnabled).not.toBe(false);
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
    expect(screen.getByText('Last reachable control')).toBeTruthy();
  });
});
