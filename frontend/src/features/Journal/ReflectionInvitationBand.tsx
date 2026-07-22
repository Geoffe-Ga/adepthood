/**
 * ``ReflectionInvitationBand`` — the 7th-day reflection invitation on the
 * Journal shelf. Self-contained like ``ReturnStack`` / ``InvitationStack``: it
 * takes no props, fetches its own "is a reflection due?" state, and quietly
 * renders nothing when nothing is due, when the scope was set aside, or on any
 * fetch error.
 *
 * "You choose your depth": this is a warm, one-tap-declinable invitation — never
 * a gate and never gamified. There is deliberately no streak, no count, and no
 * guilt copy. Declining persists per scope key, so the same window stays quiet
 * while a genuinely new scope still surfaces its own invitation.
 */
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { reflectionTitle } from './reflectionCopy';
import ReflectionDismiss from './ReflectionDismiss';

import { reflections, stages } from '@/api';
import type { ReflectionDue } from '@/api';
import {
  BORDER_RADIUS,
  SPACING,
  accent,
  editorialType,
  ink,
  spacing,
  surface,
  surfaceShadow,
  touchTarget,
} from '@/design/tokens';
import type { RootStackParamList } from '@/navigation/RootStack';
import {
  loadReflectionDismissed,
  saveReflectionDismissed,
} from '@/storage/reflectionDismissalStorage';

/** Extracts the stage ordinal from a stage scope key (``c1:s1`` → ``1``). */
const STAGE_SCOPE_KEY = /^c\d+:s(\d+)$/;

/** The band's identifying warm left rule (matches the weekly-prompt band), in dp. */
const ACCENT_BAR_WIDTH = 3;

/** Warm, declinable copy — no streaks, no counts, no guilt. */
const BAND_LABEL = 'A reflection has come round';
const INVITE_SUBLINE = 'A quiet space to look back — only if you like.';
const DISMISS_LABEL = 'Not now';
const DISMISS_A11Y = 'Set this reflection invitation aside';

type BandNavigation = NativeStackNavigationProp<RootStackParamList>;

/** A due reflection plus the stage title resolved for stage-level copy. */
interface DueBand {
  due: ReflectionDue;
  stageTitle: string | null;
}

/** Resolve the stage title for a stage scope key, or null when unavailable. */
async function resolveStageTitle(scopeKey: string): Promise<string | null> {
  const captured = STAGE_SCOPE_KEY.exec(scopeKey)?.[1];
  const stageNumber = captured == null ? Number.NaN : Number.parseInt(captured, 10);
  if (Number.isNaN(stageNumber)) return null;
  const all = await stages.listAll();
  const found = all.find((stage) => stage.stage_number === stageNumber);
  return found?.title ?? null;
}

/**
 * Fetch the due window and derive the band, or null when there is nothing to
 * show. Any failure resolves null so the shelf never sees an error from a
 * background poll — the invitation simply stays quiet.
 */
async function resolveDueBand(): Promise<DueBand | null> {
  try {
    const { due } = await reflections.due();
    if (due == null) return null;
    if (await loadReflectionDismissed(due.scope_key)) return null;
    const stageTitle = due.level === 'stage' ? await resolveStageTitle(due.scope_key) : null;
    return { due, stageTitle };
  } catch {
    return null;
  }
}

/** Owns the due-band state, the fetch-on-mount, and the open/dismiss actions. */
function useReflectionInvitation(navigation: BandNavigation) {
  const [band, setBand] = useState<DueBand | null>(null);

  useEffect(() => {
    let active = true;
    void resolveDueBand().then((resolved) => {
      if (active && resolved != null) setBand(resolved);
    });
    return () => {
      active = false;
    };
  }, []);

  const onOpen = useCallback(() => {
    if (band == null) return;
    const { due, stageTitle } = band;
    if (due.existing_entry_id != null) {
      navigation.navigate('JournalEntry', { entryId: due.existing_entry_id });
      return;
    }
    navigation.navigate('JournalEntry', {
      reflectionLevel: due.level,
      reflectionScopeKey: due.scope_key,
      prefillTitle: reflectionTitle(due.level, due.scope_key, stageTitle ?? undefined),
    });
  }, [band, navigation]);

  const onDismiss = useCallback(() => {
    if (band == null) return;
    void saveReflectionDismissed(band.due.scope_key, true);
    setBand(null);
  }, [band]);

  return { band, onOpen, onDismiss };
}

function ReflectionInvitationBand(): React.JSX.Element | null {
  const navigation = useNavigation<BandNavigation>();
  const { band, onOpen, onDismiss } = useReflectionInvitation(navigation);
  if (band == null) return null;

  const { due, stageTitle } = band;
  const title = reflectionTitle(due.level, due.scope_key, stageTitle ?? undefined);
  const resuming = due.existing_entry_id != null;
  const accessibilityLabel = resuming ? `Continue your ${title}` : `Begin your ${title}`;

  // A plain container, not a pressable, so the inner "open" and "decline"
  // buttons stay independently reachable by assistive tech (a pressable wrapper
  // would collapse the subtree and hide the one-tap decline). Mirrors the
  // ``InvitationNote`` card shape.
  return (
    <View style={styles.band}>
      <TouchableOpacity
        style={styles.openArea}
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        testID="journal-reflection-band"
      >
        <Text style={styles.label}>{BAND_LABEL}</Text>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subline}>
          {resuming ? 'Pick up where you left off.' : INVITE_SUBLINE}
        </Text>
      </TouchableOpacity>
      <ReflectionDismiss
        label={DISMISS_LABEL}
        accessibilityLabel={DISMISS_A11Y}
        testID="journal-reflection-dismiss"
        onPress={onDismiss}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  band: {
    marginTop: SPACING.lg,
    padding: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
    // A raised sheet with the same warm accent rule as the weekly-prompt band,
    // so the two invitations read as a matched pair on the shelf.
    backgroundColor: surface.raised,
    borderLeftWidth: ACCENT_BAR_WIDTH,
    borderLeftColor: accent.primary,
    ...surfaceShadow.card,
  },
  openArea: {
    minHeight: touchTarget.minimum,
  },
  label: {
    ...editorialType.caption,
    color: ink.muted,
    textTransform: 'uppercase',
  },
  title: {
    ...editorialType.heading,
    color: ink.primary,
    paddingTop: spacing(0.5),
  },
  subline: {
    ...editorialType.note,
    color: ink.soft,
    paddingTop: spacing(0.5),
  },
});

export default ReflectionInvitationBand;
