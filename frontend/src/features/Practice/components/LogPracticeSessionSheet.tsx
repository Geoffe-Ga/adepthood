/**
 * `LogPracticeSessionSheet` — records a sitting done away from the app.
 *
 * The timer is not the only way people practise: a sitting on a cushion with
 * the phone in another room is still the practice, and before this the only
 * path into `POST /practice-sessions/` was completing the in-app engine. The
 * sheet asks the two things the server needs — when the sitting ended and how
 * long it ran — and derives `started_at` by subtraction, leaving
 * `duration_minutes` to the server exactly as the timer does.
 *
 * It is a modal, deliberately: opening it never unmounts the ritual engine
 * behind it. The window rules are checked here first (`utils/sessionWindow`),
 * so an impossible time is refused with the reason rather than spending a
 * request to be told the same thing in Python's words.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import type { PracticeSessionResponse } from '@/api';
import {
  BORDER_RADIUS,
  SPACING,
  accent,
  colors,
  editorialType,
  ink,
  surface,
  surfaceShadow,
} from '@/design/tokens';
import { LabeledRow, NumericField } from '@/features/Practice/configurator/forms/shared';
import {
  MAX_BACKDATE_HOURS,
  MAX_SESSION_HOURS,
  MINUTES_PER_HOUR,
  MS_PER_HOUR,
} from '@/features/Practice/constants';
import { MS_PER_MINUTE } from '@/features/Practice/engine/types';
import { useSaveSessionMutation } from '@/features/Practice/hooks/useSaveSessionMutation';
import {
  SESSION_WINDOW_COPY,
  SESSION_WINDOW_HINT,
  manualSessionPayload,
  sessionWindowViolations,
} from '@/features/Practice/utils/sessionWindow';
import { addDaysInTZ, dayKeyInTZ, formatTimeInTZ, todayInUserTZ } from '@/utils/dateUtils';

/** The 422 the form's own guards are meant to make unreachable. */
const HTTP_UNPROCESSABLE = 422;

/** Quarter-hour step for the end-time control — the finer of its two grains. */
const QUARTER_HOUR_MINUTES = 15;
const QUARTER_HOUR_MS = QUARTER_HOUR_MINUTES * MS_PER_MINUTE;

/** Shown when the failure is not one the form can name more precisely. */
export const LOG_SAVE_FALLBACK =
  "We couldn't log that practice. Check your connection and try again.";

/**
 * The server's own window refusal, said in the form's terms. Every 422 this
 * form can provoke is a window rule — it sends no reflection or insight — so
 * keying the override on the status alone stays accurate.
 */
export const LOG_WINDOW_REFUSED_COPY = `That time can't be logged: only sessions from the last ${MAX_BACKDATE_HOURS} hours, up to ${MAX_SESSION_HOURS} hours long. Adjust the end time or the minutes and try again.`;

/** Shown while the minutes field holds something that is not a count of minutes. */
export const DURATION_PROBLEM_COPY = 'Enter how many whole minutes you practised.';

export interface LogPracticeSessionSheetProps {
  visible: boolean;
  userPracticeId: number;
  practiceName: string;
  /** Seeds the minutes field — the practice's own declared length. */
  defaultDurationMinutes: number;
  userTimezone: string;
  onClose: () => void;
  /** Optimistic +1 on the weekly bar. */
  onSessionApply: () => void;
  /** Rollback when the write fails. */
  onSessionRollback: () => void;
  /** Authoritative refetch once the row exists. */
  onSessionCommitted: () => void;
}

/** "Today", "Yesterday", or a short weekday date — the day the sitting ended. */
function dayLabel(endedAt: Date, tz: string): string {
  const key = dayKeyInTZ(endedAt, tz);
  const todayKey = todayInUserTZ(tz);
  if (key === todayKey) return 'Today';
  if (key === addDaysInTZ(todayKey, -1, tz)) return 'Yesterday';
  return new Date(`${key}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

interface LogSessionForm {
  minutes: number | null;
  setMinutes: (_next: number | null) => void;
  endedAt: Date;
  shiftEnd: (_deltaMs: number) => void;
  /** The first thing wrong with the current choice, or null when it is loggable. */
  problem: string | null;
  atNow: boolean;
}

/**
 * The form's own state: the minutes, the end instant, and what is wrong with
 * them. Reset whenever the sheet opens so a previous attempt (or a previous
 * failure) never seeds the next one.
 */
function useLogSessionForm(
  visible: boolean,
  defaultDurationMinutes: number,
  clearError: () => void,
): LogSessionForm {
  // `default_duration_minutes` is a float on the wire (backend/src/schemas/
  // practice.py, models/practice.py), but the field below asks for whole
  // minutes. Seeding it raw would open the sheet already refusing to save,
  // showing the correction copy before the writer had touched anything.
  const seedMinutes = Math.round(defaultDurationMinutes);
  const [minutes, setMinutes] = useState<number | null>(seedMinutes);
  const [endedAt, setEndedAt] = useState<Date>(() => new Date());

  useEffect(() => {
    if (!visible) return;
    setMinutes(seedMinutes);
    setEndedAt(new Date());
    clearError();
  }, [visible, seedMinutes, clearError]);

  const shiftEnd = useCallback((deltaMs: number) => {
    setEndedAt((current) => {
      const next = new Date(current.getTime() + deltaMs);
      // Clamp forward steps at now: an end in the future is never a sitting
      // that happened, and the server refuses it anyway.
      return next.getTime() > Date.now() ? new Date() : next;
    });
  }, []);

  const durationOk = minutes !== null && Number.isInteger(minutes) && minutes > 0;
  const violations = durationOk
    ? sessionWindowViolations(
        new Date(endedAt.getTime() - minutes * MS_PER_MINUTE),
        endedAt,
        new Date(),
      )
    : [];
  const firstViolation = violations[0];
  const problem = durationOk
    ? firstViolation === undefined
      ? null
      : SESSION_WINDOW_COPY[firstViolation]
    : DURATION_PROBLEM_COPY;

  return {
    minutes,
    setMinutes,
    endedAt,
    shiftEnd,
    problem,
    atNow: endedAt.getTime() >= Date.now(),
  };
}

interface StepButtonProps {
  label: string;
  testID: string;
  disabled?: boolean;
  onPress: () => void;
}

const StepButton = ({
  label,
  testID,
  disabled = false,
  onPress,
}: StepButtonProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled }}
    disabled={disabled}
    onPress={disabled ? undefined : onPress}
    style={[styles.stepButton, disabled && styles.disabled]}
    testID={testID}
  >
    <Text style={styles.stepText}>{label}</Text>
  </TouchableOpacity>
);

interface EndedAtStepperProps {
  endedAt: Date;
  userTimezone: string;
  atNow: boolean;
  onShift: (_deltaMs: number) => void;
}

/** Coarse/fine steps either side of the end-time label, forward-capped at now. */
const EndedAtStepper = ({
  endedAt,
  userTimezone,
  atNow,
  onShift,
}: EndedAtStepperProps): React.JSX.Element => (
  <View style={styles.stepperRow} testID="log-session-ended-stepper">
    <StepButton
      label="An hour earlier"
      testID="log-session-ended-earlier-hour"
      onPress={() => onShift(-MS_PER_HOUR)}
    />
    <StepButton
      label="Fifteen minutes earlier"
      testID="log-session-ended-earlier-quarter"
      onPress={() => onShift(-QUARTER_HOUR_MS)}
    />
    <Text style={styles.endedLabel} testID="log-session-ended-label">
      {`${dayLabel(endedAt, userTimezone)}, ${formatTimeInTZ(endedAt, userTimezone)}`}
    </Text>
    <StepButton
      label="Fifteen minutes later"
      testID="log-session-ended-later-quarter"
      disabled={atNow}
      onPress={() => onShift(QUARTER_HOUR_MS)}
    />
    <StepButton
      label="An hour later"
      testID="log-session-ended-later-hour"
      disabled={atNow}
      onPress={() => onShift(MS_PER_HOUR)}
    />
  </View>
);

interface SheetBodyProps {
  practiceName: string;
  form: LogSessionForm;
  userTimezone: string;
  saveError: string | null;
  canSave: boolean;
  onSave: () => void;
  onClose: () => void;
}

const SheetBody = ({
  practiceName,
  form,
  userTimezone,
  saveError,
  canSave,
  onSave,
  onClose,
}: SheetBodyProps): React.JSX.Element => (
  <KeyboardAvoidingView
    behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    style={styles.overlay}
    testID="log-session-overlay"
  >
    <View style={styles.sheet} testID="log-session-sheet">
      <Text style={styles.title} testID="log-session-title">
        Log a past session
      </Text>
      <Text style={styles.subtitle} testID="log-session-subtitle">
        {`A sitting of ${practiceName} you did away from the timer.`}
      </Text>
      <SheetFields form={form} userTimezone={userTimezone} />
      {saveError !== null && (
        <Text style={styles.error} testID="log-session-error">
          {saveError}
        </Text>
      )}
      <SheetActions canSave={canSave} onSave={onSave} onClose={onClose} />
    </View>
  </KeyboardAvoidingView>
);

/** The two choices the server needs, plus what is currently wrong with them. */
const SheetFields = ({
  form,
  userTimezone,
}: {
  form: LogSessionForm;
  userTimezone: string;
}): React.JSX.Element => (
  <>
    <LabeledRow label="Ended">
      <EndedAtStepper
        endedAt={form.endedAt}
        userTimezone={userTimezone}
        atNow={form.atNow}
        onShift={form.shiftEnd}
      />
    </LabeledRow>
    <LabeledRow label="Minutes practised">
      <NumericField
        value={form.minutes}
        onChange={form.setMinutes}
        allowNull
        placeholder={String(MINUTES_PER_HOUR)}
        testID="log-session-duration"
      />
    </LabeledRow>
    <Text style={styles.hint} testID="log-session-hint">
      {SESSION_WINDOW_HINT}
    </Text>
    {form.problem !== null && (
      <Text style={styles.note} testID="log-session-window-note">
        {form.problem}
      </Text>
    )}
  </>
);

interface SheetActionsProps {
  canSave: boolean;
  onSave: () => void;
  onClose: () => void;
}

const SheetActions = ({ canSave, onSave, onClose }: SheetActionsProps): React.JSX.Element => (
  <View style={styles.actionRow}>
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="Cancel"
      onPress={onClose}
      style={styles.cancelButton}
      testID="log-session-cancel"
    >
      <Text style={styles.cancelText}>Cancel</Text>
    </TouchableOpacity>
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="Log this practice"
      accessibilityState={{ disabled: !canSave }}
      disabled={!canSave}
      onPress={canSave ? onSave : undefined}
      style={[styles.saveButton, !canSave && styles.disabled]}
      testID="log-session-save"
    >
      <Text style={styles.saveText}>Log this practice</Text>
    </TouchableOpacity>
  </View>
);

const LogPracticeSessionSheet = (props: LogPracticeSessionSheetProps): React.JSX.Element => {
  const [saveError, setSaveError] = useState<string | null>(null);
  const clearError = useCallback(() => setSaveError(null), []);
  const form = useLogSessionForm(props.visible, props.defaultDurationMinutes, clearError);
  const save = useSaveSessionMutation({
    apply: props.onSessionApply,
    rollback: props.onSessionRollback,
    commit: props.onSessionCommitted,
    setSaveError,
    errorOptions: {
      fallback: LOG_SAVE_FALLBACK,
      statusOverrides: { [HTTP_UNPROCESSABLE]: LOG_WINDOW_REFUSED_COPY },
    },
  });
  const canSave = form.problem === null && form.minutes !== null && !save.pending;

  const onSave = useCallback(() => {
    if (form.minutes === null) return;
    const payload = manualSessionPayload({
      userPracticeId: props.userPracticeId,
      endedAt: form.endedAt,
      durationMinutes: form.minutes,
    });
    // The banner is already set by the mutation's rollback; swallowing the
    // rejection here only stops it becoming an unhandled promise.
    void save
      .mutate(payload)
      .then((_session: PracticeSessionResponse) => props.onClose())
      .catch(() => undefined);
  }, [form.minutes, form.endedAt, props, save]);

  return (
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={props.onClose}>
      <SheetBody
        practiceName={props.practiceName}
        form={form}
        userTimezone={props.userTimezone}
        saveError={saveError}
        canSave={canSave}
        onSave={onSave}
        onClose={props.onClose}
      />
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.mystical.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: surface.canvas,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    padding: SPACING.lg,
    ...surfaceShadow.raised,
  },
  title: { ...editorialType.heading, color: ink.primary },
  subtitle: { ...editorialType.caption, color: ink.soft, marginBottom: SPACING.md },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  stepButton: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: surface.raised,
    borderWidth: 1,
    borderColor: surface.hairline,
  },
  stepText: { ...editorialType.action, color: ink.primary },
  endedLabel: { ...editorialType.note, color: ink.primary, flex: 1, textAlign: 'center' },
  hint: { ...editorialType.caption, color: ink.soft, marginTop: SPACING.md },
  note: { ...editorialType.caption, color: ink.primary, marginTop: SPACING.sm },
  error: { color: colors.danger, fontSize: 13, marginTop: SPACING.sm },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: SPACING.sm,
    marginTop: SPACING.lg,
  },
  cancelButton: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
  },
  cancelText: { color: ink.soft, fontSize: 14, fontWeight: '500' },
  saveButton: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: accent.primary,
  },
  saveText: { color: accent.onPrimary, fontSize: 14, fontWeight: '600' },
  disabled: { opacity: 0.4 },
});

export default LogPracticeSessionSheet;
