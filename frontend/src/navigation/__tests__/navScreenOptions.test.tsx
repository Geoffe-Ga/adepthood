import { describe, expect, it, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import type { PlatformOSType } from 'react-native';

import { HEADER_TITLE_STYLE, navScreenOptions } from '../navScreenOptions';

/**
 * The stack header is each screen's one title heading on every platform
 * (#2962). iOS gives the UINavigationBar title the header trait and web renders
 * it as an h1, so both keep native-stack's default title. Android's Toolbar
 * title carries no heading, so there the title is rendered as a header-role
 * Text in the same face.
 */

type TitleRenderer = (props: { children: string; tintColor?: string }) => React.ReactNode;

function titleRenderer(os: PlatformOSType): TitleRenderer | undefined {
  return (navScreenOptions(os) as { headerTitle?: TitleRenderer }).headerTitle;
}

describe('navScreenOptions', () => {
  it('renders the Android title as one header named by the title, in the header face', () => {
    const headerTitle = titleRenderer('android');
    expect(typeof headerTitle).toBe('function');
    const { getAllByRole } = render(
      <>{headerTitle?.({ children: 'Settings', tintColor: '#123456' })}</>,
    );
    const headers = getAllByRole('header');
    expect(headers).toHaveLength(1);
    const [title] = headers;
    expect(title?.props.accessibilityRole).toBe('header');
    expect(title?.props.children).toBe('Settings');
    expect(title?.props.numberOfLines).toBe(1);
    const style = StyleSheet.flatten(title?.props.style);
    expect(style.fontFamily).toBe(HEADER_TITLE_STYLE.fontFamily);
    expect(style.color).toBe(HEADER_TITLE_STYLE.color);
  });

  it.each(['ios', 'web'] as const)('keeps the default title on %s', (os) => {
    expect(titleRenderer(os)).toBeUndefined();
    expect(navScreenOptions(os).headerTitleStyle).toBe(HEADER_TITLE_STYLE);
  });

  it('wires the running platform into the options the stack uses', () => {
    jest.isolateModules(() => {
      const rn = require('react-native') as { Platform: { OS: PlatformOSType } };
      const original = rn.Platform.OS;
      Object.defineProperty(rn.Platform, 'OS', { value: 'android', configurable: true });
      try {
        const { NAV_SCREEN_OPTIONS } = require('../navScreenOptions') as {
          NAV_SCREEN_OPTIONS: { headerTitle?: unknown };
        };
        expect(typeof NAV_SCREEN_OPTIONS.headerTitle).toBe('function');
      } finally {
        Object.defineProperty(rn.Platform, 'OS', { value: original, configurable: true });
      }
    });
  });
});
