import React from 'react';
import { Platform, Text } from 'react-native';
import type { PlatformOSType } from 'react-native';

import { accent, fonts, ink } from '@/design/tokens';

/** The stack header's title face: the editorial serif, in ink. */
export const HEADER_TITLE_STYLE = { fontFamily: fonts.serif, color: ink.primary } as const;

/**
 * The Android Toolbar's default title size, which native-stack's own custom
 * title uses too, so a header-role title reads at the size the Toolbar drew.
 */
const ANDROID_HEADER_TITLE_SIZE = 20;
const ANDROID_TITLE_STYLE = { ...HEADER_TITLE_STYLE, fontSize: ANDROID_HEADER_TITLE_SIZE } as const;

interface HeaderTitleProps {
  /** The title string native-stack resolves from ``title`` or the route name. */
  children: string;
  tintColor?: string;
}

/**
 * The stack title as a header on Android (#2962). react-native-screens builds
 * the Android header as a Toolbar whose title carries no accessibility
 * heading, so a screen that leaves its title to navigation would have none
 * there. native-stack wraps a custom title in a flex view beside the back
 * button, so one line truncates as the Toolbar's did.
 */
function AndroidHeaderTitle({ children }: HeaderTitleProps): React.JSX.Element {
  return (
    <Text accessibilityRole="header" numberOfLines={1} style={ANDROID_TITLE_STYLE}>
      {children}
    </Text>
  );
}

const renderAndroidHeaderTitle = (props: HeaderTitleProps): React.JSX.Element => (
  <AndroidHeaderTitle {...props} />
);

/**
 * Screen options for the root stack. Header background/border come from the
 * warm navTheme; here we add the editorial serif title + terracotta back/tint.
 *
 * The stack header is each screen's one title heading on every platform
 * (DESIGN.md "Navigation owns the screen title"). iOS gives the
 * UINavigationBar title the header trait and web renders it as an ``h1``, so
 * both keep native-stack's default title; only Android takes the header-role
 * ``headerTitle``.
 */
export function navScreenOptions(os: PlatformOSType) {
  return {
    headerTintColor: accent.primary,
    headerTitleStyle: HEADER_TITLE_STYLE,
    ...(os === 'android' ? { headerTitle: renderAndroidHeaderTitle } : {}),
  };
}

export const NAV_SCREEN_OPTIONS = navScreenOptions(Platform.OS);
