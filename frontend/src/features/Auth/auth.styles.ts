import { StyleSheet } from 'react-native';

import {
  SPACING,
  accent,
  colors,
  ink,
  onShowcase,
  surface,
  touchTarget,
  type as typeRamp,
} from '@/design/tokens';

// Cap the form width so fields don't stretch edge-to-edge on laptop/desktop
// browsers; on phones the screen is narrower so it has no effect.
const FORM_MAX_WIDTH = 480;

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
  // Field-scoped error, left-aligned under its input so the eye reads it as
  // belonging to that one field — unlike the centered form-level ``error``.
  fieldError: {
    color: colors.danger,
    textAlign: 'left',
    marginTop: SPACING.xs,
    marginBottom: SPACING.xs,
  },
  // "Where's my key?" — a quiet self-serve exit next to the license field.
  helpLink: { color: accent.primary, fontWeight: '500', marginBottom: SPACING.md },
  // Social sign-in, offered *under* the email form. A hairline rule with a
  // quiet "or" is the whole announcement: this is an alternative the user may
  // take, not a louder path competing with the primary one.
  socialSection: { marginTop: SPACING.md },
  dividerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.lg },
  dividerRule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: surface.hairline },
  dividerLabel: { color: ink.muted, marginHorizontal: SPACING.md },
  // Apple renders its own button, so all we own is the box it sits in: full
  // width like the Google button above it, and the shared 44dp floor that
  // matches ``Button.base.minHeight`` and clears Apple's HIG minimum.
  appleButton: { width: '100%', height: touchTarget.minimum, marginTop: SPACING.md },
  licenseStep: { marginTop: SPACING.lg },
  licenseStepLead: { color: ink.soft, marginBottom: SPACING.sm },
  link: { textAlign: 'center', color: ink.soft },
  linkBold: { color: accent.primary, fontWeight: '600' },
  forgotLink: {
    textAlign: 'center',
    color: accent.primary,
    fontWeight: '500',
    marginBottom: SPACING.md,
  },
  // Get Started (pre-auth) layout: a body paragraph under the lead, then the
  // terracotta callout band with breathing room before the quieter options.
  body: {
    ...TYPE.body,
    color: ink.soft,
    textAlign: 'center',
    marginBottom: SPACING.xl,
  },
  // Separates the loud terracotta band from the quieter options beneath it.
  ctaSpacing: { marginTop: SPACING.lg, marginBottom: SPACING.lg },
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
