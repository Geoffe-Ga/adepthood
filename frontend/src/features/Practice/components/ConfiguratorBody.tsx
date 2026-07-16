/**
 * ``ConfiguratorBody`` — the single mode→form dispatcher shared by every
 * place that edits a :data:`ModeConfig` (the create wizard and the ritual
 * configurator sheet).
 *
 * One ``MODE_FORMS`` table maps each ``ModeConfig['mode']`` to its per-mode
 * form component. Every form honours the same ``{ value, onChange }``
 * contract, so adding a new mode means editing this one table — not two
 * parallel dispatchers. When a mode has no form (a future/unknown
 * discriminator), the consumer's ``renderFallback`` decides what to show,
 * keeping each surface's own copy and testIDs.
 */

import type React from 'react';

import CardMeditationForm from '../configurator/forms/CardMeditationForm';
import CountUpForm from '../configurator/forms/CountUpForm';
import IntervalBellForm from '../configurator/forms/IntervalBellForm';
import MeditationTimerForm from '../configurator/forms/MeditationTimerForm';
import MetronomeForm from '../configurator/forms/MetronomeForm';
import MindfulAnchorForm from '../configurator/forms/MindfulAnchorForm';
import RandomIntervalBellForm from '../configurator/forms/RandomIntervalBellForm';
import RepCounterForm from '../configurator/forms/RepCounterForm';
import SenseGroundingForm from '../configurator/forms/SenseGroundingForm';
import TalliedGroundingForm from '../configurator/forms/TalliedGroundingForm';
import TarotForm from '../configurator/forms/TarotForm';
import type { ModeConfig } from '../engine/types';

type FormComponent<M extends ModeConfig['mode']> = React.ComponentType<{
  value: Extract<ModeConfig, { mode: M }>;
  onChange: (next: Extract<ModeConfig, { mode: M }>) => void;
}>;

type FormTable = { [K in ModeConfig['mode']]: FormComponent<K> };

/** The single source of truth mapping a mode to its configurator form. */
export const MODE_FORMS: FormTable = {
  meditation_timer: MeditationTimerForm,
  count_up: CountUpForm,
  metronome: MetronomeForm,
  interval_bell: IntervalBellForm,
  random_interval_bell: RandomIntervalBellForm,
  rep_counter: RepCounterForm,
  sense_grounding: SenseGroundingForm,
  tarot: TarotForm,
  card_meditation: CardMeditationForm,
  tallied_grounding: TalliedGroundingForm,
  mindful_anchor: MindfulAnchorForm,
};

export interface ConfiguratorBodyProps {
  config: ModeConfig;
  onChange: (next: ModeConfig) => void;
  /**
   * Rendered when ``config.mode`` has no form (an unknown discriminator).
   * Receives the raw mode string so the surface can name it in its own copy.
   */
  renderFallback: (mode: string) => React.JSX.Element;
}

type AnyForm = React.ComponentType<{
  value: ModeConfig;
  onChange: (next: ModeConfig) => void;
}>;

/** Dispatch ``config`` to its registered form, or the consumer's fallback. */
const ConfiguratorBody = ({
  config,
  onChange,
  renderFallback,
}: ConfiguratorBodyProps): React.JSX.Element => {
  const Form = MODE_FORMS[config.mode] as AnyForm | undefined;
  if (Form === undefined) {
    return renderFallback(config.mode);
  }
  return <Form value={config} onChange={onChange} />;
};

export default ConfiguratorBody;
