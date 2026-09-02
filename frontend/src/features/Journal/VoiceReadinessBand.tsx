/**
 * ``VoiceReadinessBand`` — a quiet note on the Journal shelf saying where the
 * reflections a person reads are actually coming from. Self-contained like
 * ``ReflectionInvitationBand``: it takes no props, fetches its own state, and
 * renders nothing while that is resolving, on any fetch error, once the corpus
 * is grounding the voice, and once the note has been set aside.
 *
 * "You choose your depth": this is a warm, one-tap-declinable note — never a
 * gate and never gamified. Resonance is untouched by it; a reflection is
 * produced at zero fragments exactly as at a thousand, and what changes is only
 * whether the person is told what it was built from. There is deliberately no
 * count, no ratio, no progress bar and no "N of 12", even though the payload
 * carries the number: a meter would turn a declinable invitation into a task.
 *
 * The sentence is the server's. There are two different ways to not be ready —
 * an account that has not agreed to have its journal sorted, and one that
 * agreed and is simply early — and they have opposite remedies. Only the server
 * knows which happened, so the copy comes down with the state rather than being
 * chosen here off a boolean. What this component owns is the destination: the
 * consent decision for the first, the import surface for the second.
 */
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import ReflectionDismiss from './ReflectionDismiss';

import { corpus } from '@/api';
import type { VoiceReadinessT } from '@/api/schemas';
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
  loadVoiceReadinessDismissed,
  saveVoiceReadinessDismissed,
} from '@/storage/voiceReadinessDismissalStorage';

/** The band's identifying warm left rule (matches the shelf's other bands), in dp. */
const ACCENT_BAR_WIDTH = 3;

const BAND_LABEL = 'Where your reflections come from';
const DISMISS_LABEL = 'Not now';
const DISMISS_A11Y = 'Set this note about your corpus aside';

/** The call to action per state, and where it goes. */
const NOT_CONSENTED_CTA = 'Look at the decision';
const GATHERING_CTA = 'Bring in your writing';

type BandNavigation = NativeStackNavigationProp<RootStackParamList>;

/** The two states that say something. ``ready`` renders nothing at all. */
type SpeakingState = 'not_consented' | 'gathering';

/** A readiness the band will actually render: not ready, with a sentence. */
interface SpeakingReadiness {
  state: SpeakingState;
  message: string;
}

/**
 * Narrow a readiness to one the band can render, or null for silence.
 *
 * ``ready`` is read rather than re-derived from ``state``: the server projects
 * it in one place, and a client re-deciding which states count as ready is how
 * the rule comes to mean two things. A not-ready state that arrived with no
 * sentence is also silence — a band with a heading and no body is worse than
 * no band.
 */
function speaking(readiness: VoiceReadinessT): SpeakingReadiness | null {
  if (readiness.ready || readiness.state === 'ready') return null;
  if (readiness.message == null) return null;
  return { state: readiness.state, message: readiness.message };
}

/**
 * Fetch readiness and derive the band, or null when there is nothing to show.
 * Any failure resolves null so the shelf never sees an error from a background
 * read — the note simply stays quiet.
 */
async function resolveBand(): Promise<SpeakingReadiness | null> {
  try {
    if (await loadVoiceReadinessDismissed()) return null;
    return speaking(await corpus.voiceReadiness());
  } catch {
    return null;
  }
}

/**
 * Owns the band state, the fetch-on-mount, and the open/dismiss actions.
 *
 * ``useEffect`` and deliberately **not** ``useFocusEffect``, which this screen
 * imports and uses elsewhere. Readiness moves on the scale of days; refetching
 * it on every tab return would be a poll wearing a different name, and would
 * re-request on each of the shelf's paginated loads besides.
 */
function useVoiceReadiness(navigation: BandNavigation) {
  const [band, setBand] = useState<SpeakingReadiness | null>(null);

  useEffect(() => {
    let active = true;
    void resolveBand().then((resolved) => {
      if (active && resolved != null) setBand(resolved);
    });
    return () => {
      active = false;
    };
  }, []);

  const onOpen = useCallback(() => {
    if (band == null) return;
    // The consent decision is the genuine first accelerator for an account
    // that has not made it: granting also sorts the writing already there,
    // where the import surface would offer a person a second thing to do
    // before the first one is answered.
    navigation.navigate(band.state === 'not_consented' ? 'CorpusConsent' : 'SeedCorpus');
  }, [band, navigation]);

  const onDismiss = useCallback(() => {
    void saveVoiceReadinessDismissed(true);
    setBand(null);
  }, []);

  return { band, onOpen, onDismiss };
}

function VoiceReadinessBand(): React.JSX.Element | null {
  const navigation = useNavigation<BandNavigation>();
  const { band, onOpen, onDismiss } = useVoiceReadiness(navigation);
  if (band == null) return null;

  const cta = band.state === 'not_consented' ? NOT_CONSENTED_CTA : GATHERING_CTA;

  // A plain container, not a pressable, so the inner "open" and "decline"
  // buttons stay independently reachable by assistive tech (a pressable wrapper
  // would collapse the subtree and hide the one-tap decline).
  return (
    <View style={styles.band}>
      <TouchableOpacity
        style={styles.openArea}
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={cta}
        testID="journal-voice-readiness-band"
      >
        <Text style={styles.label}>{BAND_LABEL}</Text>
        <Text style={styles.body}>{band.message}</Text>
        <Text style={styles.cta}>{cta}</Text>
      </TouchableOpacity>
      <ReflectionDismiss
        label={DISMISS_LABEL}
        accessibilityLabel={DISMISS_A11Y}
        testID="journal-voice-readiness-dismiss"
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
    // The same raised sheet and warm accent rule as the shelf's other bands,
    // so this reads as part of a matched set rather than an alert.
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
  },
  body: {
    ...editorialType.note,
    color: ink.soft,
    paddingTop: spacing(0.5),
  },
  cta: {
    // editorialType.action sits at the INTERACTIVE_TEXT_MIN floor, keeping
    // this tappable label legible without a bespoke size.
    ...editorialType.action,
    color: accent.primary,
    paddingTop: spacing(1),
  },
});

export default VoiceReadinessBand;
