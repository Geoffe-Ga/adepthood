/**
 * Shared fixtures for the ``useResonance`` hook specs. The marginalia, care,
 * contraction, and resonance-payload factories were byte-near-identical across
 * ``useResonance``, ``useResonanceCare``, and ``useResonanceContraction`` — this
 * kit is their single source of truth. Each spec still owns its own ``@/api``
 * mock (jest hoisting keeps those per-file), but the payload shapes live here.
 */
import type {
  CareResponse,
  CompletionSuggestion,
  ContractionReflection,
  Marginalia,
  ResonanceResponse,
} from '@/api';

/** A single active theme note anchored at the head of the body. */
export function note(overrides: Partial<Marginalia> = {}): Marginalia {
  return {
    id: 1,
    journal_entry_id: 7,
    kind: 'theme',
    anchor_start: 0,
    anchor_end: 4,
    anchor_text: 'walk',
    note: 'A beginning.',
    essay: null,
    essay_generated_at: null,
    status: 'active',
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

/** A pending habit completion-suggestion anchored at the head of the body. */
export function suggestion(overrides: Partial<CompletionSuggestion> = {}): CompletionSuggestion {
  return {
    id: 1,
    journal_entry_id: 7,
    target_type: 'habit',
    goal_id: 3,
    user_practice_id: null,
    label: 'I ran',
    anchor_start: 0,
    anchor_end: 5,
    anchor_text: 'I ran',
    status: 'pending',
    accepted_at: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

/** A two-resource crisis-care payload. */
export function carePayload(overrides: Partial<CareResponse> = {}): CareResponse {
  return {
    message: 'What you shared sounds heavy. Here are some people who can help right now.',
    resources: [
      {
        kind: 'hotline',
        name: '988 Suicide & Crisis Lifeline',
        contact: '988',
        what_it_is: 'Free, confidential crisis support — call or text anytime.',
      },
      {
        kind: 'text_line',
        name: 'Crisis Text Line',
        contact: 'Text HOME to 741741',
        what_it_is: 'Text-based crisis counselling, 24/7.',
      },
    ],
    ...overrides,
  };
}

/** A gentle ease-off contraction reflection. */
export function contractionPayload(
  overrides: Partial<ContractionReflection> = {},
): ContractionReflection {
  return {
    variant: 'simple_ease_off',
    message: 'Your practice has eased off a little. No rush back.',
    ...overrides,
  };
}

/** A full resonance generate-pass response — empty by default, care/contraction null. */
export function resonancePayload(overrides: Partial<ResonanceResponse> = {}): ResonanceResponse {
  return {
    marginalia: [],
    suggestions: [],
    remaining_messages: 48,
    remaining_balance: 0,
    monthly_reset_date: '2026-07-01T00:00:00Z',
    care: null,
    contraction: null,
    ...overrides,
  };
}
