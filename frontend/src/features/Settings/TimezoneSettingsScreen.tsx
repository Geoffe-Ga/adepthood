import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { ApiError, users } from '@/api';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { useAuth } from '@/context/AuthContext';
import { BORDER_RADIUS, SPACING, accent, colors, ink, surface } from '@/design/tokens';
import { detectDeviceTimezone } from '@/utils/dateUtils';

/**
 * "Time zone" settings entry (issue #261).
 *
 * Lets a user correct the IANA zone stored at signup — needed when they
 * travel, immigrate, or signed up on a device whose clock / zone was wrong.
 * Saves via ``PUT /users/me/timezone`` and pushes the server-confirmed zone
 * into ``AuthContext.userTimezone`` so user-local helpers (Habit stats,
 * streaks, weekday charts) reflect the change immediately.
 */

const EXAMPLE_ZONE = 'America/Los_Angeles';

// Visual parity with ApiKeySettingsScreen's primary button, whose padding is
// also SPACING.md nudged up to balance the larger label font.
const SAVE_BUTTON_PADDING = SPACING.md + 2;

const EMPTY_ZONE_MESSAGE =
  `Enter a time zone name like "${EXAMPLE_ZONE}", ` +
  'or tap "Use device time zone" to detect it for you.';

function unknownZoneMessage(zone: string): string {
  return (
    `"${zone}" isn't a recognized time zone. ` +
    `Use an IANA name like "${EXAMPLE_ZONE}", or tap "Use device time zone".`
  );
}

function saveErrorMessage(err: unknown, zone: string): string {
  if (err instanceof ApiError && err.status === 422) {
    return unknownZoneMessage(zone);
  }
  return err instanceof Error && err.message
    ? err.message
    : 'Could not save the time zone. Check your connection and try again.';
}

interface Props {
  navigation?: { goBack?: () => void };
}

const CurrentZoneCard = ({ zone }: { zone: string }): React.JSX.Element => (
  <View style={styles.currentCard}>
    <Text style={styles.currentLabel}>Current time zone</Text>
    <Text style={styles.currentValue} testID="current-timezone">
      {zone}
    </Text>
  </View>
);

interface FeedbackBannerProps {
  error: string | null;
  status: string | null;
}

const FeedbackBanner = ({ error, status }: FeedbackBannerProps): React.JSX.Element | null => {
  if (error) {
    return (
      <Text style={styles.error} testID="timezone-error">
        {error}
      </Text>
    );
  }
  if (status) {
    return (
      <Text style={styles.success} testID="timezone-status">
        {status}
      </Text>
    );
  }
  return null;
};

interface TimezoneScreenState {
  draft: string;
  submitting: boolean;
  error: string | null;
  status: string | null;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setSubmitting: React.Dispatch<React.SetStateAction<boolean>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setStatus: React.Dispatch<React.SetStateAction<string | null>>;
}

function useTimezoneScreenState(initialZone: string): TimezoneScreenState {
  const [draft, setDraft] = useState(initialZone);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  return { draft, submitting, error, status, setDraft, setSubmitting, setError, setStatus };
}

function useSaveTimezoneHandler(
  state: TimezoneScreenState,
  applyTimezone: (_timezone: string) => void,
): () => Promise<void> {
  const { draft, setSubmitting, setError, setStatus } = state;
  return useCallback(async () => {
    setStatus(null);
    const candidate = draft.trim();
    if (!candidate) {
      setError(EMPTY_ZONE_MESSAGE);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await users.updateMyTimezone({ timezone: candidate });
      applyTimezone(result.timezone);
      setStatus('Time zone updated. Streaks and daily stats now use it.');
    } catch (err: unknown) {
      setError(saveErrorMessage(err, candidate));
    } finally {
      setSubmitting(false);
    }
  }, [draft, applyTimezone, setSubmitting, setError, setStatus]);
}

interface ScreenBodyProps {
  currentZone: string;
  state: TimezoneScreenState;
  onChangeDraft: (_value: string) => void;
  onUseDeviceZone: () => void;
  onSave: () => void;
  onBack?: () => void;
}

interface ZoneInputSectionProps {
  draft: string;
  onChangeDraft: (_value: string) => void;
  onUseDeviceZone: () => void;
}

const ZoneInputSection = ({
  draft,
  onChangeDraft,
  onUseDeviceZone,
}: ZoneInputSectionProps): React.JSX.Element => (
  <>
    <Text style={styles.inputLabel}>New time zone</Text>
    <TextInput
      style={styles.input}
      placeholder={EXAMPLE_ZONE}
      value={draft}
      onChangeText={onChangeDraft}
      autoCapitalize="none"
      autoCorrect={false}
      testID="timezone-input"
    />
    <TouchableOpacity
      onPress={onUseDeviceZone}
      style={styles.secondaryButton}
      testID="use-device-timezone-button"
      accessibilityLabel="Use device time zone"
      accessibilityRole="button"
    >
      <Text style={styles.secondaryButtonText}>Use device time zone</Text>
    </TouchableOpacity>
  </>
);

const ScreenFooter = ({
  submitting,
  onSave,
  onBack,
}: {
  submitting: boolean;
  onSave: () => void;
  onBack?: () => void;
}): React.JSX.Element => (
  <>
    <TouchableOpacity
      onPress={onSave}
      style={styles.primaryButton}
      disabled={submitting}
      testID="save-timezone-button"
      accessibilityLabel="Save time zone"
      accessibilityRole="button"
      accessibilityState={{ disabled: submitting, busy: submitting }}
    >
      <Text style={styles.primaryButtonText}>{submitting ? 'Saving…' : 'Save'}</Text>
    </TouchableOpacity>
    {onBack && (
      <TouchableOpacity
        onPress={onBack}
        style={styles.linkRow}
        accessibilityLabel="Go back"
        accessibilityRole="link"
      >
        <Text style={styles.link}>Back</Text>
      </TouchableOpacity>
    )}
  </>
);

const ScreenBody = ({
  currentZone,
  state,
  onChangeDraft,
  onUseDeviceZone,
  onSave,
  onBack,
}: ScreenBodyProps): React.JSX.Element => (
  <ScreenScaffold scroll testID="timezone-settings-screen">
    <Text style={styles.title}>Time zone</Text>
    <Text style={styles.body}>
      Streaks and daily stats count days in this time zone. Update it if you moved or if it was
      detected wrong at signup.
    </Text>
    <CurrentZoneCard zone={currentZone} />
    <ZoneInputSection
      draft={state.draft}
      onChangeDraft={onChangeDraft}
      onUseDeviceZone={onUseDeviceZone}
    />
    <FeedbackBanner error={state.error} status={state.status} />
    <ScreenFooter submitting={state.submitting} onSave={onSave} onBack={onBack} />
  </ScreenScaffold>
);

export default function TimezoneSettingsScreen({ navigation }: Props = {}): React.JSX.Element {
  const { userTimezone, setUserTimezone } = useAuth();
  const state = useTimezoneScreenState(userTimezone);
  const handleSave = useSaveTimezoneHandler(state, setUserTimezone);

  // Depend on the stable useState setters, not ``state`` itself — the hook
  // returns a fresh object every render, so a ``[state]`` dependency would
  // silently defeat the memoization.
  const { setDraft, setError } = state;
  const onChangeDraft = useCallback(
    (value: string) => {
      setDraft(value);
      setError(null);
    },
    [setDraft, setError],
  );

  const onUseDeviceZone = useCallback(() => {
    setDraft(detectDeviceTimezone());
    setError(null);
  }, [setDraft, setError]);

  const onBack = useMemo(
    () => (navigation?.goBack ? () => navigation.goBack?.() : undefined),
    [navigation],
  );

  return (
    <ScreenBody
      currentZone={userTimezone}
      state={state}
      onChangeDraft={onChangeDraft}
      onUseDeviceZone={onUseDeviceZone}
      onSave={handleSave}
      onBack={onBack}
    />
  );
}

const MENLO_MONOSPACE = 'Menlo';
const CURRENT_LABEL_LETTER_SPACING = 0.5;

const styles = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '700', marginBottom: SPACING.md, color: ink.primary },
  body: {
    fontSize: 14,
    color: ink.soft,
    marginBottom: SPACING.xl,
    lineHeight: 20,
  },
  currentCard: {
    borderWidth: 1,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    marginBottom: SPACING.xl,
    backgroundColor: surface.raised,
  },
  currentLabel: {
    fontSize: 12,
    color: ink.muted,
    textTransform: 'uppercase',
    letterSpacing: CURRENT_LABEL_LETTER_SPACING,
  },
  currentValue: {
    fontSize: 18,
    fontFamily: MENLO_MONOSPACE,
    marginTop: SPACING.sm,
    color: ink.primary,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: SPACING.sm,
    color: ink.primary,
  },
  input: {
    borderWidth: 1,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    fontSize: 16,
    marginBottom: SPACING.md,
    backgroundColor: surface.raised,
    color: ink.primary,
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    alignItems: 'center',
    backgroundColor: surface.sunken,
    marginBottom: SPACING.md,
  },
  secondaryButtonText: { fontSize: 14, color: ink.primary, fontWeight: '600' },
  error: { color: colors.destructive.text, marginBottom: SPACING.md },
  success: { color: colors.successText, marginBottom: SPACING.md },
  primaryButton: {
    borderRadius: BORDER_RADIUS.md,
    padding: SAVE_BUTTON_PADDING,
    alignItems: 'center',
    backgroundColor: accent.primary,
    marginTop: SPACING.xs,
  },
  primaryButtonText: { color: colors.text.light, fontSize: 16, fontWeight: '600' },
  linkRow: { marginTop: SPACING.xl, alignItems: 'center' },
  link: { color: accent.primary, fontWeight: '600' },
});
