/**
 * The body's formatting actions, for writers without a keyboard shortcut --
 * touch, and anyone who would rather press a button.
 *
 * Each action runs the same pure command the keyboard does, against the
 * field's own selection, so the toolbar and Cmd+B can never disagree about
 * what "bold" writes. Rendered on every platform in edit mode, so a phone
 * browser at 390px gets it too.
 */
import { Bold, Italic, Underline, type LucideIcon } from 'lucide-react-native';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { MarkdownCommand, MarkdownCommandState } from './markdownCommands';

import { NAV_ICON_SIZE, NAV_ICON_STROKE } from '@/components/drawer';
import { BORDER_RADIUS, SPACING, colors, touchTarget } from '@/design/tokens';

export interface MarkdownFormatToolbarProps {
  /** What is in force at the field's selection. */
  state: MarkdownCommandState;
  onCommand: (command: MarkdownCommand) => void;
}

interface ToolbarAction {
  command: MarkdownCommand;
  label: string;
  Icon: LucideIcon;
}

const STYLE_ACTIONS: readonly (ToolbarAction & { command: 'bold' | 'italic' | 'underline' })[] = [
  { command: 'bold', label: 'Bold', Icon: Bold },
  { command: 'italic', label: 'Italic', Icon: Italic },
  { command: 'underline', label: 'Underline', Icon: Underline },
];

function ToolbarButton({
  action,
  selected,
  onCommand,
}: {
  action: ToolbarAction;
  selected: boolean;
  onCommand: (command: MarkdownCommand) => void;
}): React.JSX.Element {
  const { Icon } = action;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityState={{ selected }}
      onPress={() => onCommand(action.command)}
      style={[styles.button, selected ? styles.buttonSelected : null]}
      testID={`journal-format-${action.command}`}
    >
      <Icon
        size={NAV_ICON_SIZE}
        strokeWidth={NAV_ICON_STROKE}
        color={selected ? colors.paper.ink : colors.paper.inkSoft}
        accessible={false}
      />
    </Pressable>
  );
}

export default function MarkdownFormatToolbar({
  state,
  onCommand,
}: MarkdownFormatToolbarProps): React.JSX.Element {
  return (
    <View accessibilityRole="toolbar" style={styles.toolbar} testID="journal-format-toolbar">
      {STYLE_ACTIONS.map((action) => (
        <ToolbarButton
          key={action.command}
          action={action}
          selected={state[action.command]}
          onCommand={onCommand}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
    paddingVertical: SPACING.xs,
  },
  button: {
    minWidth: touchTarget.minimum,
    minHeight: touchTarget.minimum,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: BORDER_RADIUS.md,
  },
  buttonSelected: {
    backgroundColor: colors.paper.backgroundAlt,
  },
});
