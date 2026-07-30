/* eslint-env jest */
/* global jest */
// ``expo-apple-authentication`` ships untranspiled ESM and is not covered by
// the preset's transformIgnorePatterns allowlist, so Jest cannot parse the real
// module. Tests that care about the flow override the async members with
// jest.mock; component tests render against the button stub below.
const React = require('react');
const { Pressable } = require('react-native');

// The real button is a native view whose text and colour scheme are chosen by
// UIKit from these props. Keeping them readable on the rendered node is the
// only way a test can assert which variant was asked for.
const AppleAuthenticationButton = (props) =>
  React.createElement(Pressable, {
    accessibilityLabel: props.accessibilityLabel,
    accessibilityRole: 'button',
    buttonStyle: props.buttonStyle,
    buttonType: props.buttonType,
    cornerRadius: props.cornerRadius,
    onPress: props.onPress,
    style: props.style,
    testID: props.testID,
  });

module.exports = {
  isAvailableAsync: jest.fn(() => Promise.resolve(false)),
  signInAsync: jest.fn(),
  AppleAuthenticationButton,
  AppleAuthenticationScope: Object.freeze({ FULL_NAME: 0, EMAIL: 1 }),
  AppleAuthenticationButtonType: Object.freeze({ SIGN_IN: 0, CONTINUE: 1, SIGN_UP: 2 }),
  AppleAuthenticationButtonStyle: Object.freeze({ WHITE: 0, WHITE_OUTLINE: 1, BLACK: 2 }),
  AppleAuthenticationUserDetectionStatus: Object.freeze({
    UNSUPPORTED: 0,
    UNKNOWN: 1,
    LIKELY_REAL: 2,
  }),
};
