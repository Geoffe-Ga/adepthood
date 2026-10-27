import { StyleSheet } from 'react-native';

import {
  fonts,
  ink,
  rhythm,
  surface,
  touchTarget,
  type as typeRamp,
  uiType,
} from '@/design/tokens';

export function createPracticeStoryStyles(width: number) {
  const type = typeRamp(width);
  return StyleSheet.create({
    record: { marginVertical: rhythm.sectionGap, gap: rhythm.sectionGap },
    heroRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
    hero: { ...type.display, fontFamily: fonts.sans, color: ink.primary },
    caption: { ...type.caption, color: ink.muted },
    body: { ...type.body, color: ink.soft },
    section: {
      gap: rhythm.blockGap,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: surface.hairline,
      paddingTop: rhythm.blockGap,
    },
    title: { ...type.body, fontWeight: '600', color: ink.primary },
    options: {
      minHeight: touchTarget.minimum,
      minWidth: touchTarget.minimum,
      alignItems: 'center',
      justifyContent: 'center',
    },
    menu: { alignItems: 'flex-end', backgroundColor: surface.sunken },
    control: {
      minHeight: touchTarget.minimum,
      paddingHorizontal: rhythm.blockGap,
      justifyContent: 'center',
    },
    controlText: { ...uiType.button, color: ink.primary },
  });
}
export type PracticeStoryStyles = ReturnType<typeof createPracticeStoryStyles>;
