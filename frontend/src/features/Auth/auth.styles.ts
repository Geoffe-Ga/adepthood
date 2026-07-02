import { StyleSheet } from 'react-native';

import {
  SPACING,
  accent,
  colors,
  ink,
  onShowcase,
  surface,
  type as typeRamp,
} from '@/design/tokens';

// Cap the form width so fields don't stretch edge-to-edge on laptop/desktop
// browsers; on phones the screen is narrower so it has no effect.
export const FORM_MAX_WIDTH = 480;

// The serif type ramp is responsive (scales with viewport width); the auth
// screens are full-bleed editorial covers, so resolve at the widest step so the
// wordmark + titles read with display weight on every device.
const TYPE = typeRamp(0);

/**
 * Shared styles for the auth screens (audit-ux-08, design-act2-10). Previously
 * each of the six screens defined its own near-identical container/input/button
 * sheet, so the same rules were copy-pasted and drifted independently; this is
 * the one source. The legacy grey card chrome is gone — the auth flow now lives
 * on the warm ``surface`` ground with a serif editorial voice.
 */
export const authStyles = StyleSheet.create({
  // Outer SafeAreaView wrapper for the full-screen auth screens.
  safeArea: { flex: 1, backgroundColor: surface.canvas },
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: SPACING.xl,
    backgroundColor: surface.canvas,
  },
  form: {
    width: '100%',
    maxWidth: FORM_MAX_WIDTH,
    alignSelf: 'center',
  },
  // Serif wordmark + program voice on the warm showcase hero shared by Login
  // and Signup — the branded editorial cover.
  brandBand: { marginBottom: SPACING.xxl },
  wordmark: {
    ...TYPE.display,
    color: onShowcase.primary,
    textAlign: 'center',
  },
  tagline: {
    ...TYPE.body,
    color: onShowcase.soft,
    textAlign: 'center',
    marginTop: SPACING.sm,
  },
  // Per-screen serif title + lead (Login → "Welcome back", Signup → "Begin").
  title: {
    ...TYPE.title,
    color: ink.primary,
    textAlign: 'center',
    marginBottom: SPACING.sm,
  },
  lead: {
    ...TYPE.body,
    color: ink.soft,
    textAlign: 'center',
    marginBottom: SPACING.xl,
  },
  subtitle: {
    ...TYPE.body,
    color: ink.soft,
    textAlign: 'center',
    marginBottom: SPACING.xl,
  },
  // Layout-only spacing for the warm `TextField`/`Button` primitives (#801),
  // which own their own ground/border/colour. Keeps field/button rhythm without
  // re-imposing the legacy grey chrome.
  inputSpacing: { marginBottom: SPACING.md },
  buttonSpacing: { marginBottom: SPACING.lg },
  error: { color: colors.danger, marginBottom: SPACING.md, textAlign: 'center' },
  link: { textAlign: 'center', color: ink.soft },
  linkBold: { color: accent.primary, fontWeight: '600' },
  forgotLink: {
    textAlign: 'center',
    color: accent.primary,
    fontWeight: '500',
    marginBottom: SPACING.md,
  },
  successTitle: {
    ...TYPE.title,
    color: ink.primary,
    textAlign: 'center',
    marginBottom: SPACING.md,
  },
  successBody: {
    ...TYPE.body,
    color: ink.soft,
    textAlign: 'center',
    marginBottom: SPACING.xl,
  },
});
