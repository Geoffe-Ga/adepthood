import React from 'react';
import { Switch, type SwitchProps } from 'react-native';

import { accent, surface } from '@/design/tokens';

/**
 * The one ``Switch`` every Settings row uses, so they cannot drift on colour.
 *
 * The track is the hairline when off and the accent when on; the thumb is the
 * raised paper either way. ``react-native-web`` colours the checked thumb from
 * its own ``activeThumbColor`` (a teal outside the Candle & Ink palette) unless
 * told otherwise, and that prop is not in React Native's types, so it is
 * supplied here once rather than at every call site.
 */

/** Web-only prop: the thumb colour while checked. Ignored on native. */
const WEB_THUMB_PROPS: { activeThumbColor: string } = { activeThumbColor: surface.raised };

export const SettingsSwitch = (props: SwitchProps): React.JSX.Element => (
  <Switch
    accessibilityRole="switch"
    trackColor={{ false: surface.hairline, true: accent.primary }}
    thumbColor={surface.raised}
    {...WEB_THUMB_PROPS}
    {...props}
  />
);
