/**
 * The body's formatting actions, for writers without a keyboard shortcut --
 * touch, and anyone who would rather press a button.
 *
 * Bold, Italic, Underline, Heading, Bulleted list, Numbered list, Quote,
 * Indent and Outdent. Every action is always on show; Indent and Outdent are
 * disabled while the caret is off a bulleted item, so the bar never shifts
 * under the writer's thumb.
 * The actions sit on one line that never wraps: when they outgrow it, the
 * strip scrolls sideways -- a finger swipe on mobile, a click-and-drag (or
 * trackpad pan) on web.
 *
 * Each action runs the same pure command the keyboard does, against the
 * field's own selection, so the toolbar and Cmd+B can never disagree about
 * what "bold" writes. Rendered on every platform in edit mode, so a phone
 * browser at 390px gets it too.
 */
import {
  Bold,
  Heading,
  Italic,
  List,
  ListIndentDecrease,
  ListIndentIncrease,
  ListOrdered,
  TextQuote,
  Underline,
  type LucideIcon,
} from 'lucide-react-native';
import React, { useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type PressableProps } from 'react-native';

import type { MarkdownCommand, MarkdownCommandState } from './markdownCommands';
import { useWebDragScroll } from './webDragScroll';

import { decorativeHidden } from '@/components/a11yHidden';
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

/** The commands whose on/off state the toolbar reflects. */
type ToggleCommand = Exclude<MarkdownCommand, 'indent' | 'outdent'>;

/**
 * Inline styles, then line styles. Heading steps ``#`` to ``###`` and back to
 * prose; the others turn the touched lines into that block, or back.
 */
const STYLE_ACTIONS: readonly (ToolbarAction & { command: ToggleCommand })[] = [
  { command: 'bold', label: 'Bold', Icon: Bold },
  { command: 'italic', label: 'Italic', Icon: Italic },
  { command: 'underline', label: 'Underline', Icon: Underline },
  { command: 'heading', label: 'Heading', Icon: Heading },
  { command: 'bullet', label: 'Bulleted list', Icon: List },
  { command: 'ordered', label: 'Numbered list', Icon: ListOrdered },
  { command: 'quote', label: 'Quote', Icon: TextQuote },
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
        {...decorativeHidden()}
      />
    </Pressable>
  );
}

export default function MarkdownFormatToolbar({
  state,
  onCommand,
}: MarkdownFormatToolbarProps): React.JSX.Element {
  const scrollRef = useRef<ScrollView>(null);
  useWebDragScroll(scrollRef);
  const offList = state.listLevel == null;
  return (
    <View accessibilityRole="toolbar" style={styles.toolbar} testID="journal-format-toolbar">
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.row}
        testID="journal-format-toolbar-scroll"
      >
        {STYLE_ACTIONS.map((action) => (
          <ToolbarButton
            key={action.command}
            action={action}
            selected={state[action.command]}
            toggle
            onCommand={onCommand}
          />
        ))}
        <ToolbarButton
          action={INDENT_ACTION}
          selected={false}
          disabled={offList}
          onCommand={onCommand}
        />
        {/* No depth cap, so only outdent has a bound: level 0. */}
        <ToolbarButton
          action={OUTDENT_ACTION}
          selected={false}
          disabled={offList || state.listLevel === 0}
          onCommand={onCommand}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    paddingVertical: SPACING.xs,
  },
  /** One line, never wrapped: overflow scrolls instead. */
  row: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    gap: SPACING.xs,
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
