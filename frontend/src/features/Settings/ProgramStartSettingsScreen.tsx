import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';

import { SettingsFeedbackBanner } from './shared/SettingsFeedbackBanner';
import { settingsFormStyles, settingsFormType } from './shared/settingsFormLayout';
import type { SettingsFormState } from './shared/useSettingsForm';
import { useSettingsFormState } from './shared/useSettingsForm';

import DatePicker, { parseISODate } from '@/components/DatePicker';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { useAuth } from '@/context/AuthContext';
import { BORDER_RADIUS, SPACING, ink, surface } from '@/design/tokens';
import { habitManager } from '@/features/Habits/services/habitManager';
import { reconcileProgramAnchor } from '@/features/Program/programAnchor';
import { PROGRAM_START_FIXED_COPY } from '@/features/Program/ProgramStartFixed';
import {
  notAfterToday,
  pickerFloor,
  useProgramStartRange,
  type ProgramStartRange,
} from '@/features/Program/programStartRange';
import { useProgramStore } from '@/store/useProgramStore';

/**
 * "Program start date" settings entry (#3097).
 *
 * The edit-afterwards path for the day the person's program began, reachable
 * without any habits: a habits-only person -- or someone who never opened the
 * scaffolding -- can pick it here. It reads the server's anchor and window,
 * offers only the dates the server accepts, and saves through
 * ``habitManager.changeProgramStart`` so any program habits are re-laid from
 * the new day. Once begin-again has fixed the date it is shown, not offered.
 */

const INTRO_COPY =
  'The day your 36-week program began. Course readings, practices and the map count their weeks from it. ' +
  'Change it if you began before you joined, or picked the wrong day.';

const NO_DATE_COPY =
  "You haven't picked a start date yet. Choose today, or the day you began if that was earlier.";

const formatDay = (day: string): string =>
  parseISODate(day).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

const savedCopy = (day: string): string =>
  `Start date saved. Your program now counts from ${formatDay(day)}.`;

interface Props {
  navigation?: { goBack?: () => void };
}

const CurrentDateCard = ({ day }: { day: string | null }): React.JSX.Element => {
  const face = settingsFormType(useWindowDimensions().width);
  return (
    <View style={styles.currentCard}>
      <Text style={[face.cardLabel, settingsFormStyles.cardLabel]}>Current start date</Text>
      <Text style={styles.currentValue} testID="current-program-start">
        {day === null ? NO_DATE_COPY : formatDay(day)}
      </Text>
    </View>
  );
};

/** The day the picker opens on: the held date (never after today), else today. */
const openingDay = (held: string | null, range: ProgramStartRange): string =>
  held === null ? range.maxDay : notAfterToday(held, range);

/**
 * Keep the draft on the held date until the person edits it, so the server's
 * answer -- which may land after the screen mounts -- shows without a reload.
 */
function useHeldDraft(form: SettingsFormState, held: string | null, range: ProgramStartRange) {
  const edited = useRef(false);
  const { setDraft } = form;
  const opening = openingDay(held, range);
  useEffect(() => {
    if (!edited.current) setDraft(opening);
  }, [opening, setDraft]);
  const edit = useCallback(
    (day: string) => {
      edited.current = true;
      setDraft(day);
    },
    [setDraft],
  );
  const revert = useCallback(() => {
    edited.current = false;
    setDraft(opening);
  }, [opening, setDraft]);
  return { edit, revert };
}

function useSaveProgramStart(form: SettingsFormState, tz: string, revert: () => void) {
  const { draft, setSubmitting, setError, setStatus } = form;
  return useCallback(async () => {
    setError(null);
    setStatus(null);
    setSubmitting(true);
    const outcome = await habitManager.changeProgramStart(draft, tz);
    setSubmitting(false);
    if (outcome.kind === 'saved') {
      setStatus(savedCopy(draft));
      return;
    }
    // The server took the date but the habits could not follow: the date
    // stands, so the picker stays on it and Save again re-lays the rows.
    if (outcome.kind !== 'rows_unsaved') revert();
    setError(outcome.message);
  }, [draft, tz, revert, setSubmitting, setError, setStatus]);
}

interface PickerSectionProps {
  state: SettingsFormState;
  range: ProgramStartRange;
  onChange: (_day: string) => void;
  onSave: () => void;
}

const PickerSection = ({
  state,
  range,
  onChange,
  onSave,
}: PickerSectionProps): React.JSX.Element => (
  <>
    <Text style={settingsFormStyles.inputLabel}>New start date</Text>
    <View style={styles.pickerRow}>
      <DatePicker
        value={state.draft}
        minDate={pickerFloor(range, state.draft)}
        maxDate={range.maxDay}
        onChange={onChange}
      />
    </View>
    <SettingsFeedbackBanner idPrefix="program-start" error={state.error} status={state.status} />
    <TouchableOpacity
      onPress={onSave}
      style={settingsFormStyles.primaryButton}
      disabled={state.submitting}
      testID="save-program-start-button"
      accessibilityLabel="Save start date"
      accessibilityRole="button"
      accessibilityState={{ disabled: state.submitting, busy: state.submitting }}
    >
      <Text style={settingsFormStyles.primaryButtonText}>
        {state.submitting ? 'Saving…' : 'Save'}
      </Text>
    </TouchableOpacity>
  </>
);

const BackLink = ({ onBack }: { onBack?: () => void }): React.JSX.Element | null =>
  onBack ? (
    <TouchableOpacity
      onPress={onBack}
      style={settingsFormStyles.linkRow}
      accessibilityLabel="Go back"
      accessibilityRole="link"
    >
      <Text style={settingsFormStyles.link}>Back</Text>
    </TouchableOpacity>
  ) : null;

export default function ProgramStartSettingsScreen({ navigation }: Props = {}): React.JSX.Element {
  const { userTimezone } = useAuth();
  const held = useProgramStore((s) => s.programStartDay);
  const range = useProgramStartRange(userTimezone);
  const state = useSettingsFormState(openingDay(held, range));
  const { edit, revert } = useHeldDraft(state, held, range);
  const save = useSaveProgramStart(state, userTimezone, revert);
  const { setError, setStatus } = state;

  // One read on arrival: the server is the authority, and the cached anchor may
  // be from before an edit made on another device.
  useEffect(() => {
    void reconcileProgramAnchor(userTimezone);
  }, [userTimezone]);

  const onChange = useCallback(
    (day: string) => {
      edit(day);
      setError(null);
      setStatus(null);
    },
    [edit, setError, setStatus],
  );
  const onBack = useMemo(
    () => (navigation?.goBack ? () => navigation.goBack?.() : undefined),
    [navigation],
  );

  return (
    <ScreenScaffold scroll testID="program-start-settings-screen">
      <Text style={settingsFormStyles.body}>{INTRO_COPY}</Text>
      <CurrentDateCard day={held} />
      {range.locked ? (
        <Text style={settingsFormStyles.body}>{PROGRAM_START_FIXED_COPY}</Text>
      ) : (
        <PickerSection state={state} range={range} onChange={onChange} onSave={() => void save()} />
      )}
      <BackLink onBack={onBack} />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  currentCard: {
    borderWidth: 1,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    marginBottom: SPACING.xl,
    backgroundColor: surface.raised,
  },
  currentValue: {
    ...StyleSheet.flatten(settingsFormStyles.inputLabel),
    marginTop: SPACING.sm,
    marginBottom: 0,
    color: ink.primary,
  },
  pickerRow: {
    marginBottom: SPACING.md,
  },
});
