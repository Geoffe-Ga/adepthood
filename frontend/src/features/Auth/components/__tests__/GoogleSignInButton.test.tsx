/* eslint-env jest */
/* global describe, it, expect, jest */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Platform, StyleSheet } from 'react-native';

import {
  GOOGLE_BUTTON_LABEL,
  GOOGLE_BUTTON_STROKE_WIDTH,
  GOOGLE_BUTTON_THEMES,
  GOOGLE_BUTTON_TYPE,
  GOOGLE_LOGO_COLORS,
  googleButtonPaddingFor,
} from '../googleBranding';
import { GOOGLE_LOGO_TEST_ID, GoogleSignInButton } from '../GoogleSignInButton';

import { ThemeProvider, type ThemeMode } from '@/design/ThemeContext';

const BUTTON_ID = 'social-auth-google';
const PADDING = googleButtonPaddingFor(Platform.OS);

/**
 * The mark is deliberately hidden from assistive technology, and the library's
 * default queries skip exactly those nodes — so reaching it in a test has to opt
 * back in. Needing this option is itself part of the proof that the mark is
 * hidden.
 */
const HIDDEN = { includeHiddenElements: true } as const;

function renderButton(props: { submitting?: boolean; mode?: ThemeMode } = {}) {
  const onPress = jest.fn();
  const view = render(
    <ThemeProvider initialMode={props.mode ?? 'light'}>
      <GoogleSignInButton
        onPress={onPress}
        submitting={props.submitting ?? false}
        testID={BUTTON_ID}
      />
    </ThemeProvider>,
  );
  return { ...view, onPress };
}

/** Every string value of one prop, in render order, across the whole tree. */
function collectProp(node: unknown, key: string): string[] {
  if (Array.isArray(node)) return node.flatMap((child) => collectProp(child, key));
  if (node === null || typeof node !== 'object') return [];
  const { props, children } = node as { props?: Record<string, unknown>; children?: unknown[] };
  const value = props === undefined ? undefined : props[key];
  const own = typeof value === 'string' ? [value] : [];
  return [...own, ...collectProp(children ?? [], key)];
}

describe('GoogleSignInButton — the mandated mark', () => {
  it('draws the standard colour "G", never a monochrome or custom icon', () => {
    const { getByTestId } = renderButton();

    const fills = collectProp(getByTestId(GOOGLE_LOGO_TEST_ID, HIDDEN), 'fill');

    expect([...fills].sort()).toEqual([...GOOGLE_LOGO_COLORS].sort());
  });

  // "The Google icon alone, without the button boundary and text" is prohibited,
  // so the mark and the approved phrase must ship together.
  it('pairs the mark with the approved phrase inside one button', () => {
    const { getByTestId, getByText } = renderButton();

    expect(getByTestId(BUTTON_ID)).toBeTruthy();
    expect(getByTestId(GOOGLE_LOGO_TEST_ID, HIDDEN)).toBeTruthy();
    expect(getByText(GOOGLE_BUTTON_LABEL)).toBeTruthy();
  });

  it('puts the mark before the text', () => {
    const { toJSON } = renderButton();

    const ids = collectProp(toJSON(), 'testID');

    expect(ids.indexOf(GOOGLE_LOGO_TEST_ID)).toBeGreaterThan(-1);
    expect(ids.indexOf(GOOGLE_LOGO_TEST_ID)).toBeGreaterThan(ids.indexOf(BUTTON_ID));
  });

  // The button already carries the accessible name; a second announcement for
  // the mark would make a screen reader say "Continue with Google" twice.
  it('hides the decorative mark from assistive technology', () => {
    const { getByTestId } = renderButton();

    const logo = getByTestId(GOOGLE_LOGO_TEST_ID, HIDDEN);

    expect(logo.props.accessibilityElementsHidden).toBe(true);
    expect(logo.props.importantForAccessibility).toBe('no-hide-descendants');
  });
});

describe('GoogleSignInButton — the approved themes', () => {
  const CASES: Array<[ThemeMode]> = [['light'], ['dark']];

  it.each(CASES)('fills and strokes exactly per the %s theme', (mode) => {
    const { getByTestId } = renderButton({ mode });
    const theme = GOOGLE_BUTTON_THEMES[mode];

    const style = StyleSheet.flatten(getByTestId(BUTTON_ID).props.style);

    expect(style.backgroundColor).toBe(theme.fill);
    expect(style.borderColor).toBe(theme.stroke);
    expect(style.borderWidth).toBe(GOOGLE_BUTTON_STROKE_WIDTH);
  });

  it.each(CASES)('inks the label with the %s theme text colour', (mode) => {
    const { getByText } = renderButton({ mode });

    const style = StyleSheet.flatten(getByText(GOOGLE_BUTTON_LABEL).props.style);

    expect(style.color).toBe(GOOGLE_BUTTON_THEMES[mode].text);
  });

  it('sets the mandated 14/20 type on the label', () => {
    const { getByText } = renderButton();

    const style = StyleSheet.flatten(getByText(GOOGLE_BUTTON_LABEL).props.style);

    expect(style.fontSize).toBe(GOOGLE_BUTTON_TYPE.fontSize);
    expect(style.lineHeight).toBe(GOOGLE_BUTTON_TYPE.lineHeight);
  });
});

describe('GoogleSignInButton — the mandated padding', () => {
  it('pads before the mark and after the text per the platform table', () => {
    const { getByTestId } = renderButton();

    const style = StyleSheet.flatten(getByTestId(BUTTON_ID).props.style);

    // Zeroed so the two edge values are unambiguous rather than layered over
    // the design system's symmetric padding.
    expect(style.paddingHorizontal).toBe(0);
    expect(style.paddingLeft).toBe(PADDING.beforeLogo);
    expect(style.paddingRight).toBe(PADDING.afterText);
  });

  it('gaps the mark from the text per the platform table', () => {
    const { getByTestId } = renderButton();

    const style = StyleSheet.flatten(getByTestId(GOOGLE_LOGO_TEST_ID, HIDDEN).props.style);

    expect(style.marginRight).toBe(PADDING.afterLogo);
  });
});

describe('GoogleSignInButton — behaviour', () => {
  it('keeps the accessible name and the testID the auth wiring depends on', () => {
    const { getByLabelText, getByTestId } = renderButton();

    expect(getByLabelText(GOOGLE_BUTTON_LABEL)).toBeTruthy();
    expect(getByTestId(BUTTON_ID).props.accessibilityLabel).toBe(GOOGLE_BUTTON_LABEL);
  });

  it('fires onPress while idle', () => {
    const { getByTestId, onPress } = renderButton();

    fireEvent.press(getByTestId(BUTTON_ID));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  // Only three strings are permitted on this button, and "Connecting..." is not
  // one of them: the in-flight cue has to be carried by state, not by swapping
  // the text out from under Google's guideline.
  it('keeps the approved phrase and the mark in place while submitting', () => {
    const { getByTestId, getByText, queryByText } = renderButton({ submitting: true });

    expect(getByText(GOOGLE_BUTTON_LABEL)).toBeTruthy();
    expect(getByTestId(GOOGLE_LOGO_TEST_ID, HIDDEN)).toBeTruthy();
    expect(queryByText('Connecting...')).toBeNull();
  });

  it('announces the in-flight state instead, and swallows the press', () => {
    const { getByTestId, onPress } = renderButton({ submitting: true });

    fireEvent.press(getByTestId(BUTTON_ID));

    expect(onPress).not.toHaveBeenCalled();
    expect(getByTestId(BUTTON_ID).props.accessibilityState).toMatchObject({ busy: true });
  });
});
