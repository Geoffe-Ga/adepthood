import React from 'react';
import { View } from 'react-native';

interface TitleHostProps {
  /** The screen title the stack header already paints; the host's accessible name. */
  title: string;
  testID?: string;
}

/**
 * The in-body header for a screen whose title navigation already paints
 * (#2962): one header node, named by the title, that draws nothing.
 *
 * It is childless on purpose. An accessible View collapses its children into
 * one announcement on native, and react-native-web maps no
 * ``accessibilityHint``, so wrapping the eyebrow or lead here would hide that
 * copy from a screen reader -- on Support & care, the care line itself. The
 * text beside the host stays ordinary text that reads on its own.
 *
 * It is not a focus target: no ``tabIndex``, no ref, no focus ring. Only a
 * screen that moves focus to its heading on open needs that, and wraps its
 * lead the way the feedback composer's ``ComposerHeading`` does (#2956).
 */
export const TitleHost = ({ title, testID }: TitleHostProps): React.JSX.Element => (
  <View accessible accessibilityRole="header" accessibilityLabel={title} testID={testID} />
);
