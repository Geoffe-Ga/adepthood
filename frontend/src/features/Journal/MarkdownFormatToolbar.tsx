/**
 * The body's formatting actions, for writers without a keyboard shortcut --
 * touch, and anyone who would rather press a button.
 *
 * Indent and Outdent appear only while the caret is on a list item.
 *
 * Each action runs the same pure command the keyboard does, against the
 * field's own selection, so the toolbar and Cmd+B can never disagree about
 * what "bold" writes. Rendered on every platform in edit mode, so a phone
 * browser at 390px gets it too.
 */
import {
  Bold,
  Italic,
  ListIndentDecrease,
  ListIndentIncrease,
  Underline,
  type LucideIcon,
} from 'lucide-react-native';
import React from 'react';
import { Pressable, StyleSheet, View, type PressableProps } from 'react-native';

import type { MarkdownCommand, MarkdownCommandState } from './markdownCommands';

import { NAV_ICON_SIZE, NAV_ICON_STROKE } from '@/components/drawer';
import { webPressedState } from '@/components/webAria';
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

const INDENT_ACTION: ToolbarAction = {
  command: 'indent',
  label: 'Indent list item',
  Icon: ListIndentIncrease,
};
const OUTDENT_ACTION: ToolbarAction = {
  command: 'outdent',
  label: 'Outdent list item',
  Icon: ListIndentDecrease,
};

/** Height of the bar under a pressed toggle -- its non-colour, 3:1-contrast state cue. */
const PRESSED_BAR_WIDTH = 2;

/** How far an unavailable action fades, matching the shared Button's disabled state. */
const DISABLED_ACTION_OPACITY = 0.5;

function ToolbarButton({
  action,
  selected,
  toggle = false,
  disabled = false,
  onCommand,
}: {
  action: ToolbarAction;
  selected: boolean;
  /** A style toggle, whose on/off state web assistive technology reads as aria-pressed. */
  toggle?: boolean;
  disabled?: boolean;
  onCommand: (command: MarkdownCommand) => void;
}): React.JSX.Element {
  const { Icon } = action;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={() => onCommand(action.command)}
      style={[
        styles.button,
        selected ? styles.buttonSelected : null,
        disabled ? styles.buttonDisabled : null,
      ]}
      testID={`journal-format-${action.command}`}
      {...(toggle ? webPressedState<PressableProps>(selected) : {})}
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
          toggle
          onCommand={onCommand}
        />
      ))}
      {state.listLevel == null ? null : (
        <>
          <ToolbarButton action={INDENT_ACTION} selected={false} onCommand={onCommand} />
          {/* No depth cap, so only outdent has a bound: level 0. */}
          <ToolbarButton
            action={OUTDENT_ACTION}
            selected={false}
            disabled={state.listLevel === 0}
            onCommand={onCommand}
          />
        </>
      )}
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
    borderBottomWidth: PRESSED_BAR_WIDTH,
    borderBottomColor: 'transparent',
  },
  buttonSelected: {
    backgroundColor: colors.paper.backgroundAlt,
    borderBottomColor: colors.paper.ink,
  },
  buttonDisabled: {
    opacity: DISABLED_ACTION_OPACITY,
  },
});
