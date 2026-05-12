/**
 * `InsightCaptureModal` — post-session prompt for a short one-line insight.
 *
 * Lifts out of the parent screen (ritual-11's `PracticeScreen`) every time
 * the ritual engine emits ``complete``. Three buttons:
 *
 *   - **Save**: POST the session row with the typed insight attached and
 *     dismiss.
 *   - **Save & journal with BotMason** (when ``onJournal`` is wired): POST
 *     then hand off to the Journal tab with ``practiceSessionId`` so
 *     BotMason has context. Hidden when the parent does not wire the
 *     handler (precedent: `PracticeSwitcherSheet.onSubmitOwn`).
 *   - **Skip**: POST the session row *without* an insight. Analytics still
 *     need the row; only the free-text field is omitted.
 *
 * Caps mirror the backend ``PRACTICE_INSIGHT_MAX_LENGTH`` constant
 * (see :mod:`backend.src.schemas.practice`). Crossing the soft cap shows a
 * gentle nudge; crossing the hard cap disables Save / Journal but keeps
 * Skip enabled so the user can still close the prompt without losing the
 * analytics row.
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  formatModeSummary,
  type ModeSummaryKind,
  type ModeSummaryMetadata,
} from '../insights/format';

import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';

/** Soft cap — the modal nudges the user toward a single sentence past this. */
export const PRACTICE_INSIGHT_SOFT_CAP = 200;
/** Hard cap — matches `backend.src.schemas.practice.PRACTICE_INSIGHT_MAX_LENGTH`. */
export const PRACTICE_INSIGHT_HARD_CAP = 2_000;

export interface InsightCaptureModalProps {
  /** Visibility flag — parent owns mount state so the engine can re-show on retry. */
  visible: boolean;
  /** Mode discriminator (must match ``modeMetadata.mode`` at the type level). */
  mode: ModeSummaryKind;
  /** Server-derived duration in minutes (fractional allowed). */
  durationMinutes: number;
  /** Per-mode session metadata for the summary line; see ``insights/format.ts``. */
  modeMetadata: ModeSummaryMetadata;
  /** Called with the trimmed insight string when Save is tapped. */
  onSave: (_insight: string) => void;
  /** Called with no args when Skip is tapped — the session is still POSTed by the parent. */
  onSkip: () => void;
  /**
   * Optional Journal hand-off. When wired, the modal renders the
   * "Save & journal with BotMason" CTA; when absent, the CTA is hidden so
   * the modal can ship before the journal-link plumbing is merged.
   */
  onJournal?: (_insight: string) => void;
}

interface ValidationResult {
  trimmed: string;
  withinSoftCap: boolean;
  withinHardCap: boolean;
}

function validate(input: string): ValidationResult {
  const trimmed = input.trim();
  return {
    trimmed,
    withinSoftCap: input.length <= PRACTICE_INSIGHT_SOFT_CAP,
    withinHardCap: input.length <= PRACTICE_INSIGHT_HARD_CAP,
  };
}

interface SummaryBlockProps {
  mode: ModeSummaryKind;
  durationMinutes: number;
  metadata: ModeSummaryMetadata;
}

function SummaryBlock({ mode, durationMinutes, metadata }: SummaryBlockProps) {
  // formatModeSummary narrows its `metadata` arg via the generic — the cast
  // is needed because the props type pairs ``mode`` and ``modeMetadata`` at
  // the modal boundary but not at the generic call-site.
  const summary = useMemo(
    () =>
      formatModeSummary(
        mode,
        durationMinutes,
        metadata as Extract<ModeSummaryMetadata, { mode: typeof mode }>,
      ),
    [mode, durationMinutes, metadata],
  );
  return (
    <Text style={styles.summary} testID="insight-summary">
      {summary}
    </Text>
  );
}

interface CapHintsProps {
  withinSoftCap: boolean;
  withinHardCap: boolean;
}

function CapHints({ withinSoftCap, withinHardCap }: CapHintsProps) {
  if (!withinHardCap) {
    return (
      <Text style={styles.hardError} testID="insight-hard-error">
        Keep your note under {PRACTICE_INSIGHT_HARD_CAP.toLocaleString()} characters to save.
      </Text>
    );
  }
  if (!withinSoftCap) {
    return (
      <Text style={styles.softHint} testID="insight-soft-hint">
        One sentence is plenty — the reflection lives in your journal.
      </Text>
    );
  }
  return null;
}

interface ActionsProps {
  saveDisabled: boolean;
  onSavePress: () => void;
  onSkipPress: () => void;
  onJournalPress?: () => void;
}

function Actions({ saveDisabled, onSavePress, onSkipPress, onJournalPress }: ActionsProps) {
  return (
    <View style={styles.actions}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: saveDisabled }}
        disabled={saveDisabled}
        onPress={onSavePress}
        style={[styles.primaryButton, saveDisabled && styles.disabled]}
        testID="insight-save"
      >
        <Text style={styles.primaryText}>Save</Text>
      </Pressable>
      {onJournalPress && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: saveDisabled }}
          disabled={saveDisabled}
          onPress={onJournalPress}
          style={[styles.secondaryButton, saveDisabled && styles.disabled]}
          testID="insight-journal"
        >
          <Text style={styles.secondaryText}>Save &amp; journal with BotMason</Text>
        </Pressable>
      )}
      <Pressable
        accessibilityRole="button"
        onPress={onSkipPress}
        style={styles.skipButton}
        testID="insight-skip"
      >
        <Text style={styles.skipText}>Skip</Text>
      </Pressable>
    </View>
  );
}

interface SheetContentProps {
  mode: ModeSummaryKind;
  durationMinutes: number;
  modeMetadata: ModeSummaryMetadata;
  draft: string;
  setDraft: (_value: string) => void;
  withinSoftCap: boolean;
  withinHardCap: boolean;
  onSavePress: () => void;
  onSkipPress: () => void;
  onJournalPress?: () => void;
}

function SheetContent(props: SheetContentProps) {
  const {
    mode,
    durationMinutes,
    modeMetadata,
    draft,
    setDraft,
    withinSoftCap,
    withinHardCap,
    onSavePress,
    onSkipPress,
    onJournalPress,
  } = props;
  return (
    <View style={styles.sheet}>
      <Text style={styles.title}>How did it land?</Text>
      <SummaryBlock mode={mode} durationMinutes={durationMinutes} metadata={modeMetadata} />
      <TextInput
        accessibilityLabel="One-line insight"
        multiline
        onChangeText={setDraft}
        placeholder="One sentence is plenty…"
        placeholderTextColor={colors.text.tertiaryAccessible}
        style={styles.input}
        testID="insight-input"
        value={draft}
      />
      <CapHints withinSoftCap={withinSoftCap} withinHardCap={withinHardCap} />
      <Actions
        saveDisabled={!withinHardCap}
        onSavePress={onSavePress}
        onSkipPress={onSkipPress}
        onJournalPress={onJournalPress}
      />
    </View>
  );
}

export function InsightCaptureModal({
  visible,
  mode,
  durationMinutes,
  modeMetadata,
  onSave,
  onSkip,
  onJournal,
}: InsightCaptureModalProps): React.JSX.Element | null {
  const [draft, setDraft] = useState('');
  const { trimmed, withinSoftCap, withinHardCap } = validate(draft);

  const handleSave = useCallback(() => {
    if (!withinHardCap) return;
    onSave(trimmed);
  }, [onSave, trimmed, withinHardCap]);

  const handleJournal = useCallback(() => {
    if (!withinHardCap || !onJournal) return;
    onJournal(trimmed);
  }, [onJournal, trimmed, withinHardCap]);

  if (!visible) return null;

  return (
    <Modal
      animationType="fade"
      onRequestClose={onSkip}
      transparent
      visible={visible}
      testID="insight-capture-modal"
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.backdrop}
      >
        <SheetContent
          mode={mode}
          durationMinutes={durationMinutes}
          modeMetadata={modeMetadata}
          draft={draft}
          setDraft={setDraft}
          withinSoftCap={withinSoftCap}
          withinHardCap={withinHardCap}
          onSavePress={handleSave}
          onSkipPress={onSkip}
          onJournalPress={onJournal ? handleJournal : undefined}
        />
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.mystical.overlay,
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
  },
  sheet: {
    backgroundColor: colors.background.card,
    borderRadius: BORDER_RADIUS.xl,
    padding: SPACING.xl,
    ...shadows.large,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: SPACING.xs,
  },
  summary: {
    fontSize: 14,
    color: colors.text.secondaryAccessible,
    marginBottom: SPACING.md,
  },
  input: {
    minHeight: 80,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    fontSize: 16,
    color: colors.text.primary,
    textAlignVertical: 'top',
  },
  softHint: {
    color: colors.text.secondaryAccessible,
    fontSize: 13,
    marginTop: SPACING.sm,
  },
  hardError: {
    color: colors.destructive.text,
    fontSize: 13,
    marginTop: SPACING.sm,
  },
  actions: {
    marginTop: SPACING.lg,
    gap: SPACING.sm,
  },
  primaryButton: {
    backgroundColor: colors.primary,
    paddingVertical: SPACING.buttonV,
    borderRadius: BORDER_RADIUS.lg,
    alignItems: 'center',
  },
  primaryText: {
    color: colors.text.light,
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: colors.secondary,
    paddingVertical: SPACING.buttonV,
    borderRadius: BORDER_RADIUS.lg,
    alignItems: 'center',
  },
  secondaryText: {
    color: colors.text.light,
    fontSize: 15,
    fontWeight: '600',
  },
  skipButton: {
    paddingVertical: SPACING.md,
    alignItems: 'center',
  },
  skipText: {
    color: colors.text.tertiaryAccessible,
    fontSize: 15,
  },
  disabled: {
    opacity: 0.5,
  },
});
